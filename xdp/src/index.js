import { readFileSync } from 'node:fs';
import cron from 'node-cron';

// 版本号统一从 package.json 读，别在代码里手写（改了 package.json 就自动生效）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { runRealtime } from './realtime.js';
import { runBackfill } from './backfill.js';
import { scanContracts } from '../scripts/scan-contracts.js';
import { scanRouters } from '../scripts/scan-routers.js';
import { refreshRank } from '../scripts/refresh-rank.js';
import { recheckWindow } from '../scripts/recheck-window.js';
import { pollLaunchpool } from '../scripts/poll-launchpool.js';
import { pool } from './db.js';
import { startWatcher, watcherStats, scanRange } from './onchain.js';
import { rpcCall } from './rpc.js';
import { startWsTrades, wsStats } from './ws-trades.js';
import { paywallActive } from './okx.js';
import {
  CHAIN_INDEX, TOKEN_ADDRESS, REQUIRE_OKX_ROUTE, WATCHER_ENABLED,
  WS_TRADES_ENABLED, REST_REALTIME_ENABLED,
  ONCHAIN_RESCAN_ENABLED, ONCHAIN_RESCAN_MINUTES, CRON_ONCHAIN_RESCAN, INGEST_ONLY_OKX,
  WIN_START_SQL, WIN_END_SQL, CAMPAIGN_START_UTC, CAMPAIGN_END_UTC,
} from './config.js';

const CRON_REALTIME  = process.env.CRON_REALTIME || '*/10 * * * * *';
const CRON_BACKFILL  = process.env.CRON_BACKFILL || '*/20 * * * * *';
const CRON_CONTRACTS = process.env.CRON_CONTRACTS || '*/5 * * * *';
const CRON_ROUTERS   = process.env.CRON_ROUTERS || '*/20 * * * * *';
const CRON_RANK      = process.env.CRON_RANK || '*/10 * * * * *';
const CRON_POLL      = process.env.CRON_POLL || '0 * * * * *';
// 周期性增量回溯：把最近 N 分钟重扫一遍，捡回接口「晚索引」的成交
const CRON_RECHECK    = process.env.CRON_RECHECK || '*/10 * * * *';
const RECHECK_MINUTES = Number(process.env.RECHECK_MINUTES || 120);
const LAUNCHPOOL_ID  = Number(process.env.LAUNCHPOOL_ID || 0);

console.log('🚀 XDP（Doppler Finance）采集程序  v' + VERSION + '  启动');
console.log('   版本    :', 'v' + VERSION);
console.log('   链      :', CHAIN_INDEX, '(8453 = Base)');
console.log('   代币    :', TOKEN_ADDRESS);
// 统计窗口：这是整个口径的根基，启动时打出来方便随时核对
//   UTC+8 = UTC + 8 小时；页面显示的是 UTC+8，配置存的是 UTC，两边必须一致
console.log('   统计窗口:', WIN_START_SQL + ' ~ ' + WIN_END_SQL + ' (UTC)   = '
  + (CAMPAIGN_START_UTC || '?') + ' ~ ' + (CAMPAIGN_END_UTC || '?'));
console.log('   实时    :', CRON_REALTIME);
console.log('   回溯    :', CRON_BACKFILL);
console.log('   合约检测:', CRON_CONTRACTS);
console.log('   路由口径:', REQUIRE_OKX_ROUTE ? '开启（只算 OKX 路由成交）' : '关闭（全部成交）');
console.log('   入库过滤:', INGEST_ONLY_OKX ? '开启（只入库 is_okx=1 的成交，判定不出才留 NULL）' : '关闭（全部入库）');
console.log('   排行刷新:', CRON_RANK);
console.log('   官方采样:', LAUNCHPOOL_ID ? CRON_POLL : '未启用（LAUNCHPOOL_ID 未配置）');
console.log('   链上监听:', WATCHER_ENABLED ? '开启（出块即触发 + 直采）' : '关闭');
console.log('   成交 WS :', WS_TRADES_ENABLED ? '开启（免费实时推送，主力）' : '关闭');
console.log('   REST实时:', REST_REALTIME_ENABLED ? '开启（注意每月 100K 免费额度）' : '关闭（WS 已顶上，省额度）');
console.log('   链上重扫:', ONCHAIN_RESCAN_ENABLED ? (CRON_ONCHAIN_RESCAN + '  最近 ' + ONCHAIN_RESCAN_MINUTES + ' 分钟（免费兜底）') : '关闭');
console.log('   增量重扫:', REST_REALTIME_ENABLED
  ? (CRON_RECHECK + '（最近 ' + RECHECK_MINUTES + ' 分钟，走 REST 会花额度）')
  : ('已停用（改由上面的链上重扫承担，免费）'));

