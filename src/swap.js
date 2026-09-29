/**
 * 一买一卖原语（借鉴 okx-bank-wap/scripts/web-swap.js）。
 *
 * 拆成 prepare / broadcast / await 三步，才能做 --fast 原子来回：
 *   prepareSwap   报价 → calldata 校验 → 余额/授权检查 → 自动补授权 → 链上模拟 → gas 估算
 *   broadcastSwap 签名 + 广播（可 noWait）
 *   awaitLeg      等回执 → 判定成败 → 读链上真实进出 + gas
 *   swapOnce      prepare + broadcast + await（普通单笔）
 *   roundtripFast 买/卖两份 calldata 备好，nonce=N/N+1 背靠背广播，敞口压到约 1 个区块
 *   roundtripNormal 买 → 等回执 → 按真实到账卖回
 *   approveOnly   一次性无限授权（幂等）
 *   sweepResidual 残留清零
 */
import { parseUnits, formatUnits, MaxUint256 } from 'ethers';
import { tagLine } from './pool.js';
import { chainInfo, nativeSymbol } from './chains.js';
import {
  pickRoute, routeInfo, fetchQuote, getNonce, getFees, feesFromQuote,
  signTx, sendRawTransaction, reportBroadcast, waitReceipt, rpc,
  getTokenMeta, getTokenBalance, getAllowance, transferDelta, decodeSwap,
} from './dex.js';

export const OKX_SPENDER_FALLBACK = '0x2c34A2Fb1d0b4f55de51E1d0bDEfaDDce6b7cDD6';
const RELAY_HEADERS = { origin: 'https://web3.okx.com', referer: 'https://web3.okx.com/' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(tagLine('[' + ts() + ']'), ...a);   // tagLine：并发时带 [n/N #idx]
const pad64 = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const toHexValue = (v) => {
  if (v == null || v === '') return '0x0';
  if (typeof v === 'string' && v.slice(0, 2).toLowerCase() === '0x') return v;
  try { return '0x' + BigInt(v).toString(16); } catch { return '0x0'; }
};

/** approve(spender, amount) 的 calldata */
export function encodeApprove(spender, amount) {
  return '0x095ea7b3' + pad64(spender) + BigInt(amount).toString(16).padStart(64, '0');
}

/** 授权额度是否已经「无限」（用阈值而不是 MaxUint256，花掉一点后就不再恰好相等） */
export function isUnlimited(alw) {
  if (alw == null) return false;
  const v = BigInt(alw);
  return v >= MaxUint256 / 2n || v >= 10n ** 30n;
}

// 探测用一个**不可能存在**的 hash：正常节点 eth_getTransactionReceipt 返回 null，
// 坏节点会报错（publicnode: "Archive requests require a personal token"）或直接返回 HTML。
const PROBE_HASH = '0x' + 'ab'.repeat(32);

/** 探测专用单次 JSON-RPC（短超时，不做重试） */
async function probeCall(url, method, params, timeoutMs = 5000) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const txt = await res.text();
  let j; try { j = JSON.parse(txt); } catch { throw new Error('非 JSON 响应（多半返回了 HTML）'); }
  if (j.error) throw new Error(j.error.message || 'JSON-RPC error');
  return j.result;
}

/**
 * 探一个节点：延迟（eth_blockNumber）+ **回执能力**（eth_getTransactionReceipt）。
 *
 * 只按延迟排序是个坑：base-rpc.publicnode.com 的 eth_call/gasPrice 都正常且最快，
 * 唯独取不到回执 —— 于是它被选为主节点，每笔授权都要空等一整个回执预算才超时。
 * 这里把两类探测并行跑，能力和延迟一起拿到。
 */
async function probeRpc(url) {
  const t0 = Date.now();
  const lp = probeCall(url, 'eth_blockNumber', []).then(
    (v) => ({ ok: !!v, ms: Date.now() - t0 }),
    (e) => ({ ok: false, ms: Date.now() - t0, err: e.message }),
  );
  const rp = probeCall(url, 'eth_getTransactionReceipt', [PROBE_HASH]).then(
    (v) => ({ ok: v === null || v === undefined, err: v == null ? '' : '返回了不该存在的回执' }),
    (e) => ({ ok: false, err: e.message }),
  );
  const [l, r] = await Promise.all([lp, rp]);
  return {
    url, ms: l.ms, up: l.ok, receipt: r.ok,
    err: l.ok ? (r.ok ? '' : '取不到回执：' + r.err) : ('节点不通：' + (l.err || '')),
  };
}

function deadProbe(url, e) {
  return { url, ms: 0, up: false, receipt: false, err: '节点不通：' + (e && e.message ? e.message : e) };
}

