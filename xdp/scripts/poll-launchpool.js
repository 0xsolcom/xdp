// scripts/poll-launchpool.js
// 采样 OKX 官方 Launchpool 榜单，监测「报名人数 / 反推获奖钱包数」——用来盯女巫刷单。
//
// 为什么能反推获奖人数：
//   官方只给 participants 和 top100，但 top100 每行带 estimatedReward，且
//       预计奖励 = 均分池每人 + (交易量奖池 / 总交易量) × 该行交易量
//   对榜单做最小二乘拟合 y = c + k·x：
//       k 应 ≈ 交易量奖池 / 总交易量（验证口径）
//       c = 均分池每人 → 获奖钱包数 ≈ 均分奖池 / c
//
// 仅当 .env 配了 LAUNCHPOOL_ID 时启用。
import axios from 'axios';
import { pool } from '../src/db.js';
import { CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL } from '../src/config.js';

const LAUNCHPOOL_ID = Number(process.env.LAUNCHPOOL_ID || 0);
const API           = 'https://web3.okx.com/priapi/v1/dapp/boost/launchpool/leaderboard';
const EQUAL_POOL    = Number(process.env.EQUAL_POOL || 0);
const VOLUME_POOL   = Number(process.env.VOLUME_POOL || 0);
const TABLE         = 'okx_launchpool_snap';

function ensureSchema() {
  return pool.query(
    'CREATE TABLE IF NOT EXISTS ' + TABLE + ' (' +
    ' id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
    ' launchpool_id INT NOT NULL,' +
    " captured_at DATETIME NOT NULL COMMENT 'UTC（采集器显式写入）'," +
    ' participants  INT DEFAULT NULL,' +
    ' total_volume  DECIMAL(30,10) DEFAULT NULL,' +
    ' top1_volume   DECIMAL(30,10) DEFAULT NULL,' +
    ' top10_volume  DECIMAL(30,10) DEFAULT NULL,' +
    ' top50_volume  DECIMAL(30,10) DEFAULT NULL,' +
    ' top100_volume DECIMAL(30,10) DEFAULT NULL,' +
    ' equal_share   DECIMAL(20,10) DEFAULT NULL,' +
    ' winners       INT DEFAULT NULL,' +
    ' fit_k         DECIMAL(20,12) DEFAULT NULL,' +
    ' fit_k_theory  DECIMAL(20,12) DEFAULT NULL,' +
    ' local_wallets INT DEFAULT NULL,' +
    ' local_volume  DECIMAL(30,10) DEFAULT NULL,' +
    ' PRIMARY KEY (id),' +
    ' UNIQUE KEY uk_snap (launchpool_id, captured_at),' +
    ' KEY idx_time (captured_at)' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
  );
}

async function localStats() {
  try {
    const [r] = await pool.query(
      'SELECT COUNT(*) AS w, CAST(COALESCE(SUM(volume_usd),0) AS CHAR) AS v FROM wallet_rank ' +
      'WHERE chain_index = ? AND token_address = ? AND win_start = ? AND win_end = ? AND volume_usd > 0',
      [CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL]
    );
    const row = r[0] || {};
    return { wallets: Number(row.w || 0), volume: Number(row.v || 0) };
  } catch (e) { return null; }
}

function leastSquares(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1]; }
  const den = n * sxx - sx * sx;
  if (!den) return null;
  const k = (n * sxy - sx * sy) / den;
  return { k, c: (sy - k * sx) / n };
}

function utcNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

export async function pollLaunchpool({ verbose = true } = {}) {
  if (!LAUNCHPOOL_ID) throw new Error('未配置 LAUNCHPOOL_ID');
  await ensureSchema();

  const res = await axios.get(API + '?launchpoolId=' + LAUNCHPOOL_ID + '&t=' + Date.now(), {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: 'https://web3.okx.com/' },
    timeout: 15000,
  });
  const d = res.data && res.data.data;
  if (!d || !Array.isArray(d.list) || d.list.length === 0) throw new Error('官方接口返回异常');

  const total        = Number(d.totalBoostVolume || 0);
  const participants = Number(d.participants || 0);
  const list         = d.list.slice(0, 100);
  const fit          = leastSquares(list.map((x) => [Number(x.boostVolume) || 0, Number(x.estimatedReward) || 0]));
  const kTheory      = total > 0 && VOLUME_POOL > 0 ? VOLUME_POOL / total : null;
  const equalShare   = fit && fit.c > 0 ? fit.c : null;
  const winners      = equalShare && EQUAL_POOL > 0 ? Math.round(EQUAL_POOL / equalShare) : null;
  const volAt        = (n) => { const r = list[n - 1]; return r ? Number(r.boostVolume) : null; };
  const capturedAt   = utcNow();
  const loc          = await localStats();

  // 把整份「已报名钱包」名单落库：本地排行靠它把没报名的地址排除掉
  const wallets = [];
  list.forEach((x, i) => {
    const w = String(x.walletAddress || '').toLowerCase();
    if (!w) return;
    wallets.push([LAUNCHPOOL_ID, w, Number(x.rank) || i + 1, Number(x.boostVolume) || 0]);
  });
  if (wallets.length) {
    await pool.query(
      'INSERT INTO official_wallet (launchpool_id, wallet_address, rank_no, boost_volume) VALUES ? ' +
      'ON DUPLICATE KEY UPDATE rank_no = VALUES(rank_no), boost_volume = VALUES(boost_volume)',
      [wallets]
    );
  }

  await pool.query(
    'INSERT INTO ' + TABLE +
    ' (launchpool_id, captured_at, participants, total_volume, top1_volume, top10_volume, top50_volume, top100_volume, equal_share, winners, fit_k, fit_k_theory, local_wallets, local_volume)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)' +
    ' ON DUPLICATE KEY UPDATE participants=VALUES(participants), total_volume=VALUES(total_volume),' +
    ' top1_volume=VALUES(top1_volume), top10_volume=VALUES(top10_volume), top50_volume=VALUES(top50_volume),' +
    ' top100_volume=VALUES(top100_volume), equal_share=VALUES(equal_share), winners=VALUES(winners),' +
    ' fit_k=VALUES(fit_k), fit_k_theory=VALUES(fit_k_theory), local_wallets=VALUES(local_wallets), local_volume=VALUES(local_volume)',
    [LAUNCHPOOL_ID, capturedAt, participants, total, volAt(1), volAt(10), volAt(50), volAt(100),
     equalShare, winners, fit ? fit.k : null, kTheory, loc ? loc.wallets : null, loc ? loc.volume : null]
  );

  await pool.query('DELETE FROM ' + TABLE + ' WHERE captured_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
  if (verbose) {
    console.log('[榜单采样] ' + capturedAt + ' UTC  报名 ' + participants + '  获奖(反推) ' + winners + '  均分/人 $' + (equalShare ? equalShare.toFixed(2) : '-'));
    console.log('   总交易量 $' + total.toFixed(0) + '   #1 $' + volAt(1) + '   #100 $' + volAt(100));
    if (loc) console.log('   本地实时：有效钱包 ' + loc.wallets + ' 个 / 总量 $' + loc.volume.toFixed(0));
    console.log('   官方已报名钱包名单: ' + wallets.length + ' 个（写 official_wallet）');
  }
  return { participants, winners, equalShare, total, capturedAt };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  pollLaunchpool().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
}
