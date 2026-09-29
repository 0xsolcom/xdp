// scripts/scan-routers.js
// 判定每一笔链上交易是否通过 OKX DEX 路由（eth_getTransactionByHash / OKX Explorer 的 to + methodId）。
//
// 仅在 REQUIRE_OKX_ROUTE=1 时才有意义（活动口径：只统计经 OKX 路由的成交）。
// 结果写入独立表 okx_route：is_okx=1 经 OKX 路由，0 非 OKX；不在表里的视为「尚未判定」。
import { pool } from '../src/db.js';
import { fetchTxMulti } from '../src/okx.js';
import { rpcBatch } from '../src/rpc.js';
import { CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL, isOkxTx, OKX_ROUTERS, OKX_METHOD_IDS, INGEST_ONLY_OKX, INGEST_DROP_ORDER_SWAP, DEX_METHOD_BY_ORDER } from '../src/config.js';
import axios from 'axios';

const USE_OKX_API = String(process.env.ROUTER_USE_OKX_API ?? '1') !== '0';
const CHUNK       = Number(process.env.ROUTER_CHUNK || 20);
const CONCURRENCY = Number(process.env.ROUTER_CONCURRENCY || 3);
const WINDOW_ONLY = String(process.env.ROUTER_SCAN_WINDOW_ONLY ?? '1') !== '0';

async function ensureSchema() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS okx_route (' +
    '  tx_hash    VARCHAR(255) NOT NULL,' +
    '  router     VARCHAR(64)  DEFAULT NULL,' +
    '  method_id  VARCHAR(16)  DEFAULT NULL,' +
    '  is_okx     TINYINT(1)   NOT NULL DEFAULT 0,' +
    '  checked_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
    '  PRIMARY KEY (tx_hash),' +
    '  KEY idx_is_okx (is_okx),' +
    '  KEY idx_router (router)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
  );
}