export async function resolveRpc({ chainId, rpcArg = '', onWarn } = {}) {
  const explicit = String(rpcArg || '').split(',').map((x) => x.trim()).filter(Boolean);
  const list = explicit.length ? explicit : chainInfo(chainId).rpc;
  if (!list.length) return { url: '', ranked: null };

  const probes = await Promise.all(list.map((u) => probeRpc(u).catch((e) => deadProbe(u, e))));
  const up = probes.filter((p) => p.up);

  // 用户显式只指了一个节点：尊重选择，不替换，但坏节点必须提示
  if (list.length === 1) {
    const p = probes[0];
    if (p && p.up && !p.receipt && onWarn) onWarn('RPC ' + p.url + ' ' + p.err + '，建议换节点（--rpc <url>）');
    if (p && !p.up && onWarn) onWarn('RPC ' + p.url + ' 连不上：' + p.err);
    return { url: list[0], ranked: probes, all: up.map((x) => x.url) };
  }
  if (!up.length) {
    if (onWarn) onWarn('RPC 池全部不可达，先拿 ' + list[0] + ' 硬试');
    return { url: list[0], ranked: null, all: [] };
  }
  if (up.length === 1) {
    const p = up[0];
    if (!p.receipt && onWarn) onWarn('池里只剩 ' + p.url + ' 可达，但它' + p.err);
    return { url: p.url, ranked: up, all: up.map((x) => x.url), picked: p.ms + 'ms' };
  }

  const capable = up.filter((p) => p.receipt).sort((a, b) => a.ms - b.ms);
  const broken = up.filter((p) => !p.receipt);
  if (broken.length && onWarn) for (const b of broken) onWarn('排除 RPC ' + b.url + '：' + b.err);
  if (!capable.length) {
    if (onWarn) onWarn('池里没有一个节点能取回执，仍按延迟选最快的（授权/回执很可能超时）');
    const ranked = up.slice().sort((a, b) => a.ms - b.ms);
    return { url: ranked[0].url, ranked, all: ranked.map((r) => r.url), picked: ranked[0].ms + 'ms' };
  }
  if (onWarn && capable[0].ms > 800) onWarn('RPC 池最快的 ' + capable[0].url + ' 要 ' + capable[0].ms + 'ms，建议换付费节点');
  return {
    url: capable[0].url,
    ranked: capable,
    all: capable.map((r) => r.url),
    picked: capable[0].ms + 'ms',
    excluded: broken.map((b) => b.url),
  };
}

/**
 * 报价 + 两道闸门（借鉴 okx-bank-wap fetchQuote）：
 *   滑点 > maxSlippage，或 |价差| > maxValueDiff → 不发这笔，重新报价，连续超限就抛错。
 * 出场腿（gate=false）不做闸门：币已经在手里，卖出去比拿到好价格重要。
 */
async function quoteGated(client, qArgs, { gate = false, maxSlippage = 0, maxValueDiff = 0, slippageManual = false, tries = 3, onWarn } = {}) {
  let lastMsg = '';
  for (let attempt = 1; ; attempt++) {
    const q = await fetchQuote(client, qArgs);
    const route = pickRoute(q.data);
    if (!route) throw new Error('报价里没有任何可用路由');
    const slip = Number(route.slippage);
    const diff = Math.abs(Number(route.diffPercent));
    const badSlip = gate && !slippageManual && maxSlippage > 0 && Number.isFinite(slip) && slip > maxSlippage;
    const badDiff = gate && maxValueDiff > 0 && Number.isFinite(diff) && diff > maxValueDiff;
    if (!badSlip && !badDiff) return { q, route };
    const why = [
      badSlip ? '滑点 ' + (slip * 100).toFixed(2) + '% > ' + (maxSlippage * 100).toFixed(2) + '%' : '',
      badDiff ? '价差 ' + (diff * 100).toFixed(3) + '% > ' + (maxValueDiff * 100).toFixed(3) + '%' : '',
    ].filter(Boolean).join('，');
    lastMsg = why;
    if (attempt >= tries) throw new Error(why + '，连续 ' + attempt + ' 次超限，本钱包本轮不交易（放宽就改 MAX_SLIPPAGE / MAX_VALUE_DIFF）');
    if (onWarn) onWarn(why + '，重新报价 ' + attempt + '/' + tries + '…');
    await sleep(800);
  }
}

/**
 * 准备一笔交易（不广播）。返回 prep（.ok=true）或失败对象（.ok=false, .stage, .msg）。
 */
