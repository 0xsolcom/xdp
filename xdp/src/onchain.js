// src/onchain.js
// 链上实时通道：订阅 Base 新区块（WSS newHeads），出块即解析，抢在 OKX 索引/官方榜之前入库。
//
// 两条并行路径：
//   ① 出块触发 —— 只要这个块里有「打到 OKX 路由」的交易（含订单式），
//      立刻回调 onActivity()（index.js 用它触发一次 OKX 接口抓取），把定时轮询的等待时间抹掉。
//   ② 链上直采 —— 直接解析回执里的 Transfer 日志，算出「谁、买还是卖、多少量」，
//      自己写库（source='onchain'）。不等 OKX 接口，理论上和出块同速。
//      OKX 接口随后到达同一条成交时，save.js 会用官方口径覆盖它（source 改回 'okx'），
//      所以：速度靠直采，准确性仍以 OKX 为准。
//
// 直采只处理稳定币计价（USDC/USDT/USDbC，价格≈1）；ETH/WETH 计价与智能钱包（4337）
// 交给 OKX 接口兜底，避免喂价和归因出错。
//
// ⚠️ 2026-09-29：直采只收 dagSwapTo。dagSwapByOrderId（订单式成交）官方活动不计，
//    由 isDroppedSwap() 在入库前剔除 —— 见该函数的注释。
import { pool } from './db.js';
import { rpcCall, rpcBatch } from './rpc.js';
import {
  CHAIN_INDEX, TOKEN_ADDRESS, OKX_ROUTERS, OKX_METHOD_IDS, ONCHAIN_QUOTE, TRANSFER_TOPIC,
  WATCHER_WSS, WATCHER_POLL_MS, WATCHER_CONCURRENCY, WATCHER_INGEST, utcDatetime,
  INGEST_ONLY_OKX, INGEST_DROP_ORDER_SWAP, DEX_METHOD_BY_ORDER,
} from './config.js';

const DAG_SWAP = '0x0c307f76';

/**
 * 走 src/rpc.js 的共享客户端：多节点轮换 + 超时重试。
 * 原来这里直连单个 CHAIN_RPC_URL —— 实测回扫 5 分钟区间时 56 次命中里有 39 次失败，
 * 全是公共节点限流。换成带备用节点的 rpcCall 后失败率大幅下降。
 */
const rpc = (method, params) => rpcCall(method, params, { timeout: 20000 });

export const watcherStats = {
  connected: false,
  mode: 'idle',            // wss / http / idle
  lastBlock: 0,
  lastBlockAt: null,
  blocksSeen: 0,
  swapsFound: 0,
  ingested: 0,
  triggered: 0,
  errors: 0,
  gaps: 0,           // 断线补洞次数
  missedBlocks: 0,   // 累计补回来的块数
  lastError: null,
};

// WSS 断线补洞的单次上限：漏太多说明进程停了很久，那部分交给 scripts/scan-onchain.js 兜底，
// 免得一次往队列里塞几万个块把实时通道堵死。
const GAP_FILL_MAX = Number(process.env.WATCHER_GAP_FILL_MAX || 300);

let onActivity = null;
let running = false;
let lastHeight = 0;
const seen = new Set();     // 已处理块号（防重）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + Number(n).toString(16);

/** 这个 tx 是不是「经 OKX 路由的 swap」（含订单式成交 —— 触发抓取时仍要看见它） */
function isRouterTx(tx) {
  const to = String(tx.to || '').toLowerCase();
  const input = String(tx.input || '').toLowerCase();
  if (OKX_ROUTERS.size > 0 && OKX_ROUTERS.has(to)) return true;
  if (OKX_METHOD_IDS.size > 0 && OKX_METHOD_IDS.has(input.slice(0, 10))) return true;
  return false;
}

/**
 * 这个 tx 的成交「官方活动不算」→ 直采时直接跳过。
 *
 * ⚠️ 2026-09-29 改：以前这里只判「是不是打到 OKX 路由」，把 dagSwapByOrderId 也一起收了
 *    （当时的注释还专门说「它比 dagSwapTo 还多，写死会漏掉一大半」）。
 *    后来查明官方活动**只认 dagSwapTo**：
 *      · 官网前 100 有 99 个只用 dagSwapTo(0x0c307f76)
 *      · 0 个用过 dagSwapByOrderId(0xf2c42696)（按订单号成交，订单式/做市 API 路径）
 *    它占入库量约一半，收下来官方一分都不算，纯占存储。
 *
 * 注意这里**只影响入库**；isRouterTx 保持原样，出块触发抓取的逻辑不受影响。
 */