let realtimeRunning = false;
let backfillRunning = false;
let scanRunning = false;
let scanRouterRunning = false;
let rankRunning = false;
let pollRunning = false;
let recheckRunning = false;
let rescanRunning = false;

async function safeRefreshRank() {
  if (rankRunning) return;
  rankRunning = true;
  try {
    await refreshRank({ verbose: false });
  } catch (e) {
    console.error('[排行刷新异常]', e.message);
  } finally {
    rankRunning = false;
  }
}

async function safeRealtime() {
  if (!REST_REALTIME_ENABLED) return;   // WS 顶上后默认关掉 REST 轮询，省每月 100K 的免费额度
  if (realtimeRunning) return;
  realtimeRunning = true;
  try {
    const r = await runRealtime();
    if (r && r.totalNew > 0) await safeRefreshRank(); // 有新数据立刻刷新排行
  } catch (e) {
    console.error('[实时异常]', e);
  } finally {
    realtimeRunning = false;
  }
}

async function safeBackfill() {
  if (backfillRunning) { console.log('[回溯] 上一轮还在运行，跳过'); return; }
  backfillRunning = true;
  try {
    await runBackfill({ verbose: false });   // 定时跑就安静点，别每 20 秒刷一行
  } catch (e) {
    console.error('[回溯异常]', e);
  } finally {
    backfillRunning = false;
  }
}

async function safeRecheck() {
  // recheck 走 REST（拉最近 RECHECK_MINUTES 分钟），每次 ≈ 数百次调用。
  // WS 顶上后它既没必要又特别费额度（每 10 分钟一轮 ≈ 4.6 万次/天），一并跟着 REST 开关走。
  if (!REST_REALTIME_ENABLED) return;
  if (recheckRunning) return;
  recheckRunning = true;
  try {
    const r = await recheckWindow({ minutes: RECHECK_MINUTES, verbose: false });
    if (r && r.added > 0) {
      console.log('[重扫] 补回 ' + r.added + ' 条（接口晚索引）');
      await safeRefreshRank();
    }
  } catch (e) {
    console.error('[重扫异常]', e.message);
  } finally {
    recheckRunning = false;
  }
}

/**
 * 周期性链上重扫（免费）—— 替代原来走 REST 的 recheck。
 *
 * 为什么必须有它：WS 只推「连上之后」的成交，链上监听也只处理新块（启动回看 3 块、
 * 断线补洞上限 300 块 = 10 分钟）。采集器一旦停机超过 10 分钟，中间那段就再也没人补。
 * 原来靠 REST recheck 兜底，但那条每 10 分钟要拉 120 分钟数据 ≈ 4.6 万次调用/天，
 * 100K/月 的额度撑不住 —— 换成走公共 RPC 的链上重扫，覆盖一样、成本为零。
 */