export async function prepareSwap(args, opts = {}) {
  const {
    client, wallet, chainId, rpcUrl, fromToken, toToken,
    accountId, refCode, slippage = '', onWarn, label = '',
  } = args;
  const address = wallet.address.toLowerCase();
  const tag = (label ? '[' + label + '] ' : '') + address.slice(0, 6) + '…' + address.slice(-4);
  const t0 = Date.now();
  const base = { label, address, ok: false, stage: 'quote', msg: '', seconds: 0 };
  const fail = (stage, msg) => {
    base.stage = stage; if (msg) base.msg = msg;
    base.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (msg) log(tag + ' ❌ ' + stage + '：' + msg);
    return base;
  };

  try {
    const fromMeta = await getTokenMeta(rpcUrl, fromToken);
    const toMeta = await getTokenMeta(rpcUrl, toToken);
    base.fromToken = fromToken; base.toToken = toToken;
    base.fromMeta = fromMeta; base.toMeta = toMeta;

    let amount = String(args.amount);
    if (amount.toLowerCase() === 'all') {
      const bal0 = await getTokenBalance(rpcUrl, fromToken, address);
      if (bal0 === 0n) return fail('preflight', '余额为 0，无需交换');
      amount = formatUnits(bal0, fromMeta.decimals);
    }
    base.amount = amount;
    log(tag + ' 开始 ' + amount + ' ' + fromMeta.symbol + ' → ' + toMeta.symbol);

    const { q, route } = await quoteGated(client, {
      chainId, fromToken, toToken, amount, walletAddress: address, accountId, refCode, slippage, apiTries: args.apiTries, onWarn,
    }, {
      gate: opts.gate, maxSlippage: opts.maxSlippage, maxValueDiff: opts.maxValueDiff,
      slippageManual: Boolean(slippage), tries: opts.gateRetries || 3, onWarn,
    });
    base.q = q; base.route = route; base.traceLogId = q.traceLogId;
    base.receiveAmount = route.receiveAmount;
    base.minimumReceived = route.minimumReceived;
    base.slippage = route.slippage;
    base.diffPercent = route.diffPercent != null ? Number(route.diffPercent) : null;
    log(tag + ' ① 报价 ' + route.receiveAmount + ' ' + toMeta.symbol + '（最少 ' + route.minimumReceived + '）  滑点 '
      + (Number(route.slippage) * 100).toFixed(2) + '%  价差 '
      + (Number.isFinite(Number(route.diffPercent)) ? (Number(route.diffPercent) * 100).toFixed(3) + '%' : '—')
      + '  平台 ' + route.defiPlatformId);

    const info = routeInfo(route);
    if (!info.tx || !info.tx.to || !info.tx.data || info.tx.data === '0x') return fail('quote', '交易缺少 to/data');
    base.info = info; base.orderId = info.orderId; base.callData = info.callData;
    log(tag + ' ② calldata to=' + info.tx.to + '  selector=' + String(info.tx.data).slice(0, 10) + '  orderId=' + (info.orderId || ''));

    try {
      const dec = decodeSwap(info.tx.data);
      if (dec) {
        base.dec = dec;
        if (dec.recipient && dec.recipient.toLowerCase() !== address) {
          return fail('validate', 'calldata 收款人 ' + dec.recipient + ' 不是本钱包 ' + address);
        }
        if (dec.outputToken.toLowerCase() !== String(toToken).toLowerCase()) {
          return fail('validate', 'calldata 输出币 ' + dec.outputToken + ' 与目标不一致');
        }
        const dl = Number(dec.deadline);
        if (dl && dl < Math.floor(Date.now() / 1000) + 15) {
          return fail('validate', 'calldata deadline 已过期或快到了（' + new Date(dl * 1000).toLocaleString() + '）');
        }
      }
    } catch (e) {
      if (onWarn) onWarn(address + ' calldata 解析失败（忽略）：' + e.message);
    }
    if (base.dec) {
      log(tag + '    收款人 ' + base.dec.recipient + '  输出 ' + String(base.dec.outputToken).slice(0, 10) + '…'
        + '  最小得到 ' + base.dec.minReturn + '  deadline ' + new Date(Number(base.dec.deadline) * 1000).toLocaleString());
    }

    const need = parseUnits(amount, fromMeta.decimals);
    base.needRaw = need.toString();

    if (!opts.skipBalance) {
      let bal = null;
      try { bal = await getTokenBalance(rpcUrl, fromToken, address); }
      catch (e) { if (onWarn) onWarn(address + ' 读余额失败：' + e.message); }
      base.balance = bal == null ? null : formatUnits(bal, fromMeta.decimals);
      log(tag + '    余额 ' + (base.balance == null ? '读取失败' : base.balance) + ' ' + fromMeta.symbol + '（本轮需要 ' + amount + '）');
      if (bal != null && bal < need) {
        const m = '余额不足：需要 ' + amount + ' ' + fromMeta.symbol + '，只有 ' + formatUnits(bal, fromMeta.decimals);
        if (args.doExecute) return fail('preflight', m);
        if (onWarn) onWarn(m + '（干跑仅提示）');
      }
    }

    const spender = (info.approveTxInfo && info.approveTxInfo.dexContractAddress) || OKX_SPENDER_FALLBACK;
    base.spender = spender;
    if (!opts.skipAllowance) {
      let alw = null;
      try { alw = await getAllowance(rpcUrl, fromToken, address, spender); }
      catch (e) { if (onWarn) onWarn(address + ' 读授权失败：' + e.message); }
      base.allowance = alw == null ? null : alw.toString();
      log(tag + '    授权 ' + (alw == null ? '未知' : (isUnlimited(alw) ? '∞（已无限）' : formatUnits(alw, fromMeta.decimals)))
        + ' ' + fromMeta.symbol + ' → ' + spender.slice(0, 10) + '…');
      const needApprove = alw == null ? !opts.noApprove : alw < need;
      base.approveNeeded = needApprove;
      if (needApprove && args.doExecute) {
        if (opts.noApprove) return fail('approve', '授权不足，且指定了 no-approve');
        const at = info.approveTxInfo || null;
        const approveTo = (at && at.to) || fromToken;
        const approveData = (at && at.data) || encodeApprove(spender, MaxUint256);
        log(tag + ' ⚿ 授权不足，先补一笔 approve(' + spender.slice(0, 10) + '…)');
        const fees0 = feesFromQuote(q.data) || await getFees(rpcUrl);
        const nonce0 = await getNonce(rpcUrl, address);
        const signedA = await signTx(wallet, { to: approveTo, data: approveData, value: (at && at.value) || '0' }, {
          chainId,
          // 用链上 pending nonce。报价里的 at.nonce 可能是过期的，照抄会签出一笔永远无效的交易
          nonce: nonce0,
          gasLimit: at && at.gas && BigInt(at.gas) > 120000n ? BigInt(at.gas) : 120000n,
          maxFeePerGas: (at && at.maxFeePerGas) ? BigInt(at.maxFeePerGas) : fees0.maxFeePerGas,
          maxPriorityFeePerGas: (at && at.maxPriorityFeePerGas) ? BigInt(at.maxPriorityFeePerGas) : fees0.maxPriorityFeePerGas,
        });
        const ah = await sendRawTransaction(rpcUrl, signedA.raw, RELAY_HEADERS);
        base.approveTx = ah;
        log(tag + ' ⛓ 授权已广播 ' + String(ah).slice(0, 14) + '…  nonce=' + nonce0 + '，等确认');
        const arc = await waitReceipt(rpcUrl, ah);
        if (!arc || String(arc.status) !== '0x1') {
          // Base 拥堵时回执可能比预算晚到。只要链上授权已经生效，就没必要把整个钱包判失败。
          const after = await getAllowance(rpcUrl, fromToken, address, spender).catch(() => null);
          if (after != null && after >= need) {
            log(tag + ' ⚿ 没等到回执，但链上授权已生效，继续交易');
          } else {
            return fail('approve', '授权未成功（' + (arc ? 'status=' + arc.status : '等回执超时') + '）txHash=' + ah + '，可稍后单独跑 --approve-only 复查');
          }
        } else {
          log(tag + ' ✅ 授权已确认 ' + String(ah).slice(0, 14) + '…');
        }
      }
    }

    if (!args.doExecute) {
      base.ok = true; base.stage = 'dry';
      log(tag + ' 干跑：只报价，不签名、不上链');
      base.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
      return base;
    }

    if (!opts.skipSimulate) {
      try {
        await rpc(rpcUrl, 'eth_call', [{ from: address, to: info.tx.to, data: info.tx.data, value: toHexValue(info.tx.value) }, 'latest']);
      } catch (e) {
        return fail('simulate', '链上模拟失败，拒绝广播：' + String(e.message).slice(0, 140));
      }
      log(tag + ' ③ 链上模拟通过');
    }

    let fees = feesFromQuote(q.data);
    if (!fees) fees = await getFees(rpcUrl);
    let gasLimit = route.estimateGasFee ? BigInt(route.estimateGasFee) : 0n;
    if (opts.skipEstimate) {
      // 原子来回的卖单此时手里还没币，estimateGas 必失败；直接用接口值 × 1.5（借鉴 bank-wap）
      gasLimit = (gasLimit * 150n) / 100n;
    } else {
      try {
        const est = BigInt(await rpc(rpcUrl, 'eth_estimateGas', [{ from: address, to: info.tx.to, data: info.tx.data, value: toHexValue(info.tx.value) }]));
        const withMargin = (est * 12n) / 10n;
        if (withMargin > gasLimit) gasLimit = withMargin;
        base.gasEstimated = est.toString();
      } catch (e) {
        const bumped = (gasLimit * 150n) / 100n;
        if (bumped > gasLimit) gasLimit = bumped;
        if (onWarn) onWarn(address + ' estimateGas 失败（' + String(e.message).slice(0, 70) + '），gas 放大 1.5 倍');
      }
    }
    if (gasLimit < 300000n) gasLimit = 300000n;
    log(tag + ' ④ gasLimit ' + gasLimit.toString() + (base.gasEstimated ? '（estimate ' + base.gasEstimated + '）' : (opts.skipEstimate ? '（接口×1.5）' : ''))
      + '  maxFee ' + Number(formatUnits(fees.maxFeePerGas, 9)).toFixed(4) + ' gwei');

    const providers = info.broadcastProvider || [];
    const relay = providers.find ? providers.find((p) => p && p.url && p.url.length) : null;

    base.ok = true;
    base.stage = 'prepared';
    base.fees = fees;
    base.gasLimit = gasLimit.toString();
    base.tx = info.tx;
    base.relayUrl = relay ? (relay.url || [])[0] || '' : '';
    base.broadcastName = (relay && relay.name) || 'RPC';
    base.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    return base;
  } catch (e) {
    return fail('error', e.message);
  }
}

