// src/router.js
// 路由判定的共用模块（可选口径）：
//   判断一批 tx 是否通过 OKX DEX 路由。
//   - save.js 在【入库前】可选调用（CLASSIFY_ROUTES_ON_SAVE=1）
//   - scripts/scan-routers.js 作为定时兜底，补齐未判定的 tx
// 判定结果写入 okx_route（tx_hash 唯一），并返回 Map<txHash, { okx: 0|1, methodId }>。
//   methodId 是这次调用 OKX 路由用的函数选择器 —— 入库过滤要靠它区分
//   dagSwapTo（官方认）和 dagSwapByOrderId（订单式成交，官方不算），见 config.js。
//
// ⚠️ 2026-09-29 改：原来走 OKX 的 /api/v6/explorer/transaction/transaction-multi，
// 但那套接口已切到 x402 付费（超额 $0.0001/次）。我们只需要 tx 的 to + input 两个字段，
// eth_getTransactionByHash 在公共 RPC 上免费就能给 —— 所以整条判定改成走 RPC，
// 从此「路由判定」这条链路完全不花钱，也不再受 OKX 额度影响。
import { pool } from './db.js';
import { rpcBatch } from './rpc.js';
import { CHAIN_INDEX, isOkxTx, INGEST_ONLY_OKX } from './config.js';

/** 批量取/判 tx 的路由标记；查不到的不会出现在返回 Map 里（不误判） */
export async function classifyRoutes(txHashes) {
  const list = [...new Set((txHashes || []).filter(Boolean).map((h) => String(h).toLowerCase()))];
  const out = new Map();
  if (!list.length) return out;

  // 1) 缓存
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const [rows] = await pool.query('SELECT tx_hash, is_okx, method_id FROM okx_route WHERE tx_hash IN (?)', [chunk]);
    for (const r of rows) out.set(r.tx_hash, { okx: Number(r.is_okx), methodId: r.method_id ? String(r.method_id).toLowerCase() : null });
  }

  // 2) 现查：eth_getTransactionByHash（批量走 RPC，免费）
  const todo = list.filter((h) => !out.has(h));
  for (let i = 0; i < todo.length; i += 20) {
    const chunk = todo.slice(i, i + 20);
    try {
      const txs = await rpcBatch(chunk.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
      const rows = [];
      for (let j = 0; j < chunk.length; j++) {
        const tx = txs[j];
        // 链上查不到（还没上链 / 节点没有）→ 不判定，留 NULL 让下轮再试，绝不误判
        if (!tx || !tx.hash) continue;
        const h = chunk[j];
        const to = String(tx.to || '').toLowerCase();
        const methodId = String(tx.input || '').slice(0, 10).toLowerCase();
        const okx = isOkxTx(to, methodId);
        out.set(h, { okx, methodId: methodId || null });
        rows.push([h, to || null, methodId || null, okx]);
      }
      if (rows.length) {
        await pool.query(
          'INSERT INTO okx_route (tx_hash, router, method_id, is_okx) VALUES ? ' +
          'ON DUPLICATE KEY UPDATE router = VALUES(router), method_id = VALUES(method_id), is_okx = VALUES(is_okx)',
          [rows]
        );
        const okxH = [], noH = [];
        for (const r of rows) (r[3] === 1 ? okxH : noH).push(r[0]);
        if (okxH.length) await pool.query('UPDATE trades SET is_okx = 1 WHERE tx_hash IN (?) AND is_okx IS NULL', [okxH]);
        if (noH.length) {
          // 入库过滤开着时，「非 OKX」的成交根本不该留在库里。
          // 这里遇到的是入库那一刻节点没返回、被迫先存成 NULL 的（save.js 的 2.4 步只丢「当场判明 0」的），
          // 既然现在判明了就删掉 —— 否则它会一直挂在库里污染统计和体积。
          // 只删 is_okx IS NULL 的行：已经判定过 1 的绝不动。
          if (INGEST_ONLY_OKX) {
            await pool.query('DELETE FROM trades WHERE tx_hash IN (?) AND is_okx IS NULL', [noH]);
          } else {
            await pool.query('UPDATE trades SET is_okx = 0 WHERE tx_hash IN (?) AND is_okx IS NULL', [noH]);
          }
        }
      }
    } catch (e) {
      // 接口抖动：留未判定，scan-routers 会补
    }
  }
  return out;
}
