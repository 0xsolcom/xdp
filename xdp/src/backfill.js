import { pool } from './db.js';
import { fetchTrades } from './okx.js';
import { saveTrades } from './save.js';
import { CHAIN_INDEX, TOKEN_ADDRESS, parseTime } from './config.js';

const LIMIT     = Number(process.env.LIMIT_BACKFILL || 100);
const MAX_PAGES = Number(process.env.MAX_PAGES_BACKFILL || 10);

// 回溯下界：支持毫秒时间戳或 ISO 字符串；没配置 = 不限制
const STOP_TIME_MS = parseTime(process.env.BACKFILL_STOP_TIME);

// 连续多少个「空页」才认定真的翻到头。
// ⚠️ 教训：接口对新数据有索引延迟，
//    刚出块的成交可能先返回空/不全。**一次空页不能当"到头"**否则永久丢单。
const EMPTY_CONFIRM = Math.max(1, Number(process.env.BACKFILL_EMPTY_CONFIRM || 3));

async function getCursor() {
  const [rows] = await pool.execute(
    'SELECT last_after, is_initialized, empty_streak FROM crawl_cursor WHERE chain_index = ? AND token_address = ?',
    [CHAIN_INDEX, TOKEN_ADDRESS]
  );
  if (rows.length === 0) {
    await pool.execute(
      'INSERT INTO crawl_cursor (chain_index, token_address, last_after, is_initialized) VALUES (?, ?, NULL, 0)',
      [CHAIN_INDEX, TOKEN_ADDRESS]
    );
    return { last_after: null, is_initialized: 0, empty_streak: 0 };
  }
  return rows[0];
}

async function updateCursor(lastAfter, isInitialized, addCount = 0, emptyStreak = 0) {
  await pool.execute(
    `UPDATE crawl_cursor
     SET last_after = ?, is_initialized = ?, total_backfilled = total_backfilled + ?, empty_streak = ?
     WHERE chain_index = ? AND token_address = ?`,
    [lastAfter, isInitialized, addCount, emptyStreak, CHAIN_INDEX, TOKEN_ADDRESS]
  );
}

/**
 * 历史回溯：从游标位置继续向后翻，直到翻过 STOP_TIME_MS 或翻到头。
 *   verbose=false 时，已经回溯完成就完全静默 —— 定时任务每 20 秒跑一次，
 *   每次都打一行「已完成回溯，跳过」纯属噪音（手工跑 npm run backfill 时仍会打）。
 */
export async function runBackfill({ verbose = true } = {}) {
  const cursor = await getCursor();
  if (cursor.is_initialized === 1) {
    if (verbose) console.log('[回溯] 已完成回溯，跳过');
    return { totalFetched: 0, totalNew: 0, done: true };
  }

  if (STOP_TIME_MS) {
    console.log(`[回溯] 截止时间: ${new Date(STOP_TIME_MS).toISOString()} (UTC)`);
  }

  let after = cursor.last_after;
  let totalNew = 0;
  let totalFetched = 0;
  let reachedEnd = false;
  let emptyStreak = Number(cursor.empty_streak || 0);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = { chainIndex: CHAIN_INDEX, tokenContractAddress: TOKEN_ADDRESS, limit: LIMIT };
    if (after) params.after = after;

    let data;
    try {
      data = await fetchTrades(params);
    } catch (err) {
      console.error('[OKX] 回溯请求失败:', err.message);
      break;
    }
    if (!data || String(data.code) !== '0') {
      console.error('[OKX] 返回异常:', JSON.stringify(data).slice(0, 300));
      break;
    }

    let list = data.data || [];
    if (list.length === 0) {
      emptyStreak++;
      if (emptyStreak >= EMPTY_CONFIRM) {
        reachedEnd = true;
        console.log(`[回溯] 连续 ${emptyStreak} 次空页，认定已翻到最早，回溯完成`);
      } else {
        // 不判定完成 → is_initialized 保持 0，下一轮 cron 会继续试
        console.log(`[回溯] 空页 ${emptyStreak}/${EMPTY_CONFIRM}（接口可能还没索引好），本轮不判定完成`);
      }
      break;
    }
    emptyStreak = 0;   // 有数据就清零

    const rawCount = list.length;

    // 时间截断：只保留 STOP_TIME_MS 之后的交易（接口通常按时间倒序）
    list.sort((a, b) => Number(b.time) - Number(a.time));
    let pageHasStop = false;
    if (STOP_TIME_MS) {
      const filtered = [];
      for (const t of list) {
        if (Number(t.time) >= STOP_TIME_MS) filtered.push(t);
        else pageHasStop = true;
      }
      list = filtered;
    }

    totalFetched += list.length;
    if (list.length) {
      try {
        totalNew += await saveTrades(CHAIN_INDEX, TOKEN_ADDRESS, list);
      } catch (err) {
        console.error('[DB] 回溯批量写入失败:', err.message);
      }
    }

    if (pageHasStop) {
      reachedEnd = true;
      console.log('[回溯] 已到截止时间之前，停止回溯');
      break;
    }
    if (!list.length) break;

    after = list[list.length - 1].id;
    if (rawCount < LIMIT) {
      reachedEnd = true;
      console.log('[回溯] 本页不足 limit，已翻到头');
      break;
    }
  }

  await updateCursor(after, reachedEnd ? 1 : 0, totalNew, emptyStreak);
  console.log(`[回溯] ${new Date().toISOString()} 拉取 ${totalFetched} 条，新增 ${totalNew} 条，${reachedEnd ? '已到截止点/翻到头 ✅' : '继续中...'}`);
  return { totalFetched, totalNew, done: reachedEnd };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBackfill().then(() => pool.end()).catch((e) => { console.error(e); pool.end(); process.exit(1); });
}
