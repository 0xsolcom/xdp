// scripts/full-rescan.js
// 完整回溯：把「活动开始 → 现在」这一段重扫一遍，补齐之前遗漏的成交。
//
//   用法：
//     node scripts/full-rescan.js                  # 默认：链上回溯（免费，约 30 分钟）
//     node scripts/full-rescan.js --with-rest      # 再跑一遍 REST 回溯（最准，约 1,300 次调用）
//     node scripts/full-rescan.js --resume         # 从上次断点继续（中断了就用这个）
//     node scripts/full-rescan.js --from 51906726 --to 51929739
//     node scripts/full-rescan.js --chunk 300      # 每批扫多少块（默认 500）
//     node scripts/full-rescan.js --concurrency 3 --delay 200   # 对 RPC 温柔点（默认值）
//
// 同一时刻只允许一个实例（.rescan.lock）：重复启动会直接退出，
// 免得两个回溯同时跑把公共 RPC 打爆、让实时采集 429。
//
// 两条路的分工：
//   ① 链上回溯（scanRange）—— 走公共 RPC，**免费**。覆盖 OKX 路由上的全部成交，
//      包括「第三方代付」的捆绑交易（src/onchain.js 的 parseSwap 已支持）。
//      ⚠️ 代价：要拉两万多个整块，约 30 分钟。
//   ② REST 回溯（fetchTrades）—— 走 OKX 接口，**口径最准**，但每月只有 100K 免费额度。
//      活动 48 小时约 13 万笔 ≈ 1,300 次调用 = 月额度的 1.3%，可以接受。
//      它会用官方口径**覆盖**已有的 ws / onchain 行（saveTrades 的优先级 okx > ws > onchain）。
//
// 幂等：三处都靠唯一键去重，重复跑不会让交易量翻倍，随时中断随时重跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { rpcCall } from '../src/rpc.js';
import { scanRange } from '../src/onchain.js';
import { fetchTrades, paywallActive } from '../src/okx.js';
import { saveTrades } from '../src/save.js';
import { CHAIN_INDEX, TOKEN_ADDRESS, CAMPAIGN_START_UTC, utcDatetime, INGEST_ONLY_OKX } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, '.rescan-state.json');
const LOCK_FILE  = path.join(ROOT, '.rescan.lock');

// ---- 单实例锁 ----
// 教训（2026-09-29）：服务器上曾有一个 full-rescan 在后台跑了 14 分钟没人知道，
// 它用的是改动前的旧代码（不做入库过滤），一边往库里塞「非 OKX」行，
// 一边和采集主进程抢公共 RPC，把实时通道打成 429。
// 所以：同一时刻只允许一个 full-rescan，重复启动直接退出。
(function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const old = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) || 0;
      let alive = false;
      if (old > 0) { try { process.kill(old, 0); alive = true; } catch (e) { alive = false; } }
      if (alive) {
        console.error('❌ 已经有一个 full-rescan 在跑（PID ' + old + '），这次退出。');
        console.error('   同时跑两个会打爆公共 RPC、让实时采集疯狂 429。');
        console.error('   确实要重跑就先停掉它：kill ' + old + '（或删掉 ' + LOCK_FILE + '）');
        process.exit(1);
      }
      console.error('⚠️  发现残留锁文件（PID ' + old + ' 已不存在），继续。');
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) { console.error('⚠️  锁文件写入失败（' + e.message + '），继续，但不防重复启动。'); }
})();
function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) { /* 无所谓 */ }
}
process.on('exit', releaseLock);
process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : d; };
const num = (k, d) => Number(opt(k, d)) || d;

const CHUNK = Math.max(50, num('chunk', 500));
const WITH_REST = flag('with-rest');
const RESUME = flag('resume');
// 并发拉块的默认值调保守了：8 会把公共 RPC（mainnet.base.org）打到 429，
// 连累正在跑的实时采集。要快可以 --concurrency 8，但最好挑采集空闲时段。
const CONC  = Math.max(1, Math.min(16, num('concurrency', 3)));
// 每批之间喘口气，给实时采集让出 RPC
const DELAY = Math.max(0, num('delay', 200));

const WIN_START_MS = Date.parse(CAMPAIGN_START_UTC);
if (!WIN_START_MS) {
  console.error('❌ 没配 CAMPAIGN_START_UTC，无法确定回溯起点');
  process.exit(1);
}

