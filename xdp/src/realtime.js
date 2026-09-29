import { fetchTrades, paywallActive } from './okx.js';
import { saveTrades } from './save.js';
import { CHAIN_INDEX, TOKEN_ADDRESS } from './config.js';

const LIMIT     = Number(process.env.LIMIT || 100);
const MAX_PAGES = Number(process.env.MAX_PAGES_REALTIME || 2);

/**
 * 实时增量：从最新开始往回翻，直到「某一页一条新增都没有」为止，最多翻 MAX_PAGES 页。
 *
 * 每页 LIMIT 条，所以单次最多 MAX_PAGES × LIMIT 条。
 * MAX_PAGES 是**上限不是固定开销**：追平之后每轮只要 1~2 页就会命中「本页全旧」提前退出。
 *
 * ⚠️ 2026-09-29 修 bug：原来判断的是**累计** totalNew，注释却写「这一页全是旧数据」。
 * 累计值一旦 >0 就再也不会归零 → 每轮都翻满 MAX_PAGES 页（接口按次收费后就是白花钱），
 * 「追上就停」完全失效。改成用本页新增数判断。
 */
export async function runRealtime() {
  let after = null;
  let totalNew = 0;
  let totalFetched = 0;
  let pages = 0;
  let hitCap = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = { chainIndex: CHAIN_INDEX, tokenContractAddress: TOKEN_ADDRESS, limit: LIMIT };
    if (after) params.after = after;

    let data;
    try {
      data = await fetchTrades(params);
      pages++;
    } catch (err) {
      // 付费墙期间不再打这一行 —— 冷却期内的每次调用都会失败，
      // 而 okx.js 已经在熔断那一刻把完整原因和处置办法打过一次了，再刷就是噪音。
      if (!paywallActive()) console.error('[OKX] 实时请求失败:', err.message);
      break;
    }
    if (!data || String(data.code) !== '0') {
      console.error('[OKX] 返回异常:', JSON.stringify(data).slice(0, 300));
      break;
    }

    const list = data.data || [];
    if (list.length === 0) break;
    totalFetched += list.length;

    let pageNew = 0;
    try {
      pageNew = await saveTrades(CHAIN_INDEX, TOKEN_ADDRESS, list);
    } catch (err) {
      console.error('[DB] 批量写入失败:', err.message);
    }
    totalNew += pageNew;

    after = list[list.length - 1].id;
    if (list.length < LIMIT) break;   // 不足一页 = 到底了
    if (pageNew === 0) break;         // ★ 本页全在库里 = 已追平，不用再往前翻

    // 翻到顶格还有新增 → 说明增量比追回速度快，正在落后
    if (page === MAX_PAGES) hitCap = true;
  }

  console.log(`[实时] ${new Date().toISOString()} 拉取 ${totalFetched} 条，新增 ${totalNew} 条（${pages} 页）`);
  if (hitCap) {
    console.warn('[实时] ⚠️ 翻满 ' + MAX_PAGES + ' 页仍有新增，说明正在追不上：'
      + '把 MAX_PAGES_REALTIME 调大（追平后不会增加开销），或缩短 CRON_REALTIME');
  }
  return { totalFetched, totalNew, pages, hitCap };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRealtime().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