/** 签名 + 广播（可 noWait）。返回 leg（.txHash, .pending）。 */
export async function broadcastSwap(prep, { wallet, client, chainId, rpcUrl, broadcastUrl, accountId, nonce, noWait = false, onWarn }) {
  const targets = [];
  for (const u of [prep.relayUrl, broadcastUrl, rpcUrl]) if (u && targets.indexOf(u) < 0) targets.push(u);
  async function send(raw) {
    let lastErr;
    for (const url of targets) {
      try { return await sendRawTransaction(url, raw, RELAY_HEADERS); }
      catch (e) { lastErr = e; if (onWarn) onWarn(prep.address + ' 广播到 ' + url + ' 失败：' + e.message); }
    }
    throw lastErr || new Error('广播失败');
  }
  const signed = await signTx(wallet, prep.tx, {
    chainId, nonce, gasLimit: BigInt(prep.gasLimit),
    maxFeePerGas: prep.fees.maxFeePerGas, maxPriorityFeePerGas: prep.fees.maxPriorityFeePerGas,
  });
  const sent = await send(signed.raw);
  const leg = Object.assign({}, prep, { txHash: sent || signed.txHash, pending: !!noWait, chainId });
  log('[' + (prep.label || '') + '] ' + prep.address.slice(0, 6) + '…' + prep.address.slice(-4)
    + ' ⛓ 已广播 ' + String(leg.txHash).slice(0, 14) + '…  nonce=' + nonce + '  gasLimit=' + prep.gasLimit + (noWait ? '（不等确认）' : ''));
  try {
    await reportBroadcast(client, {
      traceLogId: prep.traceLogId, walletId: accountId, userWalletAddress: prep.address, chainId,
      nonce, orderId: prep.orderId, raw: signed.raw, txHash: leg.txHash, callData: prep.callData,
      clientBroadcast: prep.broadcastName, onWarn,
    });
  } catch (e) { if (onWarn) onWarn(prep.address + ' 回报 OKX 失败（交易已上链）：' + e.message); }
  return leg;
}

