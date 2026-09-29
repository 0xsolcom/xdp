// scripts/scan-contracts.js
// 扫描 trades 里所有唯一钱包地址，调 eth_getCode 判断是否合约，结果写 contract_check。
//   - 断点续传：已检测过的地址跳过（可反复跑，直到没有「待检测」）
//   - JSON-RPC 批量请求 + 429/5xx 退避重试（公共 Base RPC 单发会被限流）
//   - 可被 src/index.js 定时调用；也可直接 node scripts/scan-contracts.js 单跑
import { pool } from '../src/db.js';
import axios from 'axios';
import { CHAIN_INDEX, TOKEN_ADDRESS } from '../src/config.js';

const CONCURRENCY = Number(process.env.RPC_CONCURRENCY || 4);
const BATCH       = Number(process.env.RPC_BATCH || 10);   // 每个 HTTP 请求塞多少个 eth_getCode（主网公共 RPC 上限 10）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 批量 JSON-RPC：一次 HTTP 请求发多个 eth_getCode */
async function rpcBatch(rpcUrl, addresses) {
  const body = addresses.map((a, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [a, 'latest'],
  }));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.post(rpcUrl, body, { timeout: 30000 });
      const arr = Array.isArray(res.data) ? res.data : [res.data];
      const out = new Array(addresses.length).fill(null);
      let got = 0;
      let firstErr = null;
      for (const item of arr) {
        if (item && typeof item.id === 'number' && item.id < out.length) {
          if (item.error) { firstErr = item.error; out[item.id] = null; }
          else { out[item.id] = item.result !== undefined ? item.result : null; got++; }
        }
      }
      // 整批被拒（例如「maximum 10 calls in 1 batch」）→ 抛出去触发退避重试
      if (got === 0 && firstErr) throw new Error('rpc: ' + (firstErr.message || JSON.stringify(firstErr)));
      return out;
    } catch (e) {
      const st = e.response ? e.response.status : 0;
      if (attempt === 5 || (st && st !== 429 && st < 500)) throw e;
      await sleep(attempt * 700);   // 429 / 5xx 退避
    }
  }
  return new Array(addresses.length).fill(null);
}

function classify(code) {
  // EIP-7702：EOA 委托实现合约后，链上代码是 0xef0100 + 20 字节地址（恰好 23 字节）。
  // 这类地址仍然是普通用户钱包，不能判为合约，否则真实用户会被排除出排行。
  const isDelegatedEoa = typeof code === 'string' && code.toLowerCase().startsWith('0xef0100');
  const isContract = !!code && code !== '0x' && code.length > 2 && !isDelegatedEoa;
  const codeLen = code ? Math.floor((code.length - 2) / 2) : 0;
  return { isContract, codeLen };
}

export async function scanContracts({ verbose = true } = {}) {
  const RPC_URL = process.env.CHAIN_RPC_URL;
  if (!RPC_URL) throw new Error('请在 .env 配置 CHAIN_RPC_URL');

  const [allRows] = await pool.execute(
    'SELECT DISTINCT wallet_address FROM trades WHERE chain_index = ? AND token_address = ?',
    [CHAIN_INDEX, TOKEN_ADDRESS]
  );
  const all = allRows.map((r) => r.wallet_address.toLowerCase());

  const [doneRows] = await pool.execute('SELECT address FROM contract_check');
  const done = new Set(doneRows.map((r) => r.address));
  const todo = all.filter((a) => !done.has(a));

  if (verbose) {
    console.log('=== 合约地址扫描 ===');
    console.log('RPC            :', RPC_URL);
    console.log('trades 唯一地址:', all.length, '| 已检测:', done.size, '| 待检测:', todo.length);
  }
  if (!todo.length) {
    if (verbose) console.log('[合约] 没有待检测地址');
    return { checked: 0, found: 0, contracts: 0, eoas: 0, total: done.size };
  }

  // 切成 BATCH 大小的批次，并发跑
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let found = 0, ok = 0, fail = 0, bi = 0;
  async function worker() {
    while (bi < batches.length) {
      const my = bi++;
      const batch = batches[my];
      try {
        const codes = await rpcBatch(RPC_URL, batch);
        for (let k = 0; k < batch.length; k++) {
          const addr = batch[k];
          if (codes[k] === null) { fail++; continue; }   // 没拿到结果，留待下轮
          const { isContract, codeLen } = classify(codes[k]);
          if (isContract) found++;
          await pool.execute(
            'INSERT INTO contract_check (address, is_contract, code_len) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE is_contract = VALUES(is_contract), code_len = VALUES(code_len), checked_at = NOW()',
            [addr, isContract ? 1 : 0, codeLen]
          );
          if (isContract) {
            await pool.execute(
              'UPDATE trades SET wallet_is_contract = 1 WHERE wallet_address = ? AND wallet_is_contract = 0',
              [addr]
            );
          }
          ok++;
        }
      } catch (e) {
        fail += batch.length;
        console.error('\n[批次失败] ' + e.message);
      }
      if (verbose) process.stdout.write('\r进度 ' + (ok + fail) + '/' + todo.length + '  成功 ' + ok + '  失败 ' + fail);
      await sleep(120);   // 轻节流
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  if (verbose) process.stdout.write('\n');

  const [[stat]] = await pool.query(
    'SELECT SUM(is_contract=1) AS contracts, SUM(is_contract=0) AS eoas, COUNT(*) AS total FROM contract_check'
  );
  const result = {
    contracts: Number(stat.contracts || 0),
    eoas: Number(stat.eoas || 0),
    total: Number(stat.total || 0),
    checked: ok, found, failed: fail,
  };
  if (verbose || todo.length > 0) {
    console.log('[合约] 本轮检测 ' + ok + ' 个（失败 ' + fail + '），发现合约 ' + found + ' 个；累计 ' + result.contracts + ' 合约 / ' + result.eoas + ' EOA');
    if (fail > 0) console.log('      有失败项：再跑一次会自动续传（已检测的会跳过）');
  }
  return result;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  scanContracts().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
}
