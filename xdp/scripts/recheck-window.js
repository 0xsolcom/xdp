// scripts/recheck-window.js
// 周期性增量回溯：把「最近 N 分钟」重新扫一遍。
//
// 为什么需要它（实测教训）：
//   OKX 的 trades 接口对新交易有索引延迟 —— 一笔成交在链上出现了，
//   但接口可能几分钟后才返回它（甚至先返回空）。
//   一次性回溯（backfill）一旦把 is_initialized 置 1 就永不再扫，
//   这些「晚索引」的成交就永久丢了。
//
//   本项目实测代价：重置游标重扫一遍后，与官方榜的对账命中率
//   84% → 99%，6 个官方钱包从「查不到」变成能查到。
//
// 所以：不管回溯是否已完成，都按固定间隔把最近窗口重扫一遍。
//   写入走 saveTrades（trade_id 唯一 → INSERT IGNORE，天然幂等，不会重复计数）。
import { fetchTrades } from '../src/okx.js';
import { saveTrades } from '../src/save.js';
import { pool } from '../src/db.js';
import { CHAIN_INDEX, TOKEN_ADDRESS } from '../src/config.js';

const LIMIT     = Number(process.env.LIMIT || 100);
const MAX_PAGES = Number(process.env.RECHECK_MAX_PAGES || 30);

/** 重扫最近 minutes 分钟；返回 { fetched, added, pages } */
export async function recheckWindow({ minutes = Number(process.env.RECHECK_MINUTES || 120), verbose = true } = {}) {
  const since = Date.now() - minutes * 60 * 1000;
  let after = null;
  let fetched = 0, added = 0, pages = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = { chainIndex: CHAIN_INDEX, tokenContractAddress: TOKEN_ADDRESS, limit: LIMIT };
    if (after) params.after = after;

    let data;
    try {
      data = await fetchTrades(params);
    } catch (e) {
      if (verbose) console.error('[重扫] 请求失败:', e.message);
      break;
    }
    if (!data || String(data.code) !== '0') {
      if (verbose) console.error('[重扫] 返回异常:', JSON.stringify(data).slice(0, 200));
      break;
    }

    const list = data.data || [];
    if (!list.length) break;
    pages++;

    // 只保留窗口内的（接口按时间倒序）
    const inWin = list.filter((t) => Number(t.time) >= since);
    fetched += inWin.length;
    if (inWin.length) {
      try {
        added += await saveTrades(CHAIN_INDEX, TOKEN_ADDRESS, inWin);
      } catch (e) {
        if (verbose) console.error('[重扫] 写库失败:', e.message);
      }
    }

    // 本页已经出现窗口外的成交 → 说明翻够了
    if (inWin.length < list.length) break;

    after = list[list.length - 1].id;
    if (list.length < LIMIT) break;
  }

  if (verbose) {
    console.log(`[重扫] 最近 ${minutes} 分钟：翻 ${pages} 页，命中 ${fetched} 条，补回 ${added} 条`);
  }
  return { fetched, added, pages, minutes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = Number(process.argv[2] || 0);
  recheckWindow(m ? { minutes: m } : {})
    .then(() => pool.end())
    .catch((e) => { console.error(e); pool.end(); process.exit(1); });
}