function isDroppedSwap(tx) {
  if (!(INGEST_ONLY_OKX && INGEST_DROP_ORDER_SWAP)) return false;
  return String(tx.input || '').toLowerCase().slice(0, 10) === DEX_METHOD_BY_ORDER;
}

/**
 * 从回执的 Transfer 日志里还原这笔 swap（只认稳定币计价）。
 *
 * 两种成交形态：
 *   ① 常规：稳定币腿直接来自/去往用户钱包 —— 直接取用户那条腿。
 *   ② 代付：稳定币由**第三方**垫付（捆绑交易 / 智能钱包 / 求解器），
 *      用户的 USDC 一分钱都没动，链上只看到「第三方 → 路由 → 池子 → XDP → 用户」。
 *      实测 0x866afc61…（官方榜第 1 名）就是这种：官方记 $24,924，本地只抓到 $701。
 *      这时退回用「XDP 池子那条稳定币腿」—— 池子收到多少稳定币，就是本轮成交额。
 *
 * ② 以前完全依赖 OKX 接口兜底，接口一挂（2026-09-29 那波 402）这批交易就全丢了。
 */
export function parseSwap(receipt, tx) {
  if (!receipt || !tx || String(receipt.status) === '0x0') return null;
  const user = String(tx.from || '').toLowerCase();
  let gotXdp = 0n, sentXdp = 0n;
  let quote = null;      // { symbol, decimals, amount(BigInt), dir }
  let xdpPool = null;    // 与用户发生 XDP 转账的对手方（池子 / 路由中转）

  // 第一遍：找 XDP 腿 + 用户自己的稳定币腿
  for (const log of receipt.logs || []) {
    const topics = log.topics || [];
    if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
    const token = String(log.address || '').toLowerCase();
    const fromA = '0x' + String(topics[1]).slice(26).toLowerCase();
    const toA   = '0x' + String(topics[2]).slice(26).toLowerCase();
    let val = 0n;
    try { val = BigInt(log.data); } catch (e) { continue; }

    if (token === TOKEN_ADDRESS) {
      if (toA === user) { gotXdp += val; xdpPool = fromA; }
      if (fromA === user) { sentXdp += val; xdpPool = toA; }
      continue;
    }
    const q = ONCHAIN_QUOTE[token];
    if (q && (fromA === user || toA === user)) {
      quote = { symbol: q.symbol, decimals: q.decimals, amount: val, dir: fromA === user ? 'out' : 'in' };
    }
  }

  // 第二遍：用户自己没碰稳定币 → 用 XDP 池子那条稳定币腿（代付场景）
  if (!quote && xdpPool) {
    for (const log of receipt.logs || []) {
      const topics = log.topics || [];
      if (String(topics[0] || '').toLowerCase() !== TRANSFER_TOPIC || topics.length < 3) continue;
      const q = ONCHAIN_QUOTE[String(log.address || '').toLowerCase()];
      if (!q) continue;
      const fromA = '0x' + String(topics[1]).slice(26).toLowerCase();
      const toA   = '0x' + String(topics[2]).slice(26).toLowerCase();
      if (fromA !== xdpPool && toA !== xdpPool) continue;
      let val = 0n;
      try { val = BigInt(log.data); } catch (e) { continue; }
      // 池子「收到」稳定币 = 买入；池子「付出」稳定币 = 卖出
      quote = { symbol: q.symbol, decimals: q.decimals, amount: val, dir: toA === xdpPool ? 'out' : 'in' };
    }
  }

  if (!quote) return null;                      // 稳定币腿和池子都没有（ETH 计价）→ 交给 OKX 接口
  const type = gotXdp > 0n && sentXdp === 0n ? 'buy' : (sentXdp > 0n && gotXdp === 0n ? 'sell' : null);
  if (!type) return null;
  const volume = Number(quote.amount) / Math.pow(10, quote.decimals);
  if (!isFinite(volume) || volume <= 0) return null;

  return { wallet: user, type, volume, quoteSymbol: quote.symbol };
}

