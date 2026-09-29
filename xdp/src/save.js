import { pool } from './db.js';
import { isBlacklisted } from './blacklist.js';
import { classifyRoutes } from './router.js';
import {
  COLLECT_END_MS, CLASSIFY_ROUTES_ON_SAVE, INGEST_ONLY_OKX,
  INGEST_DROP_ORDER_SWAP, DEX_METHOD_BY_ORDER, utcDatetime,
} from './config.js';

/**
 * 入库过滤统计（只在 INGEST_ONLY_OKX=1 时累加，每 10 秒打一行，方便在 logs/index.log 里看效果）。
 *   dropped = 判定为「非 OKX」被丢掉的
 *   okx     = 判定为「OKX 路由」保留的
 *   unknown = 节点没返回、暂时判不出来的（按设计保留，留 NULL 给 scan-routers 补判）
 */
const ingestStat = { dropped: 0, order: 0, okx: 0, unknown: 0, at: 0 };
function logIngestStat() {
  const now = Date.now();
  if (!ingestStat.at) { ingestStat.at = now; return; }
  if (now - ingestStat.at < 10000) return;
  const { dropped, order, okx, unknown } = ingestStat;
  const tot = dropped + order + okx + unknown;
  if (tot > 0) {
    console.log('[过滤] 近 ' + Math.round((now - ingestStat.at) / 1000) + 's：'
      + '丢非OKX ' + dropped + ' 笔 / 丢订单式 ' + order + ' 笔 / 保留 OKX ' + okx + ' 笔 / 未判定保留 ' + unknown + ' 笔'
      + '（丢弃率 ' + (tot ? ((dropped + order) / tot * 100).toFixed(1) : '0') + '%）');
  }
  ingestStat.dropped = 0; ingestStat.order = 0; ingestStat.okx = 0; ingestStat.unknown = 0;
  ingestStat.at = now;
}

/** 从 changedTokenInfo 里取「计价币」符号（非本代币的那一个） */
export function quoteSymbolOf(t, tokenAddress) {
  const arr = Array.isArray(t.changedTokenInfo) ? t.changedTokenInfo : [];
  const other = arr.find((c) => String((c && c.tokenAddress) || '').toLowerCase() !== tokenAddress);
  const s = other && other.tokenSymbol ? String(other.tokenSymbol).toUpperCase() : '';
  return s || null;
}

/**
 * 批量写入（幂等）。
 *
 * @param {object} [opts]
 * @param {'okx'|'ws'|'onchain'} [opts.source='okx'] 数据来源。三条源对同一笔交易生成的
 *   trade_id 格式完全不同，所以跨源去重必须认 (tx_hash, wallet_address, type)：
 *     okx     : 1790644953000!@#1509!@#77976518507
 *     ws      : 1790644791000!@#854
 *     onchain : oc:0x4d741…:0x866a…:buy
 *   优先级 okx > ws > onchain：okx 到了就把低优先级的行删掉重插（准确性以官方接口为准），
 *   ws / onchain 见到库里已有同一笔就跳过（实时性靠它们，但不覆盖更准的数据）。
 * @returns {Promise<number>} 实际新增条数
 */
