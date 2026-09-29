// src/config.js
// 集中读取 .env，所有模块共用一份配置（避免每个文件各读各的，口径跑偏）。
import dotenv from 'dotenv';
// override: .env 优先于 Shell 环境变量（部署机上常有别的项目导出的 DB_* / CHAIN_* 变量）
dotenv.config({ override: true });

export function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function truthy(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

/** "毫秒时间戳" 或 "ISO 字符串" → 毫秒（失败 / 空 → null，表示不限制） */
export function parseTime(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * 毫秒 / Date → MySQL DATETIME 字符串（UTC）。
 * 不要直接往 DATETIME 列写 JS Date：mysql2 会按【进程本地时区】格式化，
 * 部署机是 +08 时整体偏移 8 小时（读回来再按 UTC 解释就少 8 小时）。
 * 显式写 UTC 字符串最稳。
 */
export function utcDatetime(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = v instanceof Date ? v : new Date(Number(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** ISO / 时间戳 → MySQL DATETIME 字符串（UTC） */
export function toUtcSql(raw, fallback) {
  const ms = parseTime(raw);
  if (ms === null) return fallback;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------- 目标 ----------------
export const CHAIN_INDEX = String(process.env.CHAIN_INDEX || '8453');
export const TOKEN_ADDRESS = String(
  process.env.TOKEN_ADDRESS || '0x07b3d902783c3c12b077508c3b5c00113d1291d0'
).toLowerCase();
export const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL || 'XDP';

// ---------------- 排行榜口径 ----------------
// 有效币对：留空 = 所有币对都计入
export const QUOTE_SYMBOLS = parseList(process.env.VALID_QUOTE_SYMBOLS);
// 是否只统计经 OKX DEX 路由的成交
export const REQUIRE_OKX_ROUTE = truthy(process.env.REQUIRE_OKX_ROUTE, false);
// 入库时是否顺带判定路由（REQUIRE_OKX_ROUTE=1 时自动开）
export const CLASSIFY_ROUTES_ON_SAVE =
  truthy(process.env.CLASSIFY_ROUTES_ON_SAVE, false) || REQUIRE_OKX_ROUTE;

// ⚠️ 已废弃「只统计官方已报名钱包」的口径：官方榜接口只返回 top100，
//    拿不到完整报名名单，用它当白名单会漏掉绝大多数真实参与者。
//    排行口径 = 统计窗口 + 有效币对 + OKX 路由（is_okx=1），所有钱包一视同仁。
//    LAUNCHPOOL_ID 仅保留给采集端拉官方榜做对照，不再参与排行过滤。
export const LAUNCHPOOL_ID = Number(process.env.LAUNCHPOOL_ID || 0);

export const CAMPAIGN_START_UTC = process.env.CAMPAIGN_START_UTC || '';
export const CAMPAIGN_END_UTC = process.env.CAMPAIGN_END_UTC || '';
// 物化表的窗口键（留空时用哨兵值表示"不限制"）
export const WIN_START_SQL = toUtcSql(CAMPAIGN_START_UTC, '1970-01-01 00:00:00');
export const WIN_END_SQL = toUtcSql(CAMPAIGN_END_UTC, '2100-01-01 00:00:00');

// 采集上界：晚于该时间的交易不入库
export const COLLECT_END_MS = parseTime(process.env.COLLECT_END_TIME);

// ---------------- OKX 路由判定（可选口径）----------------
export const OKX_ROUTERS = new Set(
  parseList(process.env.OKX_ROUTERS).map((s) => s.toLowerCase())
);
// OKX DEX 的 dagSwapTo 方法 ID（链上 methodId）
export const OKX_METHOD_IDS = new Set(
  parseList(process.env.OKX_METHOD_IDS || '0x0c307f76').map((s) => s.toLowerCase())
);

export function isOkxTx(to, methodId) {
  const t = String(to || '').toLowerCase();
  const m = String(methodId || '').toLowerCase();
  if (OKX_ROUTERS.size > 0 && OKX_ROUTERS.has(t)) return 1;
  if (OKX_METHOD_IDS.size > 0 && OKX_METHOD_IDS.has(m)) return 1;
  return 0;
}

/**
 * 排行榜的「有效币对」SQL 片段。
 * 返回 { sql, params }，可直接拼进 WHERE。
 */
export function quoteFilterSql(column = 'quote_symbol') {
  if (!QUOTE_SYMBOLS.length) return { sql: '1=1', params: [] };
  return {
    sql: column + ' IN (' + QUOTE_SYMBOLS.map(() => '?').join(',') + ')',
    params: QUOTE_SYMBOLS,
  };
}

/** 排行榜公共 WHERE（与 web/xdp.php 口径一一对应） */
export function rankWhereSql(alias = 't') {
  const parts = [
    alias + '.chain_index = ?',
    alias + '.token_address = ?',
    alias + '.trade_time >= ?',
    alias + '.trade_time < ?',
    alias + '.wallet_is_contract = 0',
  ];
  const params = [CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL];
  const qf = quoteFilterSql(alias + '.quote_symbol');
  parts.push(qf.sql);
  params.push(...qf.params);
  if (REQUIRE_OKX_ROUTE) parts.push(alias + '.is_okx = 1');
  return { sql: parts.join(' AND '), params };
}

// ---------------- 链上实时监听（出块即触发）----------------
export const WATCHER_ENABLED = truthy(process.env.WATCHER_ENABLED, true);
export const WATCHER_WSS = process.env.CHAIN_WSS_URL || 'wss://base-rpc.publicnode.com';
export const WATCHER_POLL_MS = Number(process.env.WATCHER_POLL_MS || 2000);   // WSS 不可用时的兜底轮询
export const WATCHER_CONCURRENCY = Number(process.env.WATCHER_CONCURRENCY || 4); // 并发解析多个块/回执
export const WATCHER_INGEST = truthy(process.env.WATCHER_INGEST, true);       // 链上直采（不等 OKX 索引）
// 直采只处理这些「稳定币计价」的交易对（价格≈1，不需要额外喂价；ETH/WETH 交给 OKX 接口）
export const ONCHAIN_QUOTE = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
};
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ---------------- OKX DEX WebSocket 实时成交（免费、无需 API Key）----------------
//   来源：OKX 网页端自己用的通道（页面内嵌 socketBaseUrls.dexTrade）
//   频道 dex-market-trade-history-pub：公开、实时推送该代币的全市场成交，
//   报文结构与 REST /api/v6/dex/market/trades 完全一致（time→timestamp、type→isBuy）。
//   实测：325~392 笔/分钟，与 REST 最近 100 笔 100% 重叠、0 遗漏。
//   ⚠️ 心跳是**裸字符串** `ping|<nonce>|<timestamp>`（不是 JSON），回 `pong|<nonce>`。
export const WS_TRADES_ENABLED      = truthy(process.env.WS_TRADES_ENABLED, true);
export const WS_TRADES_URL          = process.env.WS_TRADES_URL || 'wss://wsdexpri.okx.com/ws/v5/ipublic';
export const WS_TRADES_CHANNEL      = process.env.WS_TRADES_CHANNEL || 'dex-market-trade-history-pub';
export const WS_TRADES_PING_MS      = Number(process.env.WS_TRADES_PING_MS || 25000);
export const WS_TRADES_RECONNECT_MS = Number(process.env.WS_TRADES_RECONNECT_MS || 10000);
export const WS_TRADES_FLUSH_MS     = Number(process.env.WS_TRADES_FLUSH_MS || 3000);
export const WS_TRADES_FLUSH_MAX    = Number(process.env.WS_TRADES_FLUSH_MAX || 300);
export const WS_TRADES_STALE_MS     = Number(process.env.WS_TRADES_STALE_MS || 120000);

// 周期性「链上重扫」—— 替代原来走 REST 的 recheck（免费）。
//   作用：把最近 N 分钟的区块重扫一遍，捡回
//     ① 采集器停机期间的成交（WSS 补洞上限只有 300 块 = 10 分钟）
//     ② WS 断线/漏推的成交
//   代价：纯 RPC，免费。20 分钟 ≈ 600 块 ≈ 50 秒（实测 12 块/秒）。
export const ONCHAIN_RESCAN_ENABLED = truthy(process.env.ONCHAIN_RESCAN_ENABLED, true);
export const ONCHAIN_RESCAN_MINUTES = Number(process.env.ONCHAIN_RESCAN_MINUTES || 20);
export const CRON_ONCHAIN_RESCAN    = process.env.CRON_ONCHAIN_RESCAN || '*/10 * * * *';

// REST 实时轮询开关：WS 顶上后默认关掉 —— 每月只有 100K 次免费额度，超额 $0.0001/次。
// 需要「官方口径升级」或对账时，把它打开（或手工跑 scripts/recheck-window.js）。
export const REST_REALTIME_ENABLED  = truthy(process.env.REST_REALTIME_ENABLED, !WS_TRADES_ENABLED);

// 入库时只保留「经 OKX DEX 路由」的成交（is_okx = 1），其余直接丢。
//
//   ⚠️ 注意：这不是按官方名单过滤（官方只给 top100，名单不完整，不能用）。
//      判据就是现有的 is_okx —— 和排行/增速看板完全同一个口径。
//
//   为什么划算：WS 推的是全市场 XDP 成交（~390 笔/分钟），但其中只有约 8% 走 OKX 路由；
//      而官方名单里的钱包，成交几乎 100% 走 OKX 路由（实测差 0.002%）。
//      也就是说丢掉的 92% 本来就进不了任何统计。
//
//   ⚠️ 只在 is_okx **确定判为 0** 时丢；判定不出来（NULL，节点没返回）的照常入库，
//      留给 scan-routers 下轮补判 —— 不能因为一次 RPC 抖动就丢掉真实成交。
export const INGEST_ONLY_OKX = truthy(process.env.INGEST_ONLY_OKX, false);

// ---------- OKX 路由上的「函数选择器」----------
// tx.to 都是同一个 OKX 路由，官方活动只认 dagSwapTo，不认 dagSwapByOrderId（订单式成交）。
// 证据（2026-09-29）：is_okx=1 的成交里，官网前 100 有 99 个只用 dagSwapTo、0 个用过 dagSwapByOrderId。
export const DEX_METHOD_SWAP_TO  = '0x0c307f76';   // dagSwapTo —— 官方认
export const DEX_METHOD_BY_ORDER = '0xf2c42696';   // dagSwapByOrderId —— 官方不算

// 入库时是否连「订单式成交」也一起丢掉（只在 INGEST_ONLY_OKX=1 时生效）。
// 它们同样是 OKX 路由成交（is_okx=1），只是官方不计分 —— 留着会白占约一半存储。
export const INGEST_DROP_ORDER_SWAP = truthy(process.env.INGEST_DROP_ORDER_SWAP, true);

export const NATIVE_SYMBOL = process.env.NATIVE_SYMBOL || 'ETH';
export const EXPLORER_TX = process.env.EXPLORER_TX || 'https://basescan.org/tx/';
export const EXPLORER_ADDRESS = process.env.EXPLORER_ADDRESS || 'https://basescan.org/address/';
