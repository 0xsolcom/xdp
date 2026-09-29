/**
 * OKX DEX WebSocket 实时成交流 —— 免费、无需 API Key、无需登录。
 *
 * 来源：OKX 网页端自己用的通道（页面内嵌 socketBaseUrls 里 dex / dexTrade 都指向 wsdexpri.okx.com）。
 *   URL    : wss://wsdexpri.okx.com/ws/v5/ipublic   （公开，iprivate 才需要 login）
 *   频道   : dex-market-trade-history-pub
 *   订阅   : {"op":"subscribe","args":[{"channel":"dex-market-trade-history-pub",
 *                                      "chainId":"8453","tokenAddress":"0x07b3…"}]}
 *   ⚠️ 心跳 : 裸字符串 `ping|<nonce>|<timestamp>`（**不是 JSON**！写成 {"op":"ping"} 会报 60012）
 *
 * 为什么值得接：
 *   REST /api/v6/dex/market/trades 每月只有 100K 次免费额度，超额 $0.0001/次，
 *   而这条 WS 免费、实时推送、不会翻页落后。实测与 REST 最近 100 笔 **100% 重叠、0 遗漏**，
 *   速率 325~392 笔/分钟，报文结构和 REST 完全一致。
 *
 * 三条数据源的分工（优先级 okx > ws > onchain）：
 *   ws      实时主力，source='ws'
 *   onchain 独立兜底（不依赖 OKX 任何服务）
 *   okx     REST，口径最准，只在手工回补/对账时用
 */
import { createRequire } from 'node:module';
import { saveTrades } from './save.js';
import {
  CHAIN_INDEX, TOKEN_ADDRESS,
  WS_TRADES_URL, WS_TRADES_CHANNEL, WS_TRADES_PING_MS, WS_TRADES_RECONNECT_MS,
  WS_TRADES_FLUSH_MS, WS_TRADES_FLUSH_MAX, WS_TRADES_STALE_MS,
} from './config.js';

// Node 22+ 才有全局 WebSocket；更老的版本退回 ws 包（package.json 已依赖）
const require = createRequire(import.meta.url);
let WSImpl = typeof WebSocket === 'function' ? WebSocket : null;
let wsImplName = WSImpl ? 'Node 内置 WebSocket' : '';
function resolveWebSocket() {
  if (WSImpl) return WSImpl;
  const mod = require('ws');
  WSImpl = mod.default || mod.WebSocket || mod;
  wsImplName = 'ws 包';
  return WSImpl;
}

export const wsStats = {
  connected: false, url: '', channel: '', impl: '',
  msgs: 0, trades: 0, inserted: 0, errors: 0, reconnects: 0,
  lastMsgAt: null, lastFlushAt: null, lastError: null,
  lastCloseAt: null, lastCloseCode: null, lastCloseReason: '',
  connectedSince: null,   // 本次连接建立时刻（用于算在线率）
  startedAt: null,
};

/** 供 /status 或外部巡检用的一行摘要 */
export function wsStatusLine() {
  const s = wsStats;
  const up = s.connectedSince && s.connected
    ? Math.round((Date.now() - Date.parse(s.connectedSince)) / 1000) + 's'
    : '—';
  return '[WS] ' + (s.connected ? '✅ 在线 ' + up : '❌ 未连接')
    + ' | 收 ' + s.trades + ' 笔 / 入库 ' + s.inserted + ' 笔'
    + ' | 重连 ' + s.reconnects + ' 次' + (s.errors ? (' / 错误 ' + s.errors) : '')
    + (s.lastMsgAt ? (' | 最后消息 ' + Math.round((Date.now() - Date.parse(s.lastMsgAt)) / 1000) + 's 前') : '');
}

let running = false;
let sock = null;
let pingTimer = null;
let flushTimer = null;
let statTimer = null;
let staleTimer = null;
let reconnectTimer = null;
let buffer = [];
const seenIds = new Set();   // 本连接内已进过缓冲的 id（防止同一条被推两次）

/** ws 包用 EventEmitter，原生 WebSocket 用 addEventListener —— 兼容两种 */
function on(s, ev, fn) {
  if (typeof s.on === 'function') s.on(ev, fn);
  else if (typeof s.addEventListener === 'function') s.addEventListener(ev, fn);
}