async function safeOnchainRescan() {
  if (!ONCHAIN_RESCAN_ENABLED) return;
  if (rescanRunning) return;
  rescanRunning = true;
  try {
    const latest = Number(BigInt(await rpcCall('eth_blockNumber', [])));
    const blocks = Math.ceil((ONCHAIN_RESCAN_MINUTES * 60) / 2);   // Base ≈ 2s/块
    const r = await scanRange(latest - blocks, latest, { verbose: false, concurrency: 6 });
    if (r.ingested > 0) {
      console.log('[链上重扫] 最近 ' + ONCHAIN_RESCAN_MINUTES + ' 分钟：扫 ' + r.scanned + ' 块 / 命中路由 '
        + r.hits + ' / 补回 ' + r.ingested + ' 笔' + (r.failed ? (' / 失败 ' + r.failed) : ''));
      await safeRefreshRank();
    }
  } catch (e) {
    console.error('[链上重扫异常]', e.message);
  } finally {
    rescanRunning = false;
  }
}

async function safeScanContracts() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    await scanContracts({ verbose: false });
  } catch (e) {
    console.error('[合约检测异常]', e.message);
  } finally {
    scanRunning = false;
  }
}

async function safeScanRouters() {
  if (!REQUIRE_OKX_ROUTE) return; // 用不到就不白打接口
  if (scanRouterRunning) return;
  scanRouterRunning = true;
  try {
    const r = await scanRouters({ verbose: false });
    if (r && r.scanned > 0) await safeRefreshRank();
  } catch (e) {
    console.error('[路由判定异常]', e.message);
  } finally {
    scanRouterRunning = false;
  }
}

async function safePollLaunchpool() {
  if (!LAUNCHPOOL_ID) return;
  if (pollRunning) return;
  pollRunning = true;
  try {
    await pollLaunchpool({ verbose: false });
  } catch (e) {
    console.error('[榜单采样异常]', e.message);
  } finally {
    pollRunning = false;
  }
}

// 启动先各跑一次
safeRealtime();
safeBackfill();
safeRecheck();
safeScanContracts();
safeScanRouters();
safeRefreshRank();
safePollLaunchpool();

cron.schedule(CRON_REALTIME, safeRealtime, { noOverlap: true });

// 链上实时通道：订阅 Base 新区块，出块即触发一次刷新
//
// ⚠️ 2026-09-29：onActivity 原来无条件调 safeRealtime()。但出块里只要含路由交易就会触发，
// 实测 100 个块触发 43 次 ≈ 每 5 秒一次，把 CRON_REALTIME 完全压过去了 ——
// 接口被付费墙挡住时就是每 5 秒白跑一次 + 刷一行日志。
// 现在：① 付费墙期间直接跳过接口调用；② 排行刷新做节流，别每个块都重算一次全表 GROUP BY。
const ACTIVITY_MIN_MS = Number(process.env.ACTIVITY_MIN_MS || 5000);
let lastActivityAt = 0;
async function onChainActivity() {
  if (!paywallActive()) await safeRealtime();          // 接口还能用才去拉
  const now = Date.now();
  if (now - lastActivityAt < ACTIVITY_MIN_MS) return;  // 排行刷新节流
  lastActivityAt = now;
  await safeRefreshRank();
}

// 成交 WebSocket：免费实时推送，现在是成交主力来源（REST 太贵、链上直采有盲区）
if (WS_TRADES_ENABLED) startWsTrades();

if (WATCHER_ENABLED) {
  startWatcher({ onActivity: onChainActivity })
    .catch((e) => console.error('[链上] 启动失败:', e.message));
}
cron.schedule(CRON_BACKFILL, safeBackfill, { noOverlap: true });
cron.schedule(CRON_ONCHAIN_RESCAN, safeOnchainRescan, { noOverlap: true });
cron.schedule(CRON_CONTRACTS, safeScanContracts, { noOverlap: true });
cron.schedule(CRON_ROUTERS, safeScanRouters, { noOverlap: true });
cron.schedule(CRON_RANK, safeRefreshRank, { noOverlap: true });
cron.schedule(CRON_RECHECK, safeRecheck, { noOverlap: true });
if (LAUNCHPOOL_ID) cron.schedule(CRON_POLL, safePollLaunchpool, { noOverlap: true });

process.on('SIGINT', async () => {
  console.log('\n退出中...');
  await pool.end();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