/** 等回执 → 判成败 → 读链上真实进出 + gas。就地丰富 leg 并返回。 */
export async function awaitLeg(leg, { rpcUrl, onWarn } = {}) {
  const atag = '[' + (leg.label || '') + '] ' + leg.address.slice(0, 6) + '…' + leg.address.slice(-4);
  const rec = await waitReceipt(rpcUrl, leg.txHash);
  leg.receipt = rec;
  if (!rec) { leg.ok = false; leg.stage = 'pending'; leg.msg = '交易已广播但未拿到回执（txHash=' + leg.txHash + '）'; log(atag + ' ⏳ ' + leg.msg); return leg; }
  if (String(rec.status) !== '0x1') { leg.ok = false; leg.stage = 'reverted'; leg.msg = '交易上链失败（receipt.status=' + rec.status + '）txHash=' + leg.txHash; log(atag + ' ❌ ' + leg.msg); return leg; }
  try {
    const dFrom = transferDelta(rec, leg.fromToken, leg.address);
    const dTo = transferDelta(rec, leg.toToken, leg.address);
    if (dFrom) { leg.spentRaw = dFrom.out.toString(); leg.spentHuman = formatUnits(dFrom.out, leg.fromMeta.decimals); }
    if (dTo) { leg.receivedRaw = dTo.in.toString(); leg.receivedHuman = formatUnits(dTo.in, leg.toMeta.decimals); }
  } catch (e) { if (onWarn) onWarn(leg.address + ' 读链上成交失败：' + e.message); }
  try {
    const eff = rec.effectiveGasPrice ? BigInt(rec.effectiveGasPrice) : (rec.gasPrice ? BigInt(rec.gasPrice) : 0n);
    leg.gasWei = (BigInt(rec.gasUsed) * eff).toString();
    leg.gasBnb = formatUnits(BigInt(rec.gasUsed) * eff, 18);
  } catch { /* ignore */ }
  log(atag + ' ✅ 上链成功 区块 ' + Number(BigInt(rec.blockNumber)) + '  gasUsed ' + Number(BigInt(rec.gasUsed))
    + (leg.spentHuman != null ? '  卖出 ' + leg.spentHuman + ' ' + leg.fromMeta.symbol : '')
    + (leg.receivedHuman != null ? '  到账 ' + leg.receivedHuman + ' ' + leg.toMeta.symbol : '')
    + (leg.gasBnb != null ? '  gas ' + leg.gasBnb + ' ' + nativeSymbol(leg.chainId) : ''));
  leg.ok = true; leg.stage = 'done';
  return leg;
}

/** 普通单笔：准备 → 签名广播 → 等回执。 */
export async function swapOnce(args, opts = {}) {
  const prep = await prepareSwap(args, opts);
  if (!prep.ok || !args.doExecute) return prep;
  const nonce = await getNonce(args.rpcUrl, prep.address);
  const leg = await broadcastSwap(prep, Object.assign({}, args, { nonce }));
  return awaitLeg(leg, { rpcUrl: args.rpcUrl, onWarn: args.onWarn });
}

/** 买腿重试：revert 不建仓，重试安全；每次全新报价 */
export async function retryBuy(args, opts = {}) {
  const retries = opts.retries || 3;
  let last = null;
  for (let i = 1; i <= retries; i++) {
    last = await swapOnce(args, opts);
    if (last.ok) return last;
    if (last.stage === 'preflight' || last.stage === 'validate') return last;
    if (i < retries) {
      if (args.onWarn) args.onWarn('买腿失败（' + i + '/' + retries + '）：' + last.msg + '，重新报价再试');
      await sleep(1500 * i);
    }
  }
  return last;
}

/** 卖回：买腿已成交，卖不出去就是裸敞口，尽力卖出去（滑点逐级放宽，按全部余额卖） */
export async function sellBack(args, { ladder = [null], retries = 3, onWarn } = {}) {
  let last = null;
  for (let i = 1; i <= retries; i++) {
    const rung = ladder[Math.min(i - 1, ladder.length - 1)];
    const slip = rung == null ? '' : String(rung);
    const useAmount = args.doExecute ? 'all' : args.amount;
    if (i > 1 && onWarn) onWarn('补卖第 ' + (i - 1) + ' 次：滑点 ' + (rung == null ? '自动' : (rung * 100).toFixed(2) + '%') + '，按链上全部余额卖');
    last = await swapOnce(Object.assign({}, args, { amount: useAmount, slippage: slip }), { gate: false, skipBalance: !args.doExecute });
    if (last.ok) return last;
    if (i < retries) await sleep(1200 * i);
  }
  return last;
}

/**
 * 扫残留：读链上真实余额全部卖回。
 *
 * 这里卖的是一笔**已经结束的交易剩下的零头**（--fast 只卖 minReturn，差额留在钱包里），
 * 它紧跟在卖腿后面，池子刚被自己砸过、还没回稳，所以 revert 多半是 "Min return not reached"。
 * 因此失败必须**换更宽的滑点重试**，而不是直接放弃 —— 残留是裸敞口，比多付一点滑点糟糕得多。
 * 滑点阶梯：自动 → 3% → 6%（零头金额很小，6% 也就几厘钱）。
 */
