// scripts/reconcile-official.js
// 与 OKX 官方榜单对账：拉官方 leaderboard，和本地排行逐钱包比对。
// 用途：验证采集口径是否正确、有没有漏单。
//
// 用法: npm run reconcile            # 默认对比官方前 50 名
//       node scripts/reconcile-official.js 100
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { CHAIN_INDEX, TOKEN_ADDRESS, WIN_START_SQL, WIN_END_SQL, QUOTE_SYMBOLS, REQUIRE_OKX_ROUTE } from '../src/config.js';

// override: .env 优先于 Shell 环境变量
dotenv.config({ override: true });

const LAUNCHPOOL_ID = Number(process.env.LAUNCHPOOL_ID || 0);
const TOP_N = Number(process.argv[2] || 50);

if (!LAUNCHPOOL_ID) {
  console.error('❌ 未配置 LAUNCHPOOL_ID，无法对账');
  process.exit(1);
}

const API = 'https://web3.okx.com/priapi/v1/dapp/boost/launchpool/leaderboard';

function fmt(n, d = 2) { return Number(n).toFixed(d); }

async function main() {
  const res = await fetch(API + '?launchpoolId=' + LAUNCHPOOL_ID + '&t=' + Date.now(), {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0', referer: 'https://web3.okx.com/' },
  });
  const body = await res.json();
  const d = body.data || {};
  const list = (d.list || []).slice(0, TOP_N);
  if (!list.length) throw new Error('官方榜单为空');

  console.log('=== 与 OKX 官方榜单对账 ===');
  console.log('launchpoolId :', LAUNCHPOOL_ID);
  console.log('报名人数     :', d.participants, '| 官方总量 $' + fmt(d.totalBoostVolume || 0));
  console.log('本地口径     : 窗口 ' + WIN_START_SQL + ' ~ ' + WIN_END_SQL +
    ' | 币对 ' + (QUOTE_SYMBOLS.length ? QUOTE_SYMBOLS.join('/') : '全部') +
    ' | ' + (REQUIRE_OKX_ROUTE ? '仅 OKX 路由' : '全部 DEX'));
  console.log('');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    timezone: 'Z', decimalNumbers: true,
  });
  await conn.query("SET time_zone = '+00:00'");

  const baseWhere = 'token_address = ? AND wallet_address = ? AND trade_time >= ? AND trade_time < ? AND wallet_is_contract = 0';
  async function localVol(wallet, okxOnly) {
    const extra = okxOnly ? ' AND is_okx = 1' : '';
    const [r] = await conn.query(
      'SELECT COALESCE(SUM(volume_usd),0) AS v, COUNT(*) AS n FROM trades WHERE ' + baseWhere + extra,
      [TOKEN_ADDRESS, wallet, WIN_START_SQL, WIN_END_SQL]
    );
    return [Number(r[0].v), Number(r[0].n)];
  }

  let offSum = 0, okxSum = 0, allSum = 0, hitAll = 0, hitOkx = 0;
  const rows = [];
  const offMap = new Map();      // wallet -> 官方交易量
  const offRankMap = new Map();  // wallet -> 官方名次
  for (const o of list) {
    const w = String(o.walletAddress).toLowerCase();
    offMap.set(w, Number(o.boostVolume));
    offRankMap.set(w, o.rank);
  }
  for (const o of list) {
    const w = String(o.walletAddress).toLowerCase();
    const off = Number(o.boostVolume);
    const [all, an] = await localVol(w, false);
    const [okx, kn] = await localVol(w, true);
    offSum += off; allSum += all; okxSum += okx;
    if (all > 0) hitAll++;
    if (okx > 0) hitOkx++;
    rows.push({ rank: o.rank, wallet: w, off, all, okx, an, kn });
  }

  const pct = (a, b) => (b > 0 ? (a / b * 100).toFixed(1) + '%' : '-');
  console.log('官方 ' + list.length + ' 名合计 $' + fmt(offSum));
  console.log('  本地全部 DEX : $' + fmt(allSum) + ' (' + pct(allSum, offSum) + ')  命中钱包 ' + hitAll + '/' + list.length);
  console.log('  本地仅 OKX   : $' + fmt(okxSum) + ' (' + pct(okxSum, offSum) + ')  命中钱包 ' + hitOkx + '/' + list.length);
  console.log('');
  console.log('rank  official      local(OKX)    笔数  吻合度   wallet');
  for (const r of rows.slice(0, 25)) {
    const ov = r.off > 0 ? (Math.min(r.okx, r.off) / Math.max(r.okx, r.off) * 100).toFixed(0) + '%' : '-';
    console.log(
      String(r.rank).padStart(4),
      fmt(r.off).padStart(12),
      fmt(r.okx).padStart(12),
      String(r.kn).padStart(6),
      ov.padStart(7),
      ' ',
      r.wallet + (r.okx === 0 ? '   << 本地无数据' : '')
    );
  }
  if (rows.length > 25) console.log('  … 其余 ' + (rows.length - 25) + ' 名省略');

  // ------------------------------------------------------------------
  // 本地榜 Top N vs 官方榜：看两边名次差在哪
  //   本地榜口径 = 所有走 OKX 路由的钱包；官方榜只收录「已报名且已交易」的钱包。
  //   所以本地榜前面会挤进一批没报名的做市/搬砖地址，官方参与者被往后挤。
  // ------------------------------------------------------------------
  const TOPN = 20;
  const [top] = await conn.query(
    'SELECT wallet_address AS w, CAST(volume_usd AS CHAR) AS v, tx_count AS n, rank_no AS r FROM wallet_rank ORDER BY rank_no LIMIT ' + TOPN
  );
  console.log('');
  console.log('=== 本地榜 Top' + TOPN + ' vs 官方榜 ===');
  console.log('本地#  本地交易量   笔数   官方#   官方交易量   偏差        钱包');
  let onBoard = 0;
  for (const t of top) {
    const o = offMap.get(String(t.w).toLowerCase());
    if (o) onBoard++;
    const d = o ? Math.abs(Number(t.v) - o) / o * 100 : null;
    console.log(
      '  ' + String(t.r).padStart(3),
      fmt(t.v).padStart(12),
      String(t.n).padStart(5),
      '  ' + (o ? String(offRankMap.get(String(t.w).toLowerCase())).padStart(4) + '  ' + fmt(o).padStart(11) + '  ' + (d < 1 ? '✅一致' : d.toFixed(1) + '%') : '  --   不在官方榜      '),
      ' ' + String(t.w).slice(0, 14) + '…'
    );
  }
  console.log('');
  if (onBoard === TOPN) {
    console.log('本地 Top' + TOPN + ' 全部在官方榜上 ✅（已启用 ONLY_OFFICIAL_WALLETS 过滤）');
  } else {
    console.log('本地 Top' + TOPN + ' 里有 ' + onBoard + ' 个在官方榜上；其余是「走 OKX 路由但没报名」的地址，' +
      '官方不给它们分奖 —— 开 ONLY_OFFICIAL_WALLETS=1 可排除。');
  }
  await conn.end();
}

main().catch((e) => { console.error('对账失败:', e.message); process.exit(1); });
