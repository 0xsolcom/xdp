// scripts/status.js
// 打印采集状态：进程无关，只读数据库 + 游标 + 物化快照 + Top10。
// 用法: node scripts/status.js   （或 ./status.sh）
import { pool } from '../src/db.js';
import { CHAIN_INDEX, TOKEN_ADDRESS, TOKEN_SYMBOL, WIN_START_SQL, WIN_END_SQL } from '../src/config.js';

const tok = TOKEN_ADDRESS;

try {
  const [[info]] = await pool.query('SELECT DATABASE() AS db');
  console.log('数据库    :', info.db);
  console.log('代币      :', TOKEN_SYMBOL, tok, '(chain ' + CHAIN_INDEX + ')');

  const [[tr]] = await pool.query(
    'SELECT COUNT(*) AS n, COALESCE(SUM(volume_usd),0) AS v, MIN(trade_time) AS mn, MAX(trade_time) AS mx FROM trades'
  );
  console.log('明细      :', Number(tr.n), '笔 / $' + Number(tr.v).toFixed(2) +
    (tr.mn ? '   时间 ' + tr.mn.toISOString().slice(0, 19).replace('T', ' ') + ' ~ ' + tr.mx.toISOString().slice(0, 19).replace('T', ' ') + ' (UTC)' : ''));

  const [[wa]] = await pool.query(
    'SELECT COUNT(DISTINCT wallet_address) AS n, COALESCE(SUM(volume_usd),0) AS v FROM trades'
  );
  console.log('钱包      :', Number(wa.n), '个 / $' + Number(wa.v).toFixed(2));

  const [[cc]] = await pool.query(
    'SELECT SUM(is_contract=1) AS c, SUM(is_contract=0) AS e, COUNT(*) AS t FROM contract_check'
  );
  console.log('合约检测  :', Number(cc.c || 0), '个合约 /', Number(cc.e || 0), '个 EOA（共检测', Number(cc.t || 0), '）');

  const [cur] = await pool.query(
    'SELECT last_after, is_initialized, total_backfilled FROM crawl_cursor WHERE chain_index = ? AND token_address = ?',
    [CHAIN_INDEX, tok]
  );
  console.log('回溯游标  :', cur.length
    ? ('initialized=' + cur[0].is_initialized + ' backfilled=' + cur[0].total_backfilled + ' last_after=' + (cur[0].last_after === null ? 'null' : cur[0].last_after))
    : '(未开始)');

  const [metaRows] = await pool.query(
    'SELECT wallet_count, tx_count, volume_usd, updated_at FROM rank_meta WHERE chain_index = ? AND token_address = ? AND win_start = ? AND win_end = ? LIMIT 1',
    [CHAIN_INDEX, tok, WIN_START_SQL, WIN_END_SQL]
  );
  if (metaRows.length) {
    const m = metaRows[0];
    console.log('物化快照  :', m.wallet_count, '钱包 /', m.tx_count, '笔 / $' + Number(m.volume_usd).toFixed(2) +
      '   刷新于 ' + (m.updated_at ? m.updated_at.toISOString().slice(0, 19).replace('T', ' ') + ' (UTC)' : '-'));
  } else {
    console.log('物化快照  : (尚未刷新，跑一次 npm run rank:refresh)');
  }

  const [top] = await pool.query(
    'SELECT wallet_address, CAST(volume_usd AS CHAR) AS v, tx_count, rank_no FROM wallet_rank ORDER BY rank_no LIMIT 10'
  );
  console.log('');
  console.log('前 10 名（物化表）:');
  for (const r of top) {
    console.log('  #' + String(r.rank_no).padStart(3), r.wallet_address, '$' + Number(r.v).toFixed(2).padStart(12), r.tx_count + ' 笔');
  }
} catch (e) {
  console.log('读取失败:', e.message);
}
await pool.end().catch(() => {});