export async function sweepResidual({ fromToken, toToken, minToken = 0, rounds = 2, slippage = null, onWarn, ...args }) {
  const meta = await getTokenMeta(args.rpcUrl, fromToken);
  const address = args.wallet.address.toLowerCase();
  const ladder = (slippage == null || slippage === '')
    ? [null, 0.03, 0.06]
    : [slippage, Math.max(0.03, Number(slippage) * 2), 0.06];
  let lastHash = '';
  let gasBnb = 0;
  let receivedUsdt = 0;
  let lastHuman = '0';
  let lastMsg = '';
  for (let i = 1; i <= rounds; i++) {
    let bal;
    try { bal = await getTokenBalance(args.rpcUrl, fromToken, address); }
    catch (e) { return { ok: false, residual: null, hash: lastHash, gasBnb: gasBnb, receivedUsdt: receivedUsdt, msg: '读残留失败：' + e.message }; }
    if (bal === 0n) return { ok: true, residual: '0', hash: lastHash, gasBnb: gasBnb, receivedUsdt: receivedUsdt, rounds: i - 1 };
    const human = formatUnits(bal, meta.decimals);
    lastHuman = human;
    if (minToken > 0 && Number(human) < minToken) {
      return { ok: true, residual: human, hash: lastHash, gasBnb: gasBnb, receivedUsdt: receivedUsdt, rounds: i - 1, skipped: true };
    }
    // 同一轮内先按阶梯放宽滑点重试；一轮里有一次成功就进入下一轮复核余额
    let done = false;
    for (let a = 0; a < ladder.length; a++) {
      const rung = ladder[a];
      if (onWarn) {
        onWarn('扫残留第 ' + i + ' 轮：' + human + ' ' + meta.symbol
          + (a > 0 ? '（第 ' + (a + 1) + '/' + ladder.length + ' 次尝试，滑点 ' + (rung == null ? '自动' : (rung * 100).toFixed(2) + '%') + '）' : ''));
      }
      const r = await swapOnce(Object.assign({}, args, {
        fromToken, toToken, amount: 'all', label: '扫残留',
        slippage: rung == null ? '' : String(rung),
      }), { gate: false });
      if (r.txHash) lastHash = r.txHash;
      gasBnb += Number(r.gasBnb || 0);
      if (r.receivedHuman != null) receivedUsdt += Number(r.receivedHuman);
      if (r.ok) { done = true; break; }
      lastMsg = r.msg || '扫残留失败';
      if (a < ladder.length - 1) await sleep(900);
    }
    if (!done) return { ok: false, residual: lastHuman, hash: lastHash, gasBnb: gasBnb, receivedUsdt: receivedUsdt, rounds: i, msg: lastMsg };
  }
  let bal = 0n;
  try { bal = await getTokenBalance(args.rpcUrl, fromToken, address); } catch { /* ignore */ }
  return { ok: true, residual: formatUnits(bal, meta.decimals), hash: lastHash, gasBnb: gasBnb, receivedUsdt: receivedUsdt, rounds: rounds };
}