export async function saveTrades(chainIndex, tokenAddress, list, { source = 'okx' } = {}) {
  if (!list || !list.length) return 0;

  const items = [];
  for (const t of list) {
    const wallet = String(t.userAddress || '').toLowerCase();
    if (!wallet) continue;
    if (isBlacklisted(wallet)) continue;
    // OKX Labs DEX Aggregator+ 是同一笔 swap 的重复条目，剔除
    if (t.dexName && String(t.dexName).startsWith('OKX Labs DEX Aggregator')) continue;
    const tradeTime = utcDatetime(t.time);
    if (COLLECT_END_MS && t.time && Number(t.time) > COLLECT_END_MS) continue;
    items.push({
      tradeId: String(t.id),
      txHash: String(t.txHashUrl || t.txHash || '').toLowerCase(),
      type: t.type === 'sell' ? 'sell' : 'buy',
      volume: Number(t.volume || 0),
      price: t.price ?? null,
      dexName: t.dexName ?? null,
      quoteSymbol: quoteSymbolOf(t, tokenAddress),
      wallet,
      tradeTime,
      raw: t,
    });
  }
  if (!items.length) return 0;

  // 1) 已存在的 trade_id
  const ids = items.map((x) => x.tradeId);
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 1000) {
    const [rows] = await pool.query('SELECT trade_id FROM trades WHERE trade_id IN (?)', [ids.slice(i, i + 1000)]);
    for (const r of rows) existing.add(r.trade_id);
  }
  const fresh = items.filter((x) => !existing.has(x.tradeId));
  if (!fresh.length) return 0;

  // 2) 可选：入库前判定 OKX 路由，让 is_okx 一进来就是确定的
  let okxMap = new Map();
  if (CLASSIFY_ROUTES_ON_SAVE) {
    const txHashes = [...new Set(fresh.map((x) => x.txHash).filter(Boolean))];
    okxMap = await classifyRoutes(txHashes);
  }

  // 2.4) 只要「官方计分」的成交，砍掉其余全部，省 90%+ 存储。
  //      判定不出来（NULL）的保留 —— 不能因为一次 RPC 抖动就丢真实成交。
  //
  //      两类会被丢：
  //        a) 不走 OKX 路由的（is_okx=0）
  //        b) 走 OKX 路由、但函数是 dagSwapByOrderId 的 ——
  //           那是「订单式成交」（做市/API 路径），官方活动一封都不算。
  //           实测：官网前 100 有 99 个只用 dagSwapTo、0 个用过它；
  //           它占入库量约一半，所以留着的价值只有「分析用」。
  let kept = fresh;
  if (INGEST_ONLY_OKX) {
    kept = fresh.filter((x) => {
      const r = okxMap.get(x.txHash);
      if (r === undefined) return true;                     // 没判定出来 → 保留，留给 scan-routers 补判
      if (r.okx !== 1) return false;                        // 非 OKX 路由 → 丢
      if (INGEST_DROP_ORDER_SWAP && r.methodId === DEX_METHOD_BY_ORDER) return false;  // 订单式成交 → 丢
      return true;
    });
    for (const x of fresh) {
      const r = okxMap.get(x.txHash);
      if (r === undefined) ingestStat.unknown++;
      else if (r.okx !== 1) ingestStat.dropped++;
      else if (INGEST_DROP_ORDER_SWAP && r.methodId === DEX_METHOD_BY_ORDER) ingestStat.order++;
      else ingestStat.okx++;
    }
    logIngestStat();
    if (!kept.length) return 0;
  }

  // 2.5) 跨源去重：同一笔成交只留一行，按 (tx_hash, wallet_address, type) 认（不认 trade_id，见函数注释）
  const txKeys = [...new Set(kept.map((x) => x.txHash).filter(Boolean))];
  const existingKeys = new Set();   // 'tx|wallet|type' 已在库里
  const demoteIds = [];             // 需要为 okx 让路的低优先级行（ws / onchain）
  if (txKeys.length) {
    const want = new Set(kept.map((x) => x.txHash + '|' + x.wallet + '|' + x.type));
    for (let i = 0; i < txKeys.length; i += 500) {
      const [rows] = await pool.query(
        'SELECT trade_id, tx_hash, wallet_address, type, source FROM trades WHERE tx_hash IN (?)',
        [txKeys.slice(i, i + 500)]
      );
      for (const r of rows) {
        const k = r.tx_hash + '|' + r.wallet_address + '|' + r.type;
        if (!want.has(k)) continue;
        existingKeys.add(k);
        if (source === 'okx' && r.source !== 'okx') demoteIds.push(r.trade_id);
      }
    }
  }

  // ws / onchain 是「只补不覆盖」：库里已有同一笔就跳过。
  // 注意判断的是**库里**有没有，不是本批里有没有 —— 一个 tx 里可能有两笔同向成交，
  // 它们 (tx,wallet,type) 相同，但必须都入库。
  let final = kept;
  if (source !== 'okx') {
    final = kept.filter((x) => !existingKeys.has(x.txHash + '|' + x.wallet + '|' + x.type));
    if (!final.length) return 0;
  }

  // 3) 已识别合约地址（反范式标记）
  const walletList = [...new Set(final.map((x) => x.wallet))];
  const contractSet = new Set();
  if (walletList.length) {
    const [cs] = await pool.query(
      'SELECT address FROM contract_check WHERE is_contract = 1 AND address IN (?)',
      [walletList]
    );
    for (const r of cs) contractSet.add(r.address);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 先清掉被 ws / 链上直采抢先写入的同一笔（随后用官方数据重插）
    for (let i = 0; i < demoteIds.length; i += 500) {
      await conn.query('DELETE FROM trades WHERE trade_id IN (?)', [demoteIds.slice(i, i + 500)]);
    }
    const cols =
      '(trade_id, chain_index, token_address, wallet_address, tx_hash, type, volume_usd, price, quote_symbol, dex_name, is_okx, wallet_is_contract, trade_time, raw_json, source)';
    const vals = final.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = [];
    for (const x of final) {
      params.push(
        x.tradeId, chainIndex, tokenAddress, x.wallet, x.txHash, x.type,
        x.volume, x.price, x.quoteSymbol, x.dexName,
        (okxMap.get(x.txHash) ? okxMap.get(x.txHash).okx : null),
        contractSet.has(x.wallet) ? 1 : 0,
        x.tradeTime, JSON.stringify(x.raw), source
      );
    }
    await conn.query('INSERT IGNORE INTO trades ' + cols + ' VALUES ' + vals, params);
    await conn.commit();
    return final.length;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