/** 兜底：JSON-RPC 批量拉交易 */
async function batchGetTx(rpcUrl, hashes) {
  const body = hashes.map((h, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getTransactionByHash', params: [h] }));
  const res = await axios.post(rpcUrl, body, { timeout: 30000 });
  const map = new Map();
  if (Array.isArray(res.data)) {
    for (const item of res.data) {
      if (item && typeof item.id === 'number') map.set(hashes[item.id], item.result || null);
    }
  }
  return map;
}

export async function scanRouters({ verbose = true, max = 0 } = {}) {
  const RPC_URL = process.env.CHAIN_RPC_URL;
  if (!RPC_URL) throw new Error('请在 .env 配置 CHAIN_RPC_URL');

  await ensureSchema();

  // 自愈：okx_route 已有结论、但 trades.is_okx 仍是 NULL 的行
  //
  // ⚠️ 2026-09-29：这里以前是「SET t.is_okx = r.is_okx」，会把**已判明不是 OKX 的行补成 0 留在库里**。
  //    入库过滤（INGEST_ONLY_OKX=1）开着时，这类行本来就不该存在 —— 它们是入库那一刻
  //    节点没返回、被迫先存成 NULL 的，现在判明了就该删掉。否则每 20 秒一次的兜底
  //    会持续往库里漏「非 OKX」行（实测就是这么漏进 4 笔的）。
  let healed = 0;
  try {
    if (INGEST_ONLY_OKX) {
      const [h1] = await pool.query(
        'UPDATE trades t JOIN okx_route r ON r.tx_hash = t.tx_hash SET t.is_okx = 1 ' +
        'WHERE t.is_okx IS NULL AND r.is_okx = 1 AND t.chain_index = ? AND t.token_address = ?',
        [CHAIN_INDEX, TOKEN_ADDRESS]
      );
      // 清掉所有「官方不计分」的行：
      //   ① is_okx = 0（非 OKX 路由，含旧的兜底逻辑标 0 留下来的）
      //   ② r.is_okx = 0 且 t.is_okx IS NULL（刚判明非 OKX）
      //   ③ ★ method = dagSwapByOrderId 的行 —— 关键的一条：
      //      入库那一刻节点没返回 → 按设计存成 NULL → 这里才补判出来，
      //      走的是 SET is_okx = 1，**绕过了 save.js 的 method 过滤**。
      //      实测就是这样漏进 84 笔（全是 source='ws'）。
      // 只删「订单式」那一类，dagSwapTo 的行一根汗毛都不动。
      const orderCond = INGEST_DROP_ORDER_SWAP ? ' OR (r.method_id = ? AND (t.is_okx IS NULL OR t.is_okx = 1))' : '';
      const orderParams = INGEST_DROP_ORDER_SWAP ? [DEX_METHOD_BY_ORDER] : [];
      const [h0] = await pool.query(
        'DELETE t FROM trades t LEFT JOIN okx_route r ON r.tx_hash = t.tx_hash ' +
        'WHERE t.chain_index = ? AND t.token_address = ? ' +
        '  AND (t.is_okx = 0 OR (t.is_okx IS NULL AND r.is_okx = 0)' + orderCond + ')',
        [CHAIN_INDEX, TOKEN_ADDRESS, ...orderParams]
      );
      healed = h1.affectedRows || 0;
      if (h0.affectedRows) {
        console.log('[路由] 清掉 ' + h0.affectedRows + ' 笔「非 OKX」行（入库过滤开启，本就不该留）');
      }
    } else {
      const [hr] = await pool.query(
        'UPDATE trades t JOIN okx_route r ON r.tx_hash = t.tx_hash SET t.is_okx = r.is_okx ' +
        'WHERE t.is_okx IS NULL AND t.chain_index = ? AND t.token_address = ?',
        [CHAIN_INDEX, TOKEN_ADDRESS]
      );
      healed = hr.affectedRows || 0;
    }
  } catch (e) { /* 不影响主流程 */ }

  let sql =
    'SELECT DISTINCT t.tx_hash FROM trades t LEFT JOIN okx_route r ON r.tx_hash = t.tx_hash ' +
    "WHERE r.tx_hash IS NULL AND t.tx_hash IS NOT NULL AND t.tx_hash <> '' AND t.chain_index = ? AND t.token_address = ?";
  const params = [CHAIN_INDEX, TOKEN_ADDRESS];
  if (WINDOW_ONLY) { sql += ' AND t.trade_time >= ? AND t.trade_time < ?'; params.push(WIN_START_SQL, WIN_END_SQL); }
  if (max > 0) sql += ' LIMIT ' + Number(max);
  const [rows] = await pool.query(sql, params);
  const todo = rows.map((r) => r.tx_hash);

  if (verbose) {
    console.log('=== OKX 路由扫描 ===');
    console.log('OKX 路由地址:', OKX_ROUTERS.size ? [...OKX_ROUTERS].join(', ') : '(未配置，按 methodId 判定)');
    console.log('OKX 方法 ID :', [...OKX_METHOD_IDS].join(', '));
    console.log('待判定 tx :', todo.length, healed ? ('（自愈补同步 ' + healed + ' 行）') : '');
  }

  const routerTally = new Map();
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));

  async function classify(chunk) {
    if (USE_OKX_API) {
      try {
        const map = await fetchTxMulti(chunk, CHAIN_INDEX);
        const out = [];
        for (const h of chunk) {
          const it = map.get(String(h).toLowerCase());
          if (!it) continue;
          const to = String(it.to || '').toLowerCase();
          const methodId = String(it.methodId || '').toLowerCase();
          routerTally.set(to, (routerTally.get(to) || 0) + 1);
          out.push([h, to || null, methodId || null, isOkxTx(to, methodId)]);
        }
        if (out.length) return out;
      } catch (e) { /* 落 RPC */ }
    }
    // ★ 用 src/rpc.js 的 rpcBatch：内部做了「批量完整性校验 + 单条兜底」。
    //   原来的 batchGetTx 直接发 CHUNK=20 条批量，而 base.org 只回 1 条、
    //   drpc 免费版直接拒绝 >3 条 —— 会导致整批静默漏判（返回空数组，看不出错）。
    const txs = await rpcBatch(chunk.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    const out = [];
    for (let j = 0; j < chunk.length; j++) {
      const tx = txs[j];
      if (!tx || !tx.hash) continue;      // 查不到就不判定，留 NULL 下轮再试
      const h = chunk[j];
      const to = String(tx.to || '').toLowerCase();
      const methodId = String(tx.input || '').slice(0, 10).toLowerCase();
      routerTally.set(to, (routerTally.get(to) || 0) + 1);
      out.push([h, to || null, methodId || null, isOkxTx(to, methodId)]);
    }
    return out;
  }

  let ok = 0, fail = 0, done = 0, ci = 0;
  async function worker() {
    while (ci < chunks.length) {
      const my = ci++;
      const chunk = chunks[my];
      try {
        const out = await classify(chunk);
        if (out.length) {
          await pool.query(
            'INSERT INTO okx_route (tx_hash, router, method_id, is_okx) VALUES ? ' +
            'ON DUPLICATE KEY UPDATE router = VALUES(router), method_id = VALUES(method_id), is_okx = VALUES(is_okx)',
            [out]
          );
          const okxH = [], noH = [];
          for (const r of out) (r[3] === 1 ? okxH : noH).push(r[0]);
          if (okxH.length) await pool.query('UPDATE trades SET is_okx = 1 WHERE tx_hash IN (?)', [okxH]);
          if (noH.length) {
            // 入库过滤开着 → 非 OKX 的行直接清掉，别标 0 留在库里。
            // 只删 is_okx IS NULL 的：已经判成 1、且已计入排行的行绝不在这里动，否则会改掉榜单总量。
            if (INGEST_ONLY_OKX) {
              await pool.query('DELETE FROM trades WHERE tx_hash IN (?) AND is_okx IS NULL', [noH]);
            } else {
              await pool.query('UPDATE trades SET is_okx = 0 WHERE tx_hash IN (?)', [noH]);
            }
          }
          ok += out.length;
        }
      } catch (e) { fail += chunk.length; }
      done += chunk.length;
      if (verbose && (done % 500) < CHUNK) process.stdout.write('\r进度 ' + Math.min(done, todo.length) + '/' + todo.length + '  成功 ' + ok + '  失败 ' + fail);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (verbose) process.stdout.write('\n');

  const [[stat]] = await pool.query('SELECT SUM(is_okx=1) AS okx, SUM(is_okx=0) AS other, COUNT(*) AS total FROM okx_route');
  if (verbose) {
    console.log('本轮: 成功 ' + ok + ' 失败 ' + fail);
    console.log('okx_route 累计: OKX ' + Number(stat.okx || 0) + ' / 非OKX ' + Number(stat.other || 0) + ' / 共 ' + Number(stat.total || 0));
    if (routerTally.size) {
      console.log('本轮出现的路由地址（频率降序）:');
      [...routerTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
        .forEach(([r, n]) => console.log('   ' + (r || '(空)') + '  ' + n + ' 笔'));
    }
  }
  return { scanned: todo.length, ok, fail, okxTx: Number(stat.okx || 0), otherTx: Number(stat.other || 0), routerTally: Object.fromEntries(routerTally) };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  scanRouters().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}