/** 一次性无限授权（幂等）：先借一笔报价拿官方 approveTxInfo，再按真实 spender 授权 */
export async function approveOnly(args, { onWarn } = {}) {
  const { client, wallet, chainId, rpcUrl, token, otherToken, accountId, refCode, doExecute } = args;
  const address = wallet.address.toLowerCase();
  try {
    const meta = await getTokenMeta(rpcUrl, token);
    const q = await fetchQuote(client, {
      chainId, fromToken: token, toToken: otherToken, amount: '1',
      walletAddress: address, accountId, refCode, slippage: '', onWarn,
    });
    const route = pickRoute(q.data);
    if (!route) return { ok: false, msg: '拿不到报价，无法确定 spender' };
    const info = routeInfo(route);
    const at = info.approveTxInfo || null;
    const spender = (at && at.dexContractAddress) || OKX_SPENDER_FALLBACK;
    const alw = await getAllowance(rpcUrl, token, address, spender).catch(() => 0n);
    if (isUnlimited(alw)) return { ok: true, symbol: meta.symbol, alreadyMax: true, spender: spender };
    if (!doExecute) return { ok: true, symbol: meta.symbol, dry: true, spender: spender, allowance: alw.toString() };
    const approveTo = (at && at.to) || token;
    const approveData = (at && at.data) || encodeApprove(spender, MaxUint256);
    const fees = feesFromQuote(q.data) || await getFees(rpcUrl);
    const nonce = await getNonce(rpcUrl, address);
    const signed = await signTx(wallet, { to: approveTo, data: approveData, value: (at && at.value) || '0' }, {
      chainId, nonce,
      gasLimit: at && at.gas && BigInt(at.gas) > 120000n ? BigInt(at.gas) : 120000n,
      maxFeePerGas: (at && at.maxFeePerGas) ? BigInt(at.maxFeePerGas) : fees.maxFeePerGas,
      maxPriorityFeePerGas: (at && at.maxPriorityFeePerGas) ? BigInt(at.maxPriorityFeePerGas) : fees.maxPriorityFeePerGas,
    });
    const h = await sendRawTransaction(rpcUrl, signed.raw, RELAY_HEADERS);
    const rec = await waitReceipt(rpcUrl, h);
    if (!rec || String(rec.status) !== '0x1') {
      const after = await getAllowance(rpcUrl, token, address, spender).catch(() => null);
      if (after != null && isUnlimited(after)) return { ok: true, symbol: meta.symbol, hash: h, spender: spender, lateReceipt: true };
      return { ok: false, symbol: meta.symbol, msg: '授权上链失败（' + (rec ? rec.status : '超时') + '）', hash: h };
    }
    return { ok: true, symbol: meta.symbol, hash: h, spender: spender };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/**
 * 批量授权（--approve-only 用）：**一把钱包的多个代币背靠背广播**（nonce N/N+1/…），最后一起等回执。
 *
 * 为什么不能一笔一笔来：Base 出块 ~2s，拥堵时确认更久。「发一笔 → 等回执 → 再发下一笔」
 * 把等待时间线性叠加；背靠背广播让两笔共享同一个等待窗口。10 把钱包 × 2 个代币，
 * 从 20 个等待窗口压到 10 个。
 *
 * 返回 per-token 结果数组：{ ok, symbol, hash?, spender?, alreadyMax?/dry?/lateReceipt?, msg? }
 */
export async function approveBatch(args, { onWarn } = {}) {
  const { client, wallet, chainId, rpcUrl, tokens = [], otherTokenOf, accountId, refCode, doExecute } = args;
  const address = wallet.address.toLowerCase();
  const results = [];
  const plans = [];

  // ── 1) 每个代币：报价拿真实 spender → 查链上授权 → 只有确实不足才排进广播队列 ──
  for (const token of tokens) {
    let meta = { symbol: '?', decimals: 18 };
    try { meta = await getTokenMeta(rpcUrl, token); } catch { /* 读不到就用默认 */ }
    try {
      const q = await fetchQuote(client, {
        chainId, fromToken: token, toToken: otherTokenOf(token), amount: '1',
        walletAddress: address, accountId, refCode, slippage: '', onWarn,
      });
      const route = pickRoute(q.data);
      if (!route) { results.push({ ok: false, symbol: meta.symbol, msg: '拿不到报价，无法确定 spender' }); continue; }
      const at = routeInfo(route).approveTxInfo || null;
      const spender = (at && at.dexContractAddress) || OKX_SPENDER_FALLBACK;
      const alw = await getAllowance(rpcUrl, token, address, spender).catch(() => 0n);
      if (isUnlimited(alw)) { results.push({ ok: true, symbol: meta.symbol, alreadyMax: true, spender: spender }); continue; }
      if (!doExecute) { results.push({ ok: true, symbol: meta.symbol, dry: true, spender: spender, allowance: alw.toString() }); continue; }
      plans.push({ token: token, meta: meta, at: at, spender: spender, q: q });
    } catch (e) {
      results.push({ ok: false, symbol: meta.symbol, msg: e.message });
    }
  }
  if (!plans.length) return results;

  // ── 2) 背靠背签名 + 广播：中间不 await 回执，nonce 只在本地推进 ──
  let nonce = await getNonce(rpcUrl, address);
  const sent = [];
  for (const p of plans) {
    try {
      const at = p.at;
      const fees = feesFromQuote(p.q.data) || await getFees(rpcUrl);
      const signed = await signTx(wallet, {
        to: (at && at.to) || p.token,
        data: (at && at.data) || encodeApprove(p.spender, MaxUint256),
        value: (at && at.value) || '0',
      }, {
        chainId, nonce,
        gasLimit: at && at.gas && BigInt(at.gas) > 120000n ? BigInt(at.gas) : 120000n,
        maxFeePerGas: (at && at.maxFeePerGas) ? BigInt(at.maxFeePerGas) : fees.maxFeePerGas,
        maxPriorityFeePerGas: (at && at.maxPriorityFeePerGas) ? BigInt(at.maxPriorityFeePerGas) : fees.maxPriorityFeePerGas,
      });
      const h = await sendRawTransaction(rpcUrl, signed.raw, RELAY_HEADERS);
      sent.push(Object.assign({ hash: h, nonce: nonce }, p));
      nonce++;
    } catch (e) {
      results.push({ ok: false, symbol: p.meta.symbol, msg: '签名/广播失败：' + e.message });
    }
  }

  // ── 3) 并发等回执；等不到就回查链上授权（回执晚到 ≠ 失败）──
  const receipts = await Promise.all(sent.map((s) => waitReceipt(rpcUrl, s.hash).catch(() => null)));
  for (let i = 0; i < sent.length; i++) {
    const s = sent[i];
    const rec = receipts[i];
    if (rec && String(rec.status) === '0x1') { results.push({ ok: true, symbol: s.meta.symbol, hash: s.hash, spender: s.spender }); continue; }
    const after = await getAllowance(rpcUrl, s.token, address, s.spender).catch(() => null);
    if (after != null && isUnlimited(after)) { results.push({ ok: true, symbol: s.meta.symbol, hash: s.hash, spender: s.spender, lateReceipt: true }); continue; }
    results.push({ ok: false, symbol: s.meta.symbol, hash: s.hash, msg: rec ? '授权回执 status=' + rec.status : '等回执超时' });
  }
  return results;
}

/** 普通来回：买 → 等回执 → 按真实到账卖回 */
export async function roundtripNormal(args, opts = {}) {
  const { fromToken, toToken } = args;
  const buy = await retryBuy(Object.assign({}, args, { fromToken: fromToken, toToken: toToken, label: '买' }),
    { gate: true, maxSlippage: opts.maxSlippage, maxValueDiff: opts.maxValueDiff, gateRetries: opts.gateRetries, retries: opts.buyRetries });
  if (!buy.ok) return { ok: false, stage: 'buy', msg: buy.msg, buy: buy };
  log('买腿完成，接着按链上真实到账卖回 ' + String(toToken).slice(0, 10) + '… → ' + String(fromToken).slice(0, 10) + '…');
  const sellAmount = buy.receivedHuman != null ? buy.receivedHuman : (buy.receiveAmount || 'all');
  const sell = await sellBack(Object.assign({}, args, { fromToken: toToken, toToken: fromToken, amount: sellAmount, label: '卖' }),
    { ladder: opts.ladder, retries: opts.sellRetries });
  if (!sell.ok) return { ok: false, stage: 'sell', msg: sell.msg, buy: buy, sell: sell, positionOpen: true };
  return { ok: true, buy: buy, sell: sell };
}

/**
 * 原子来回（--fast）：买/卖两份 calldata 先备好，nonce=N/N+1 背靠背广播。
 * 敞口从「等买单确认 + 卖单准备 ≈ 6~10s」压到「1 个区块 ≈ 0~3s」。
 * 卖单数量用买单的 minReturn（合约保证实际到账 ≥ minReturn，卖单必定能成交）。
 */
export async function roundtripFast(args, opts = {}) {
  const { fromToken, toToken, doExecute, onWarn } = args;
  const retries = opts.buyRetries || 3;
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const buyPrep = await prepareSwap(Object.assign({}, args, { fromToken: fromToken, toToken: toToken, label: '买' }),
      { gate: true, maxSlippage: opts.maxSlippage, maxValueDiff: opts.maxValueDiff, gateRetries: opts.gateRetries, noApprove: opts.noApprove });
    if (!buyPrep.ok) {
      last = { ok: false, stage: buyPrep.stage, msg: buyPrep.msg, buy: buyPrep };
      if (buyPrep.stage === 'preflight' || buyPrep.stage === 'validate') return last;
      if (attempt < retries) { if (onWarn) onWarn('买腿报价失败（' + attempt + '/' + retries + '）：' + buyPrep.msg); await sleep(1500 * attempt); continue; }
      return last;
    }
    if (!doExecute) return { ok: true, dry: true, fast: true, buy: buyPrep, sell: null };

    const minReturn = buyPrep.dec && buyPrep.dec.minReturn ? buyPrep.dec.minReturn : null;
    if (!minReturn || minReturn <= 0n) return { ok: false, stage: 'fast', msg: '拿不到 minReturn，无法先发卖单（去掉 --fast 用普通模式）', buy: buyPrep };
    const sellAmount = formatUnits(minReturn, buyPrep.toMeta.decimals);
    const rung = (opts.ladder && opts.ladder[0] != null) ? String(opts.ladder[0]) : '';
    const sellPrep = await prepareSwap(Object.assign({}, args, {
      fromToken: toToken, toToken: fromToken, amount: sellAmount, slippage: rung, label: '卖',
    }), { gate: false, skipBalance: true, skipSimulate: true, skipEstimate: true, noApprove: opts.noApprove });
    if (!sellPrep.ok) {
      last = { ok: false, stage: 'sellPrepare', msg: sellPrep.msg, buy: buyPrep, sell: sellPrep };
      if (attempt < retries) { if (onWarn) onWarn('卖腿准备失败（' + attempt + '/' + retries + '）：' + sellPrep.msg); await sleep(1500 * attempt); continue; }
      return last;
    }

    log('⚡ 原子来回：买/卖两份 calldata 已备好，背靠背广播…');
    const nonce = await getNonce(args.rpcUrl, buyPrep.address);
    let buyLeg, sellLeg;
    try {
      const t0 = Date.now();
      buyLeg = await broadcastSwap(buyPrep, Object.assign({}, args, { nonce: nonce, noWait: true }));
      sellLeg = await broadcastSwap(sellPrep, Object.assign({}, args, { nonce: nonce + 1, noWait: true }));
      log('  ⚡ 买/卖两笔间隔 ' + (Date.now() - t0) + 'ms（nonce ' + nonce + '/' + (nonce + 1) + '，敞口 ≈ 1 个区块）');
    } catch (e) {
      last = { ok: false, stage: 'broadcast', msg: e.message, buy: buyPrep };
      if (attempt < retries) { if (onWarn) onWarn('背靠背广播失败（' + attempt + '/' + retries + '）：' + e.message); await sleep(1500 * attempt); continue; }
      return last;
    }

    await awaitLeg(buyLeg, { rpcUrl: args.rpcUrl, onWarn: onWarn });
    if (!buyLeg.ok) {
      await awaitLeg(sellLeg, { rpcUrl: args.rpcUrl, onWarn: onWarn });   // 手里没币，卖单必然 revert，一起收掉
      last = { ok: false, stage: 'buyReverted', msg: buyLeg.msg, buy: buyLeg, sell: sellLeg };
      if (attempt < retries) { if (onWarn) onWarn('买腿上链失败（' + attempt + '/' + retries + '），整对重来（revert 不建仓）'); await sleep(1500 * attempt); continue; }
      return last;
    }

    await awaitLeg(sellLeg, { rpcUrl: args.rpcUrl, onWarn: onWarn });
    if (!sellLeg.ok) {
      if (onWarn) onWarn('原子卖腿没成功（' + sellLeg.msg + '），买腿已成交，币还挂在钱包里 —— 立刻补卖');
      const r2 = await sellBack(Object.assign({}, args, { fromToken: toToken, toToken: fromToken, amount: 'all', label: '补卖' }),
        { ladder: opts.ladder, retries: opts.sellRetries, onWarn: onWarn });
      if (!r2.ok) return { ok: false, stage: 'sellFailed', msg: r2.msg, buy: buyLeg, sell: r2, positionOpen: true };
      return { ok: true, fast: true, msg: '原子卖腿失败，已补卖', buy: buyLeg, sell: r2 };
    }
    return { ok: true, fast: true, buy: buyLeg, sell: sellLeg };
  }
  return last;
}