const ts = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log('[' + ts() + ']', ...a);
const hms = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + 'h' : '') + (h || m ? m + 'm' : '') + s + 's';
};
const bar = (done, total) => {
  const w = 30, pct = total ? done / total : 0;
  const fill = Math.round(w * pct);
  return '[' + '█'.repeat(fill) + '░'.repeat(w - fill) + '] ' + (pct * 100).toFixed(1) + '%';
};

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { /* ignore */ } }

async function main() {
  console.log('═'.repeat(74));
  console.log('  XDP 完整回溯（补齐活动期间的遗漏成交）');
  console.log('═'.repeat(74));

  // ---- 算起点区块：拿最新块的 ts 当锚，按 Base 2s/块反推 ----
  const head = await rpcCall('eth_getBlockByNumber', ['latest', false]);
  const headN = Number(BigInt(head.number));
  const headTs = Number(BigInt(head.timestamp));
  const startBlock = num('from', headN - Math.ceil((headTs - WIN_START_MS / 1000) / 2));
  const endBlock = num('to', headN);

  console.log('  活动开始 :', CAMPAIGN_START_UTC);
  console.log('  当前区块 :', headN, '(' + new Date(headTs * 1000).toISOString().slice(0, 19) + 'Z)');
  console.log('  回溯区间 :', startBlock, '→', endBlock, '（' + (endBlock - startBlock) + ' 块 ≈ '
    + ((endBlock - startBlock) * 2 / 3600).toFixed(1) + ' 小时）');
  console.log('  数据源   : 链上（免费）' + (WITH_REST ? ' + REST（准，花额度）' : ''));
  console.log('  入库过滤 :', INGEST_ONLY_OKX
    ? '开启（只入库 is_okx=1；判成非 OKX 的会被 save.js 丢掉，回溯也就不会再塞垃圾进来）'
    : '关闭（全部入库）');
  console.log('  并发/间隔:', CONC + ' / ' + DELAY + 'ms');
  console.log('  状态文件 :', STATE_FILE);
  console.log('═'.repeat(74));
  console.log('');

  let state = RESUME ? loadState() : null;
  if (RESUME && !state) { console.log('没有找到断点，从头开始。'); state = null; }
  let cursor = (state && state.chainDoneTo) ? state.chainDoneTo : startBlock - 1;
  if (cursor >= startBlock) log('链上回溯：从断点 ' + cursor + ' 继续');

  // ---- ① 链上回溯（分批，可中断可续跑）----
  if (cursor < endBlock) {
    const t0 = Date.now();
    let scanned = 0, hits = 0, ingested = 0, failed = 0;
    const total = endBlock - cursor;
    log('① 链上回溯开始：' + total + ' 块，每批 ' + CHUNK + ' 块');
    for (let from = cursor + 1; from <= endBlock; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, endBlock);
      let r;
      try { r = await scanRange(from, to, { verbose: false, concurrency: CONC }); }
      catch (e) { console.error('  批 ' + from + '~' + to + ' 异常：' + e.message); r = { scanned: 0, hits: 0, ingested: 0, failed: to - from + 1 }; }
      scanned += r.scanned; hits += r.hits; ingested += r.ingested; failed += r.failed;
      cursor = to;
      saveState({ chainDoneTo: cursor, startBlock, endBlock, updatedAt: new Date().toISOString() });
      if (DELAY) await new Promise((ok) => setTimeout(ok, DELAY));   // 给实时采集让出 RPC
      const el = (Date.now() - t0) / 1000;
      const done = cursor - (startBlock - 1);
      const eta = (el / Math.max(1, done)) * (total - done);
      const text = bar(done, total) + '  块 ' + cursor + '/' + endBlock
        + '  命中 ' + hits + '  入库 ' + ingested + (failed ? ('  失败 ' + failed) : '') + '  剩余 ~' + hms(eta);
      // 终端里用回车原地刷新；重定向到文件/nohup 时回车没效果，改成每 10 批打一行，免得堆成一坨
      if (process.stdout.isTTY) process.stdout.write('\r  ' + text + '    ');
      else if (done % (CHUNK * 10) < CHUNK || cursor >= endBlock) console.log('  ' + text);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
    console.log('');
    log('① 链上回溯完成：扫 ' + scanned + ' 块 / 命中路由 ' + hits + ' / 新入库 ' + ingested
      + ' / 失败 ' + failed + '   用时 ' + hms((Date.now() - t0) / 1000));
  } else {
    log('① 链上回溯：已完成（断点 ' + cursor + ' ≥ ' + endBlock + '）');
  }

  // ---- ② REST 回溯（可选，最准）----
  if (WITH_REST) {
    if (paywallActive()) {
      console.log('');
      console.warn('② REST 回溯：当前正处于 402 付费墙冷却期，跳过。等冷却结束再跑一次 --with-rest 即可。');
    } else {
      console.log('');
      const t0 = Date.now();
      let after = null, pages = 0, fetched = 0, added = 0, stopped = '';
      const MAX_PAGES = Math.max(1, num('max-pages', 5000));
      log('② REST 回溯开始：从最新往回翻，直到翻过活动起点');
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = { chainIndex: CHAIN_INDEX, tokenContractAddress: TOKEN_ADDRESS, limit: '100' };
        if (after) params.after = after;
        let data;
        try { data = await fetchTrades(params); }
        catch (e) {
          console.error('  第 ' + page + ' 页失败：' + e.message);
          stopped = '接口异常'; break;
        }
        const list = data.data || [];
        if (!list.length) { stopped = '翻到头了'; break; }
        fetched += list.length;
        try { added += await saveTrades(CHAIN_INDEX, TOKEN_ADDRESS, list, { source: 'okx' }); }
        catch (e) { console.error('  第 ' + page + ' 页写库失败：' + e.message); }
        pages++;
        after = list[list.length - 1].id;
        const oldest = Math.min(...list.map((x) => Number(x.time) || Infinity));
        if (pages % 10 === 0 || oldest < WIN_START_MS) {
          process.stdout.write('\r  已翻 ' + pages + ' 页 / 取 ' + fetched + ' 笔 / 新增 ' + added
            + '  最老 ' + new Date(oldest).toISOString().slice(0, 19) + 'Z    ');
          if (process.stdout.isTTY === false) process.stdout.write('\n');
        }
        if (oldest < WIN_START_MS) { stopped = '已翻过活动起点'; break; }
        if (list.length < 100) { stopped = '不足一页，到底了'; break; }
      }
      console.log('');
      log('② REST 回溯完成：' + pages + ' 页 / 取 ' + fetched + ' 笔 / 新增 ' + added
        + '   用时 ' + hms((Date.now() - t0) / 1000) + (stopped ? '   （' + stopped + '）' : ''));
    }
  }

  // ---- ③ 刷新排行 ----
  console.log('');
  log('③ 刷新排行榜物化表…');
  try {
    const { refreshRank } = await import('./refresh-rank.js');
    await refreshRank({ verbose: true });
  } catch (e) {
    console.error('  刷新失败（不影响数据）：' + e.message);
  }

  // ---- ④ 收尾统计 ----
  await pool.query("SET time_zone='+00:00'");
  const [[w]] = await pool.query(
    'SELECT COUNT(*) n, COUNT(DISTINCT wallet_address) w, ROUND(SUM(volume_usd),2) v, MIN(trade_time) t0, MAX(trade_time) t1 FROM trades WHERE trade_time >= ?',
    [utcDatetime(WIN_START_MS)]
  );
  const [g] = await pool.query(
    'SELECT source, COUNT(*) n, ROUND(SUM(volume_usd),2) v FROM trades WHERE trade_time >= ? GROUP BY source ORDER BY n DESC',
    [utcDatetime(WIN_START_MS)]
  );
  console.log('');
  console.log('═'.repeat(74));
  log('回溯完成。窗口内共 ' + w.n + ' 笔 / ' + w.w + ' 个钱包 / $' + w.v);
  log('  时间范围 ' + w.t0.toISOString().slice(0, 19) + 'Z ~ ' + w.t1.toISOString().slice(0, 19) + 'Z');
  console.log('  各来源：');
  for (const x of g) console.log('    ' + String(x.source).padEnd(9) + String(x.n).padStart(7) + ' 笔  $' + x.v);
  console.log('');
  console.log('  下一步建议：跑一次对账看还有没有漏');
  console.log('    node scripts/reconcile-official.js 100');
  console.log('═'.repeat(74));
  await pool.end();
}

main().catch(async (e) => { console.error('❌ ' + (e.stack || e.message)); try { await pool.end(); } catch (_) {} process.exit(1); });