/** 链上直采入库（同 tx+钱包+方向只写一次） */
async function ingestOnchain(tx, receipt, blockTimeMs) {
  const swap = parseSwap(receipt, tx);
  if (!swap) return false;
  const txHash = String(tx.hash).toLowerCase();

  const [exist] = await pool.query(
    'SELECT trade_id FROM trades WHERE chain_index = ? AND token_address = ? AND tx_hash = ? AND wallet_address = ? AND type = ? LIMIT 1',
    [CHAIN_INDEX, TOKEN_ADDRESS, txHash, swap.wallet, swap.type]
  );
  if (exist.length) return false;

  const [[cc]] = await pool.query('SELECT is_contract FROM contract_check WHERE address = ? LIMIT 1', [swap.wallet]);
  const isContract = cc && Number(cc.is_contract) === 1 ? 1 : 0;

  const raw = {
    onchain: true, block: Number(tx.blockNumber), quote: swap.quoteSymbol,
    volume: swap.volume, ts: blockTimeMs,
  };
  await pool.query(
    'INSERT IGNORE INTO trades ' +
    '(trade_id, chain_index, token_address, wallet_address, tx_hash, type, volume_usd, price, quote_symbol, dex_name, trade_time, raw_json, is_okx, wallet_is_contract, source) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      'oc:' + txHash + ':' + swap.wallet + ':' + swap.type,
      CHAIN_INDEX, TOKEN_ADDRESS, swap.wallet, txHash, swap.type,
      swap.volume, null, swap.quoteSymbol, 'onchain', utcDatetime(blockTimeMs),
      JSON.stringify(raw), 1, isContract, 'onchain',
    ]
  );
  return true;
}

/** 处理一个块 */
async function processBlockNumber(num) {
  if (seen.has(num)) return;
  seen.add(num);
  if (seen.size > 2000) seen.clear();

  let block;
  try {
    block = await rpc('eth_getBlockByNumber', [hex(num), true]);
  } catch (e) {
    // ⚠️ 拉块失败必须把块号从 seen 里摘掉 —— 否则它被当成"已处理"，永远不会重试，
    // 这一块的成交就永久丢了。摘掉之后下次收到同一个高度还会再试。
    // （兜底：每 10 分钟的链上重扫会覆盖最近 20 分钟，所以即使这里漏了也能补回来）
    seen.delete(num);
    throw e;
  }
  if (!block || !block.transactions) return;
  watcherStats.blocksSeen++;
  watcherStats.lastBlock = num;
  watcherStats.lastBlockAt = new Date().toISOString();
  // 每 25 个块打一条，便于在 logs/index.log 里观察实时通道是否在干活
  if (watcherStats.blocksSeen % 25 === 0) {
    console.log('[链上] 块 ' + num + ' | 已看 ' + watcherStats.blocksSeen + ' 块 | 命中路由 ' +
      watcherStats.swapsFound + ' | 直采入库 ' + watcherStats.ingested + ' | 触发抓取 ' +
      watcherStats.triggered
      + (watcherStats.gaps ? (' | 补洞 ' + watcherStats.gaps + ' 次/' + watcherStats.missedBlocks + ' 块') : '')
      // 光有个数字没用，把最近一次失败原因也带上 —— 否则只能看着它涨，不知道涨的是什么
      + (watcherStats.errors ? (' | 错误 ' + watcherStats.errors
          + (watcherStats.lastError ? ('（最近：' + String(watcherStats.lastError).slice(0, 80) + '）') : '')) : ''));
  }

  const hits = block.transactions.filter((t) => typeof t === 'object' && isRouterTx(t));
  if (hits.length) {
    watcherStats.swapsFound += hits.length;
    // 出块触发：让 index.js 立刻去拉一次 OKX 接口（补上直采拿不到的 ETH 计价/智能钱包）
    if (typeof onActivity === 'function') {
      watcherStats.triggered++;
      Promise.resolve(onActivity(hits.length)).catch(() => {});
    }
  }
  // 官方活动不认「订单式成交」→ 连回执都不去取了，省掉一半 RPC 和存储
  const ingestList = hits.filter((t) => !isDroppedSwap(t));
  if (!WATCHER_INGEST || !ingestList.length) return;

  const blockTimeMs = Number(BigInt(block.timestamp)) * 1000;
  // ★ 一次批量把整块的回执拿回来（公共节点对单条并发很敏感，批量反而稳），再逐条解析入库。
  const receipts = await rpcBatch(
    ingestList.map((tx) => ({ method: 'eth_getTransactionReceipt', params: [tx.hash] })),
    { chunkSize: 5, concurrency: Math.max(1, WATCHER_CONCURRENCY) }
  ).catch(() => []);
  for (let i = 0; i < ingestList.length; i++) {
    try {
      if (await ingestOnchain(ingestList[i], receipts[i], blockTimeMs)) watcherStats.ingested++;
    } catch (e) {
      watcherStats.errors++;
      watcherStats.lastError = e.message;
    }
  }
}

