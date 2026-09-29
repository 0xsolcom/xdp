/**
 * OKX Web3 DEX 交易（**单账号**）。
 *
 * 只做：报价 → 取出未签名交易 → 本地签名 → 广播上链 → 回报 OKX。
 * 完整流程与字段含义见 docs/dex-trade-flow.md。
 *
 * 设计约束：一次调用只处理**一把钱包**，不提供批量 / 循环 / 刷量入口。
 */
import crypto from 'crypto';
import { Transaction } from 'ethers';
import { apiRetry, codeOf, msgOf } from './client.js';

/** DEX 平台 id：11 = OKX DEX Aggregator */
export const OKX_DEX_PLATFORM_ID = '11';

/* ------------------------------- 报价 ------------------------------- */

/**
 * 取报价。amount 是**人类可读数量**（按 fromToken 的 decimals，后端换算），不是最小单位。
 * 返回 { data, traceLogId }；data.defiPlatformInfoList 是候选路由。
 */
export async function fetchQuote(client, {
  chainId, fromToken, toToken, amount, walletAddress, accountId,
  refCode = '11OKB', slippage = '', traceLogId = crypto.randomUUID(), apiTries = 3, onWarn,
} = {}) {
  const body = {
    tradeMode: '6',
    orderSource: 'MARKET',
    // slippageType: 2 = CUSTOM 固定滑点（给 slippage）；3 = DYNAMIC_NO_LIMIT（自动，浏览器默认）
    // 枚举读自 OKX 扩展源码（见 okx-bank-wap）：之前用 1 是错的，填了 slippage 也不生效。
    slippageConfig: { slippage, maxSlippage: '', slippageType: slippage ? 2 : 3 },
    preSetConfig: { presetType: 6, routerModeType: 1 },
    networkFee: { priorityFee: '', priorityFeeType: 2 },
    chainId: String(chainId),
    fromTokenAddress: fromToken,
    toTokenAddress: toToken,
    direction: '0',
    fromTokenMlt: '1',
    toTokenMlt: '1',
    userWalletAddress: String(walletAddress).toLowerCase(),
    amount: String(amount),
    simulate: false,
    liquidityConfig: { excludedDexIds: '', defiPlatformIds: OKX_DEX_PLATFORM_ID },
    ext: { needApproveTxInfo: true, refCode, mevSupport: true, traceLogId },
    accountInfo: { accountBizLine: 2, teeSilentSignEnabled: true, accountId },
  };
  const r = await apiRetry(
    () => client.post('/priapi/v6/dx/trade/multi/marketQuoteAndCalldata', body),
    { label: 'marketQuoteAndCalldata', tries: apiTries, onWarn },
  );
  const code = codeOf(r.json);
  if (code !== '0') throw new Error(`报价失败 code=${code} ${msgOf(r.json)}`);
  return { data: r.json.data, traceLogId };
}

/** 选默认路由（没有标记就取第一条） */
export function pickRoute(data) {
  const list = data?.defiPlatformInfoList || [];
  return list.find((x) => x.defaultSelected) || list[0] || null;
}

/**
 * 报价里的 unsignedTx / approveTxInfo.unsignedTx 是**JSON 字符串**（不是对象），统一解析。
 * 之前没解析，导致 tx.to / tx.data 取到 undefined，签出了 to=null 的空交易。已修。
 */
function parseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

/** 从路由里取出「要签的交易 / 授权 / 广播地址」 */
export function routeInfo(route) {
  const td = route?.transactionData || {};
  const tx = parseMaybeJson(td.unsignedTx) || parseMaybeJson(td.callData) || null;
  const atRaw = parseMaybeJson(td.approveTxInfo);
  const approveTxInfo = atRaw ? (atRaw.to ? atRaw : (parseMaybeJson(atRaw.unsignedTx) || atRaw)) : null;
  const callData = parseMaybeJson(td.callData) || (tx ? { from: tx.from, to: tx.to, data: tx.data } : null);
  return {
    tx,
    callData,
    orderId: td.orderId,
    approveTxInfo,
    broadcastProvider: td.broadcastProvider || [],
    errorCode: td.errorCode,
    errorMsg: td.errorMsg,
  };
}

