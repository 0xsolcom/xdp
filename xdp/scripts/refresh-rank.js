// scripts/refresh-rank.js
// 把统计窗口的排行榜物化成 wallet_rank + rank_meta 两张表。
//
// 为什么要物化：
//   页面口径要对 trades 做 GROUP BY 并 JOIN 过滤，单次要扫全窗口；
//   排行榜每 10 秒刷一次，这个成本不该每个用户重复付。
//   采集程序后台刷新物化表，页面直接读索引 → 毫秒级。
//
// 口径（与 web/xdp.php 完全一致，统一来自 src/config.js 的 rankWhereSql）：
//   统计窗口 + 有效币对 + 排除合约地址 +（可选）只保留 OKX 路由
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

// 采集器版本：看板会从 rank_meta.collector_version 读它（这样看板不需要任何文件依赖）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import {
  CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL, rankWhereSql,
} from '../src/config.js';

export async function refreshRank({ verbose = true } = {}) {
  // 口径：统计窗口 + 有效币对 + OKX 路由（is_okx=1）。
  // 不再按「官方已报名钱包」白名单过滤 —— 官方只公开 top100，名单不完整。
  const where = rankWhereSql('t');

  const [rows] = await pool.query(
    `SELECT t.wallet_address AS w,
            CAST(SUM(t.volume_usd) AS CHAR) AS v,
            CAST(SUM(CASE WHEN t.type = 'buy'  THEN t.volume_usd ELSE 0 END) AS CHAR) AS bv,
            CAST(SUM(CASE WHEN t.type = 'sell' THEN t.volume_usd ELSE 0 END) AS CHAR) AS sv,
            COUNT(*) AS n,
            CAST(SUM(t.type = 'buy')  AS CHAR) AS bn,
            CAST(SUM(t.type = 'sell') AS CHAR) AS sn,
            DATE_FORMAT(MIN(t.trade_time), '%Y-%m-%d %H:%i:%s') AS ft,
            DATE_FORMAT(MAX(t.trade_time), '%Y-%m-%d %H:%i:%s') AS lt
       FROM trades t
      WHERE ${where.sql}
      GROUP BY t.wallet_address
      ORDER BY SUM(t.volume_usd) DESC, t.wallet_address ASC`,
    where.params
  );

  const vals = [];
  const pars = [];
  let rank = 0, vol = 0, buyVol = 0, sellVol = 0, tx = 0, first = null, last = null;
  for (const r of rows) {
    rank++;
    const v = Number(r.v || 0);
    const bv = Number(r.bv || 0);
    const sv = Number(r.sv || 0);
    vol += v; buyVol += bv; sellVol += sv;
    tx += Number(r.n || 0);
    if (r.ft && (!first || r.ft < first)) first = r.ft;
    if (r.lt && (!last || r.lt > last)) last = r.lt;
    vals.push('(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    pars.push(
      CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL, r.w,
      v, bv, sv, Number(r.n || 0), Number(r.bn || 0), Number(r.sn || 0),
      rank, r.ft, r.lt
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 一个 链+代币 只保留当前窗口的一份物化数据
    // （窗口改过之后，旧窗口的 rank_meta 行必须一起删，否则概览会读到过期汇总）
    await conn.query(
      'DELETE FROM wallet_rank WHERE chain_index = ? AND token_address = ?',
      [CHAIN_INDEX, TOKEN_ADDRESS]
    );
    await conn.query(
      'DELETE FROM rank_meta WHERE chain_index = ? AND token_address = ?',
      [CHAIN_INDEX, TOKEN_ADDRESS]
    );
    if (vals.length) {
      await conn.query(
        'INSERT INTO wallet_rank ' +
        '(chain_index, token_address, win_start, win_end, wallet_address, volume_usd, buy_volume, sell_volume, tx_count, buy_count, sell_count, rank_no, first_trade_at, last_trade_at) VALUES ' +
        vals.join(','), pars
      );
    }
    await conn.query(
      'INSERT INTO rank_meta (chain_index, token_address, win_start, win_end, wallet_count, tx_count, volume_usd, buy_volume, sell_volume, first_trade_at, last_trade_at, collector_version, updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW()) ' +
      'ON DUPLICATE KEY UPDATE wallet_count=VALUES(wallet_count), tx_count=VALUES(tx_count), volume_usd=VALUES(volume_usd), ' +
      'buy_volume=VALUES(buy_volume), sell_volume=VALUES(sell_volume), first_trade_at=VALUES(first_trade_at), ' +
      'last_trade_at=VALUES(last_trade_at), collector_version=VALUES(collector_version), updated_at=NOW()',
      [CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL, rank, tx, vol, buyVol, sellVol, first, last, VERSION]
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  if (verbose) console.log('[排行] 已刷新 ' + rank + ' 个钱包 / ' + tx + ' 笔 / $' + vol.toFixed(2));
  return { wallets: rank, txCount: tx, volume: vol, buyVolume: buyVol, sellVolume: sellVol };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  refreshRank().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}