/** 串行处理块号区间（保证顺序、避免风暴） */
let chain = Promise.resolve();
function enqueue(num) {
  chain = chain.then(() => processBlockNumber(num)).catch((e) => {
    watcherStats.errors++;
    watcherStats.lastError = e.message;
  });
  return chain;
}

/** HTTP 兜底：轮询 eth_blockNumber */
async function httpLoop() {
  watcherStats.mode = 'http';
  while (running) {
    try {
      const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
      if (latest > lastHeight) {
        for (let n = lastHeight + 1; n <= latest; n++) await enqueue(n);
        lastHeight = latest;
      }
    } catch (e) {
      watcherStats.errors++;
      watcherStats.lastError = e.message;
    }
    await sleep(WATCHER_POLL_MS);
  }
}

/**
 * 拿一个 WebSocket 实现：优先 Node 内置的全局 WebSocket（**Node 22+ 才有**），
 * 没有就退回 `ws` 包。
 *
 * ⚠️ 2026-09-29：原来直接用全局 WebSocket。服务器上跑的是 Node 18/20，
 *    那里 WebSocket 是 undefined → `new WebSocket()` 抛 ReferenceError →
 *    被 catch 吞掉 → **静默**退化成 HTTP 轮询，日志只留一句「WSS 不可用」，完全看不出原因。
 */
let WSImpl = typeof WebSocket === 'function' ? WebSocket : null;
let wsReason = WSImpl ? 'Node 内置 WebSocket' : '';
async function resolveWebSocket() {
  if (WSImpl) return WSImpl;
  try {
    const mod = await import('ws');
    WSImpl = mod.default || mod.WebSocket;
    wsReason = 'ws 包';
    return WSImpl;
  } catch (e) {
    throw new Error('没有可用的 WebSocket 实现：当前 Node ' + process.version
      + ' 不带全局 WebSocket（需要 22+），且没装 ws 包。'
      + '修复：cd xdp && npm install ws');
  }
}

/** WSS：订阅 newHeads，出块即处理 */
async function wssLoop() {
  let Impl;
  try { Impl = await resolveWebSocket(); }
  catch (e) { console.error('[链上] ' + e.message); return false; }

  return new Promise((resolve) => {
    let ws;
    let settled = false;
    let giveUp = null;
    const done = (ok) => { if (!settled) { settled = true; if (giveUp) clearTimeout(giveUp); resolve(ok); } };

    giveUp = setTimeout(() => {
      if (!watcherStats.connected) {
        console.error('[链上] WSS 订阅超时（10s）：' + WATCHER_WSS + '（实现：' + wsReason + '）'
          + ' —— 可能是该节点不提供 WS，或服务器出站被防火墙拦了');
        try { ws.close(); } catch (e) { /* ignore */ }
        done(false);
      }
    }, 10000);

    try { ws = new Impl(WATCHER_WSS); }
    catch (e) { console.error('[链上] 创建 WebSocket 失败：' + e.message); return done(false); }
    if (!ws) return done(false);

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id === 1 && m.result) {           // 订阅成功
        watcherStats.connected = true;
        watcherStats.mode = 'wss';
        clearTimeout(giveUp);
        resolve(true);
        return;
      }
      const head = m.params && m.params.result;
      if (head && head.number) {
        const num = Number(BigInt(head.number));
        if (num > lastHeight) {
          // ★ 补洞：WSS 断开期间 newHeads 是收不到的，重连后如果只处理新块，
          //   中间那段的成交就**永久丢失**（接口还活着时能靠它补，现在接口停了就是真丢）。
          //   httpLoop 早就在补（for n = lastHeight+1..latest），这里补齐同样的语义。
          const missed = num - lastHeight - 1;
          if (missed > 0) {
            watcherStats.gaps++;
            watcherStats.missedBlocks += Math.min(missed, GAP_FILL_MAX);
            if (missed > GAP_FILL_MAX) {
              console.warn('[链上] ⚠️ 断线漏掉 ' + missed + ' 块，超过单次补洞上限 ' + GAP_FILL_MAX
                + '：只补最近 ' + GAP_FILL_MAX + ' 块。更大范围请跑 node scripts/scan-onchain.js --minutes N');
              for (let n = num - GAP_FILL_MAX; n <= num; n++) enqueue(n);
            } else {
              console.log('[链上] 补洞 ' + missed + ' 块（' + (lastHeight + 1) + '~' + (num - 1) + '）');
              for (let n = lastHeight + 1; n <= num; n++) enqueue(n);
            }
          } else {
            enqueue(num);
          }
          lastHeight = num;
        }
      }
    };
    // 别把错误吞了 —— 原来这里是空的 () => {}，WSS 一直连不上却什么都看不到
    ws.onerror = (ev) => {
      const msg = (ev && (ev.message || (ev.error && ev.error.message))) || '未知错误';
      console.error('[链上] WSS 错误：' + msg + '  端点 ' + WATCHER_WSS);
    };
    ws.onclose = () => {
      watcherStats.connected = false;
      done(false);
    };
  });
}