/**
 * WS 报文 → saveTrades 能吃的格式（字段名对齐 REST）：
 *   timestamp → time       isBuy '1'/'0' → type 'buy'/'sell'
 *   txHash 是 WS 白送的（REST 要从 txHashUrl 里切）
 */
export function wsToRestFormat(x) {
  return {
    id: String(x.id || ''),
    txHash: String(x.txHash || ''),
    userAddress: String(x.userAddress || ''),
    type: x.isBuy === '1' ? 'buy' : 'sell',
    volume: x.volume,
    price: x.price,
    dexName: x.dexName,
    time: Number(x.timestamp || 0),
    changedTokenInfo: x.changedTokenInfo,
  };
}

async function flush() {
  flushTimer = null;
  if (!buffer.length) return;
  const list = buffer;
  buffer = [];
  wsStats.lastFlushAt = new Date().toISOString();
  try {
    const added = await saveTrades(CHAIN_INDEX, TOKEN_ADDRESS, list, { source: 'ws' });
    wsStats.inserted += added;
  } catch (e) {
    wsStats.errors++;
    wsStats.lastError = e.message;
    console.error('[WS] 写库失败：' + e.message);
  }
}

function scheduleFlush() {
  if (buffer.length >= WS_TRADES_FLUSH_MAX) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    return flush();                       // 攒够了立刻落库
  }
  if (!flushTimer) flushTimer = setTimeout(flush, WS_TRADES_FLUSH_MS);
}

function sendPing() {
  try {
    // ⚠️ 必须裸字符串；三段式（nonce 会被原样回显，可顺便算往返延迟）
    sock.send('ping|' + Math.random().toString(16).slice(2) + '|' + Date.now());
  } catch (e) { /* 断了会走重连 */ }
}

function clearTimers() {
  for (const t of [pingTimer, statTimer, staleTimer, reconnectTimer]) if (t) clearInterval(t), clearTimeout(t);
  pingTimer = statTimer = staleTimer = reconnectTimer = null;
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  const wait = WS_TRADES_RECONNECT_MS;
  console.log('[WS] ' + (wait / 1000) + 's 后重连…');
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
}