/** 人类可读的报价摘要 */
export function describeRoute(route) {
  if (!route) return '（无可用路由）';
  return [
    `平台      ${route.name || ''} (${route.defiPlatformId || ''})`,
    `路由      ${route.router || ''}`,
    `预估到账  ${route.receiveAmount ?? ''}`,
    `保底到账  ${route.minimumReceived ?? ''}`,
    `滑点      ${route.slippage ?? ''}`,
    `gas 估算  ${route.estimateGasFee ?? ''}`,
    `需要授权  ${route.needApprove === '1' ? '是' : '否'}`,
  ].join('\n');
}

/**
 * 查授权状态（对应 jy.har 的 GET /priapi/v1/dx/trade/multi/batchGetTokenApproveInfo）。
 * 返回该平台下这把钱包对某 token 的 allowance：
 *   { approved, amount, status, needCancelApproveToken }
 * status=1 视为已授权；没有 status 时用 amount>0 判断。
 *
 * ⚠️ 路由里的 needApprove:"1" 只是“该平台需要授权机制”，并不代表当前缺授权——
 *    HAR 里 needApprove=1 但 token 早已授权，直接 swap。是否要 approve 只看这里的结果。
 */
export async function checkTokenApprove(client, {
  walletAddress, tokenAddress, chainId, defiPlatformId = OKX_DEX_PLATFORM_ID, onWarn,
} = {}) {
  const query = {
    userWalletAddress: String(walletAddress).toLowerCase(),
    tokenContractAddress: tokenAddress,
    chainId: String(chainId),
    defiPlatformIds: String(defiPlatformId),
  };
  const r = await apiRetry(
    () => client.get('/priapi/v1/dx/trade/multi/batchGetTokenApproveInfo', query),
    { label: 'batchGetTokenApproveInfo', onWarn },
  );
  const code = codeOf(r.json);
  if (code !== '0') throw new Error(`查授权失败 code=${code} ${msgOf(r.json)}`);
  const info = r.json.data?.[String(defiPlatformId)] || null;
  if (!info) return { approved: false, amount: '0', status: null, needCancelApproveToken: null, raw: null };
  const status = info.status === undefined || info.status === null ? null : Number(info.status);
  const amount = String(info.amount ?? '0');
  let approved = status === 1;
  if (status === null) { try { approved = BigInt(amount) > 0n; } catch { approved = false; } }
  return { approved, amount, status, needCancelApproveToken: info.needCancelApproveToken ?? null, raw: info };
}

/* ------------------------------- RPC ------------------------------- */

// 并发跑多钱包时 RPC 也会被同时打很多次，裸 fetch 一失败就整个钱包挂掉。
// 这里统一加「超时 + 指数退避重试」，对发送类（eth_sendRawTransaction）是幂等的：
// 同一笔已签名交易重发得到同一个 hash，不会重复上链。
// ⚠️ 必须**调用时**读环境变量，不能在模块顶层读死：
// bin/trade.js 的 loadDotEnv() 在 import 求值**之后**才跑，模块级的 process.env.X 只会拿到空值，
// .env 里配的 RPC_TIMEOUT_MS / RECEIPT_TRIES 这些全都会失效。
function envNum(key, dflt) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 备用节点（按优先级）。主节点报错时 rpc() 会自动轮换到这些节点。
 *
 * 为什么需要：公共 RPC 常常「一半能用」——比如 base-rpc.publicnode.com 的 eth_call/gasPrice
 * 都正常，唯独 eth_getTransactionReceipt 报 "Archive requests require a personal token"。
 * 只按延迟选最快节点，就会每笔 approve 白等 120s 才超时。由 bin/trade.js 在测速后写入。
 */
let RPC_FALLBACKS = [];
export function setRpcFallbacks(urls) {
  RPC_FALLBACKS = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
}
export const getRpcFallbacks = () => RPC_FALLBACKS.slice();