/** 启动链上实时通道 */
export async function startWatcher({ onActivity: cb } = {}) {
  if (running) return;
  running = true;
  onActivity = cb || null;

  try {
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    lastHeight = latest - Number(process.env.WATCHER_BACKFILL_BLOCKS || 3); // 启动回看几个块
    console.log('[链上] 起始块', lastHeight, '(latest', latest + ')');
  } catch (e) {
    watcherStats.lastError = e.message;
  }

  const ok = await wssLoop();
  if (!ok) {
    console.log('[链上] WSS 不可用，改用 HTTP 轮询（间隔 ' + WATCHER_POLL_MS + 'ms）');
    httpLoop();
  } else {
    console.log('[链上] WSS 已订阅 newHeads:', WATCHER_WSS, '（' + wsReason + '）');
    // WSS 断了就自动重连
    const watchdog = setInterval(async () => {
      if (!running) { clearInterval(watchdog); return; }
      if (!watcherStats.connected) {
        const back = await wssLoop();
        if (!back) await sleep(2000);
      }
    }, 5000);
  }
}

export function stopWatcher() { running = false; }

/**
 * 历史链上扫描：把某段区块里的 OKX 路由成交直接解析入库。
 * 用途：
 *   1) 补齐 OKX 接口漏掉的钱包（公开接口有时不返回某些地址的成交）
 *   2) 完全绕开 OKX 索引，自己从链上重建
 * 注意：只处理稳定币计价（USDC/USDT/USDbC）的直连 EOA swap；ETH 计价与智能钱包交给 OKX 接口。
 */
export async function scanRange(fromBlock, toBlock, { verbose = true, concurrency = 8 } = {}) {
  const total = toBlock - fromBlock + 1;
  let done = 0, hits = 0, ingested = 0, failed = 0;
  const queue = [];
  for (let n = fromBlock; n <= toBlock; n++) queue.push(n);

  async function worker() {
    while (queue.length) {
      const n = queue.shift();
      try {
        const block = await rpc('eth_getBlockByNumber', [hex(n), true]);
        done++;
        if (block && Array.isArray(block.transactions)) {
          const ts = Number(BigInt(block.timestamp)) * 1000;
          const txs = block.transactions.filter((t) => typeof t === 'object' && isRouterTx(t) && !isDroppedSwap(t));
          hits += txs.length;
          if (txs.length) {
            const recs = await rpcBatch(
              txs.map((tx) => ({ method: 'eth_getTransactionReceipt', params: [tx.hash] })),
              { chunkSize: 5, concurrency: 4 }
            ).catch(() => []);
            for (let i = 0; i < txs.length; i++) {
              try {
                if (await ingestOnchain(txs[i], recs[i], ts)) ingested++;
              } catch (e) { failed++; }
            }
          }
        }
      } catch (e) { failed++; }
      if (verbose && done % 200 === 0) {
        process.stdout.write('\r扫描 ' + done + '/' + total + '  命中 ' + hits + '  入库 ' + ingested);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (verbose) process.stdout.write('\n');
  return { scanned: done, hits, ingested, failed };
}