function connect() {
  if (!running) return;
  const Impl = resolveWebSocket();
  wsStats.impl = wsImplName;
  wsStats.url = WS_TRADES_URL;
  wsStats.channel = WS_TRADES_CHANNEL;

  let s;
  try {
    s = new Impl(WS_TRADES_URL, { headers: { Origin: 'https://web3.okx.com', 'User-Agent': 'Mozilla/5.0' } });
  } catch (e) {
    wsStats.errors++; wsStats.lastError = e.message;
    console.error('[WS] 创建连接失败：' + e.message);
    return scheduleReconnect();
  }
  sock = s;

  on(s, 'open', () => {
    wsStats.connected = true;
    wsStats.connectedSince = new Date().toISOString();
    if (!wsStats.startedAt) wsStats.startedAt = wsStats.connectedSince;
    seenIds.clear();
    console.log('[WS] 已连接 ' + WS_TRADES_URL + '（' + wsImplName + '）');
    s.send(JSON.stringify({
      op: 'subscribe',
      args: [{ channel: WS_TRADES_CHANNEL, chainId: String(CHAIN_INDEX), tokenAddress: TOKEN_ADDRESS }],
    }));
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(sendPing, WS_TRADES_PING_MS);
    if (staleTimer) clearInterval(staleTimer);
    // 半开连接看门狗：超过 STALE_MS 一条消息都没有，主动断开重连
    staleTimer = setInterval(() => {
      if (!wsStats.lastMsgAt) return;
      if (Date.now() - Date.parse(wsStats.lastMsgAt) > WS_TRADES_STALE_MS) {
        console.warn('[WS] ⚠️ ' + Math.round(WS_TRADES_STALE_MS / 1000) + 's 没收到任何消息，主动重连');
        try { s.close(); } catch (e) { /* ignore */ }
      }
    }, Math.min(30000, WS_TRADES_STALE_MS));
  });

  on(s, 'message', (raw) => {
    wsStats.msgs++;
    wsStats.lastMsgAt = new Date().toISOString();
    // ⚠️ 两种实现的回调参数不一样：
    //   ws 包            → 直接给 data（string / Buffer）
    //   Node 原生 WebSocket → 给 MessageEvent，消息在 .data 里
    // 不兼容的话 String(ev) 会得到 "[object MessageEvent]"，JSON.parse 静默失败、一条都进不来。
    const text = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw;
    let j;
    try { j = JSON.parse(typeof text === 'string' ? text : String(text)); } catch (e) { return; }
    if (j.event === 'error') {
      wsStats.errors++; wsStats.lastError = j.msg || 'ws error';
      console.error('[WS] 服务端报错：' + (j.msg || '') + ' code=' + (j.code || ''));
      return;
    }
    if (j.event === 'subscribe') { console.log('[WS] 订阅成功：' + WS_TRADES_CHANNEL); return; }
    if (!Array.isArray(j.data)) return;
    for (const x of j.data) {
      const id = String(x.id || '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      if (seenIds.size > 20000) seenIds.clear();   // 防内存无限增长
      wsStats.trades++;
      buffer.push(wsToRestFormat(x));
    }
    scheduleFlush();
  });

  on(s, 'error', (e) => {
    wsStats.errors++;
    wsStats.lastError = (e && (e.message || (e.error && e.error.message))) || 'ws error';
    console.error('[WS] 连接错误：' + wsStats.lastError);
  });

  // 断开：ws 包给 (code, reason) 两个位置参数，原生 WebSocket 给一个 CloseEvent
  on(s, 'close', (a, b) => {
    const ev = (a && typeof a === 'object') ? a : null;
    const code = ev ? ev.code : a;
    const reason = ev ? ev.reason : b;
    const downMs = wsStats.lastMsgAt ? (Date.now() - Date.parse(wsStats.lastMsgAt)) : null;
    wsStats.connected = false;
    wsStats.lastCloseAt = new Date().toISOString();
    wsStats.lastCloseCode = (code === undefined || code === null) ? null : Number(code);
    wsStats.lastCloseReason = reason ? String(reason).slice(0, 120) : '';
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (staleTimer) { clearInterval(staleTimer); staleTimer = null; }
    if (!running) return;          // 是我们自己 stop 的，不用重连
    flush();                       // 断开前把缓冲落库，别丢
    wsStats.reconnects++;
    console.warn('[WS] ⚠️ 连接断开'
      + (code !== undefined && code !== null ? ('（code=' + code + (reason ? ' ' + String(reason).slice(0, 60) : '') + '）') : '')
      + (downMs !== null ? ('，距最后一条消息 ' + Math.round(downMs / 1000) + 's') : '')
      + '，累计重连 ' + wsStats.reconnects + ' 次');
    scheduleReconnect();
  });
}

/** 启动 WS 成交通道。返回立即 resolve（后台自己重连），不阻塞主流程 */
export function startWsTrades() {
  if (running) return;
  running = true;
  console.log('   成交WS  :', WS_TRADES_URL + '  频道 ' + WS_TRADES_CHANNEL);
  connect();
  // 5 分钟一条汇总，别刷屏。
  // ⚠️ 必须同时给「本窗口增量」和「累计」—— 只给累计值会被误读成
  //    「一次收了 3 万笔」（其实那是进程启动以来的总数）。
  let lastTrades = 0, lastInserted = 0;
  statTimer = setInterval(() => {
    if (!running) return;
    const dT = wsStats.trades - lastTrades;
    const dI = wsStats.inserted - lastInserted;
    lastTrades = wsStats.trades;
    lastInserted = wsStats.inserted;
    if (wsStats.trades === 0) return;
    console.log('[WS] 近 5 分钟 收 ' + dT + ' 笔 / 入库 ' + dI + ' 笔'
      + '   |   累计 收 ' + wsStats.trades + ' / 入库 ' + wsStats.inserted
      + '（' + (wsStats.startedAt ? Math.round((Date.now() - Date.parse(wsStats.startedAt)) / 60000) + ' 分钟' : '') + '）'
      + '   |   重连 ' + wsStats.reconnects + ' 次' + (wsStats.errors ? (' / 错误 ' + wsStats.errors) : '')
      + (wsStats.connected ? '' : '   ⚠️ 当前未连接'));
  }, 300000);
}

export function stopWsTrades() {
  running = false;
  clearTimers();
  try { if (sock) sock.close(); } catch (e) { /* ignore */ }
  sock = null;
  wsStats.connected = false;
}