/** 普通 JSON-RPC 调用（超时 + 重试；重试时在主节点与备用节点之间轮换） */
export async function rpc(rpcUrl, method, params = [], headers = {}, { tries } = {}) {
  const maxTries = Math.max(1, tries === undefined ? envNum('RPC_RETRIES', 3) : tries);
  const timeoutMs = envNum('RPC_TIMEOUT_MS', 20000);
  const targets = [rpcUrl, ...RPC_FALLBACKS]
    .filter(Boolean)
    .filter((u, i, a) => a.indexOf(u) === i);
  let lastErr;
  for (let i = 1; i <= maxTries; i++) {
    const url = targets[(i - 1) % targets.length] || rpcUrl;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC HTTP ${res.status}`);
      const txt = await res.text();
      let j;
      try { j = JSON.parse(txt); } catch { throw new Error(`节点返回的不是 JSON（${url}）`); }
      if (j.error) throw new Error(`RPC ${method} 失败：${j.error.message || JSON.stringify(j.error)}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      // 有备用节点时每轮都换一个（多节点故障概率远低于单节点）；只有一个节点就退避重试
      if (i < maxTries) await new Promise((r) => setTimeout(r, targets.length > 1 ? 250 * i : 400 * i));
    }
  }
  throw lastErr;
}

export const getNonce = (rpcUrl, address) =>
  rpc(rpcUrl, 'eth_getTransactionCount', [String(address).toLowerCase(), 'pending']).then((x) => Number(BigInt(x)));

