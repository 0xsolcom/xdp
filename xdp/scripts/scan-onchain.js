// scripts/scan-onchain.js
// 历史链上扫描：从链上重建 OKX 路由成交，补齐 OKX 接口漏掉的钱包。
//   用法: node scripts/scan-onchain.js [起始块] [结束块]
//         node scripts/scan-onchain.js --minutes 90        # 回扫最近 90 分钟
import { scanRange } from '../src/onchain.js';
import { pool } from '../src/db.js';
import axios from 'axios';

const RPC_URL = process.env.CHAIN_RPC_URL || 'https://mainnet.base.org';
const BLOCK_SEC = 2;   // Base 约 2 秒一个块

async function blockNumber() {
  const r = await axios.post(RPC_URL, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, { timeout: 15000 });
  return Number(BigInt(r.data.result));
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const latest = await blockNumber();
  let from, to;
  const minutes = arg('--minutes');
  if (minutes) {
    to = latest;
    from = latest - Math.ceil((Number(minutes) * 60) / BLOCK_SEC);
  } else {
    from = Number(process.argv[2] || (latest - Math.ceil((60 * 60) / BLOCK_SEC)));
    to = Number(process.argv[3] || latest);
  }
  const est = ((to - from) * BLOCK_SEC / 60).toFixed(0);
  console.log('=== 链上历史扫描 ===');
  console.log('RPC     :', RPC_URL);
  console.log('区块区间:', from, '~', to, '(约 ' + est + ' 分钟)');
  const t0 = Date.now();
  const res = await scanRange(from, to, { verbose: true, concurrency: 8 });
  console.log('完成: 扫描 ' + res.scanned + ' 块 / 命中路由 ' + res.hits + ' / 新入库 ' + res.ingested +
    ' / 失败 ' + res.failed + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const [src] = await pool.query('SELECT source, COUNT(*) n FROM trades GROUP BY source');
  console.log('全库来源:', src.map((r) => r.source + ':' + r.n).join('  '));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
