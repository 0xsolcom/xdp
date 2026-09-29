// scripts/find-okx-routers.js
// 路由发现工具：扫描最近 N 笔成交的链上 tx，统计「接收合约地址 + methodId」的分布。
// 用途：找出 XDP/Base 上到底有哪些 OKX 路由合约，然后把高频且属于 OKX 的地址填进 .env 的 OKX_ROUTERS。
//
// 判定提示：OKX DEX 的 dagSwapTo 方法 ID = 0x0c307f76；命中它的 to 基本就是 OKX 路由。
//
// 用法: npm run scan:routers:discover        # 默认最近 300 笔
//       node scripts/find-okx-routers.js 1000
import { pool } from '../src/db.js';
import { fetchTxMulti } from '../src/okx.js';
import { CHAIN_INDEX, TOKEN_ADDRESS } from '../src/config.js';

const OKX_METHOD_HINT = '0x0c307f76';

async function main() {
  const limit = Number(process.argv[2] || 300);

  const [rows] = await pool.query(
    'SELECT DISTINCT tx_hash FROM trades WHERE chain_index = ? AND token_address = ? AND tx_hash IS NOT NULL AND tx_hash <> \'\' ' +
    'ORDER BY trade_time DESC LIMIT ?',
    [CHAIN_INDEX, TOKEN_ADDRESS, limit]
  );
  const hashes = rows.map((r) => r.tx_hash);
  console.log('=== 路由发现 ===');
  console.log('样本 tx:', hashes.length);
  if (!hashes.length) { console.log('（库里还没有成交，先跑一次实时采集）'); return; }

  const byRouter = new Map();   // to -> { n, methods:Map }
  for (let i = 0; i < hashes.length; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    const map = await fetchTxMulti(chunk, CHAIN_INDEX);
    for (const h of chunk) {
      const it = map.get(String(h).toLowerCase());
      if (!it) continue;
      const to = String(it.to || '').toLowerCase() || '(empty)';
      const methodId = String(it.methodId || '').toLowerCase() || '(none)';
      if (!byRouter.has(to)) byRouter.set(to, { n: 0, methods: new Map() });
      const rec = byRouter.get(to);
      rec.n++;
      rec.methods.set(methodId, (rec.methods.get(methodId) || 0) + 1);
    }
  }

  const sorted = [...byRouter.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log('\n接收合约（to）分布：');
  for (const [to, rec] of sorted) {
    const methods = [...rec.methods.entries()].sort((a, b) => b[1] - a[1])
      .map(([m, c]) => m + '×' + c).join(' ');
    // 只按「这批 tx 自己出现过这个 methodId」判定，不能拿配置常量当条件（否则全部都会被标星）
    const hint = rec.methods.has(OKX_METHOD_HINT) ? '  ★ 疑似 OKX 路由' : '';
    console.log('  ' + to + '  ' + rec.n + ' 笔  [' + methods + ']' + hint);
  }

  const suspects = sorted.filter(([, rec]) => rec.methods.has(OKX_METHOD_HINT)).map(([to]) => to);
  console.log('\n疑似 OKX 路由（命中 ' + OKX_METHOD_HINT + '）:');
  console.log(suspects.length ? suspects.join(',') : '(无)');
  console.log('\n把确认的地址填进 .env:');
  console.log('OKX_ROUTERS=' + suspects.join(','));
  console.log('REQUIRE_OKX_ROUTE=1');
}

main().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