/** EIP-1559 费用：优先问 RPC，失败再退回 eth_gasPrice */
export async function getFees(rpcUrl) {
  let priority = 1_000_000_000n;
  try { const p = await rpc(rpcUrl, 'eth_maxPriorityFeePerGas', []); if (p) priority = BigInt(p); } catch { /* 不支持就用默认 */ }
  let maxFeePerGas = null;
  try {
    const blk = await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
    const base = BigInt(blk?.baseFeePerGas || '0x0');
    if (base > 0n) maxFeePerGas = base * 2n + priority;
  } catch { /* 忽略 */ }
  if (maxFeePerGas == null) {
    try { maxFeePerGas = BigInt(await rpc(rpcUrl, 'eth_gasPrice', [])); }
    catch { maxFeePerGas = priority * 2n; }
  }
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

const gweiToWei = (g) => BigInt(Math.round(Number(g) * 1e9));

/**
 * 费用**只从报价响应里取**，不经 RPC。
 * networkFeeInfo 的档位是总 gas 价（单位 gwei）：base / marketPriority / fastPriority / turboPriority。
 * 默认用 fastPriority —— 与抓包里浏览器实际出价（约 0.107 gwei）一致。
 * 返回 null 表示报价没给，调用方自行退回 RPC。
 */
export function feesFromQuote(data, tier = 'fastPriority') {
  const nf = data?.networkFeeInfo;
  if (!nf) return null;
  const info = nf.mev?.[0] || nf.normal || nf;
  const total = info?.[tier]?.fee ?? info?.fastPriority?.fee ?? info?.marketPriority?.fee;
  if (total === undefined || total === null || total === '') return null;
  const maxFeePerGas = gweiToWei(total);
  if (maxFeePerGas <= 0n) return null;
  const base = gweiToWei(info?.base?.fee || 0);
  const maxPriorityFeePerGas = maxFeePerGas > base ? maxFeePerGas - base : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** 广播原始交易，返回 txHash */
export async function sendRawTransaction(rpcUrl, rawTx, headers = {}) {
  return rpc(rpcUrl, 'eth_sendRawTransaction', [rawTx], headers);
}

/* ------------------------------- 签名 ------------------------------- */

/**
 * 用钱包 EVM 私钥签一笔 EIP-1559 交易（抓包实测为 type 2）。
 * tx: { to, data, value }；gas/费用缺省时由 RPC 补。
 */
export async function signTx(wallet, tx, {
  chainId, nonce, gasLimit = null, maxFeePerGas = null, maxPriorityFeePerGas = null,
}) {
  // 守卫：to/data 缺失说明交易没组装对，绝不签（否则签出 to=null 的空调 tx，白烧 gas）
  if (!tx || !tx.to) throw new Error('拒绝签名：交易缺少 to（报价 unsignedTx 未解析？）');
  if (!tx.data || tx.data === '0x') throw new Error('拒绝签名：交易缺少 data（会签出空交易）');
  const req = {
    type: 2,
    chainId,
    nonce,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value || '0'),
  };
  if (gasLimit != null) req.gasLimit = BigInt(gasLimit);
  if (maxFeePerGas != null) req.maxFeePerGas = BigInt(maxFeePerGas);
  if (maxPriorityFeePerGas != null) req.maxPriorityFeePerGas = BigInt(maxPriorityFeePerGas);
  const raw = await wallet.signTransaction(req);
  return { raw, txHash: Transaction.from(raw).hash };
}

/* ------------------------------- 回报 OKX ------------------------------- */

/** 把已签交易 / txHash 回报给 OKX（对应浏览器流程的第 6 步） */
export async function reportBroadcast(client, {
  traceLogId, walletId, userWalletAddress, chainId, nonce,
  orderId, raw, txHash, callData, clientBroadcast, onWarn,
}) {
  const body = {
    simulate: false,
    callDataOut: callData,
    traceLogId,
    walletId,
    userWalletAddress: String(userWalletAddress).toLowerCase(),
    chainId: Number(chainId),
    nonce: Number(nonce),
    signedInfoList: [{ txHash, signature: raw }],
    orderId,
    accountInfo: { autoConfirm: true },
    clientBroadcast,
  };
  const r = await apiRetry(
    () => client.post('/priapi/v6/dx/trade/multi/broadcast', body),
    { label: 'dx/broadcast', onWarn },
  );
  const code = codeOf(r.json);
  if (code !== '0') throw new Error(`回报失败 code=${code} ${msgOf(r.json)}`);
  return r.json.data;
}

// Base 出块 ~2s，3s 一轮太钝（平均白等 1s），2s 一轮正好贴着出块节奏。
// 总预算 = tries × intervalMs，默认 30 × 2s = 60s；网络卡就调大 RECEIPT_TRIES（.env 里配即可）。
/**
 * 等链上回执（轮询）。取不到回执时 rpc() 会自己在备用节点间轮换，所以单个坏节点不会把它拖死。
 * 返回 null = 预算内没等到（不代表失败，可能还在 mempool）。
 */
export async function waitReceipt(rpcUrl, txHash, { tries, intervalMs } = {}) {
  const maxTries = Math.max(1, tries === undefined ? envNum('RECEIPT_TRIES', 30) : tries);
  const gapMs = Math.max(300, intervalMs === undefined ? envNum('RECEIPT_INTERVAL_MS', 2000) : intervalMs);
  for (let i = 0; i < maxTries; i++) {
    const rec = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (rec) return rec;
    if (i < maxTries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

/* --------------------------- ERC20 / 回执解析 --------------------------- */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad64 = (hex) => String(hex).toLowerCase().replace(/^0x/, '').padStart(64, '0');

/**
 * 从交易回执的 Transfer 日志里读「这个代币实际进了/出了某个地址多少」。
 * 这是链上真实数字，比报价的 receiveAmount 准（借鉴 okx-bank-wap）。
 * 返回 { in, out }（单位：最小单位 bigint），没有任何相关日志时返回 null。
 */
export function transferDelta(receipt, token, owner) {
  if (!receipt?.logs?.length) return null;
  const ownerLc = String(owner).toLowerCase();
  const tokenLc = String(token).toLowerCase();
  let inAmt = 0n; let outAmt = 0n; let seen = false;
  for (const lg of receipt.logs) {
    if (String(lg.address).toLowerCase() !== tokenLc) continue;
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length < 3) continue;
    seen = true;
    const from = '0x' + lg.topics[1].slice(26);
    const to = '0x' + lg.topics[2].slice(26);
    let val; try { val = BigInt(lg.data); } catch { continue; }
    if (from.toLowerCase() === ownerLc) outAmt += val;
    if (to.toLowerCase() === ownerLc) inAmt += val;
  }
  return seen ? { in: inAmt, out: outAmt } : null;
}

/** 解析 ABI 编码的 string / bytes32 symbol（兼容两种代币实现） */
function decodeSymbol(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length >= 128) {
    try {
      const len = Number(BigInt('0x' + h.slice(64, 128)));
      if (len > 0 && len <= 64) return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8');
    } catch { /* 继续按 bytes32 试 */ }
  }
  try { return Buffer.from(h.slice(0, 64), 'hex').toString('utf8').replace(/\u0000+$/g, '').trim(); } catch { return '?'; }
}

/** 读代币 symbol / decimals（读不到就给默认值，不抛错） */
export async function getTokenMeta(rpcUrl, token) {
  const [sym, dec] = await Promise.all([
    rpc(rpcUrl, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']).catch(() => null),
    rpc(rpcUrl, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => null),
  ]);
  let symbol = '?';
  try { if (sym && sym !== '0x') symbol = decodeSymbol(sym) || '?'; } catch { /* ignore */ }
  let decimals = 18;
  try { if (dec) decimals = Number(BigInt(dec)); } catch { /* ignore */ }
  return { symbol, decimals };
}

/** 读某地址的 ERC20 余额（最小单位 bigint） */
export async function getNativeBalance(rpcUrl, who) {
  const out = await rpc(rpcUrl, 'eth_getBalance', [String(who).toLowerCase(), 'latest']);
  return BigInt(out);
}

/** 读某地址的 ERC20 余额（最小单位 bigint） */
export async function getTokenBalance(rpcUrl, token, who) {
  const out = await rpc(rpcUrl, 'eth_call', [{ to: token, data: '0x70a08231' + pad64(who) }, 'latest']);
  return BigInt(out);
}

/** 读 allowance（最小单位 bigint） */
export async function getAllowance(rpcUrl, token, owner, spender) {
  const out = await rpc(rpcUrl, 'eth_call', [{ to: token, data: '0xdd62ed3e' + pad64(owner) + pad64(spender) }, 'latest']);
  return BigInt(out);
}

/* --------------------------- swap calldata 解析 --------------------------- */

/**
 * OKX DEX 聚合合约的 swap calldata 解析（从 okx-bank-wap 的 okx-swap-abi.js 移植）。
 *   dagSwapTo        0x0c307f76  base 从字 2 开始，字 1 = 收款人
 *   dagSwapByOrderId 0xf2c42696  base 从字 1 开始，无收款人（用调用者）
 * base 内连续：inputToken, outputToken, inputAmount, minReturn, deadline。
 * 未知 selector 返回 null（不猜）。
 */
export function decodeSwap(data) {
  const sel = String(data || '').slice(0, 10).toLowerCase();
  const defs = {
    '0x0c307f76': { name: 'dagSwapTo', baseOffset: 2, hasRecipient: true },
    '0xf2c42696': { name: 'dagSwapByOrderId', baseOffset: 1, hasRecipient: false },
  };
  const def = defs[sel];
  if (!def) return null;
  const body = String(data).replace(/^0x/i, '').slice(8);
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push(body.slice(i, i + 64).toLowerCase());
  const o = def.baseOffset;
  if (words.length < o + 5) throw new Error(`calldata 太短：只有 ${words.length} 个字`);
  const addrOf = (w) => '0x' + w.slice(24);
  return {
    name: def.name,
    selector: sel,
    orderId: BigInt('0x' + words[0]),
    recipient: def.hasRecipient ? addrOf(words[1]) : null,
    inputToken: addrOf(words[o]),
    outputToken: addrOf(words[o + 1]),
    inputAmount: BigInt('0x' + words[o + 2]),
    minReturn: BigInt('0x' + words[o + 3]),
    deadline: BigInt('0x' + words[o + 4]),
  };
}
