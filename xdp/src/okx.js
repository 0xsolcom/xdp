import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
// override: .env 优先于 Shell 环境变量（部署机上常有别的项目导出的 DB_* / CHAIN_* 变量）
dotenv.config({ override: true });

const API_KEY    = process.env.OKX_API_KEY;
const SECRET_KEY = process.env.OKX_SECRET_KEY;
const PASSPHRASE = process.env.OKX_PASSPHRASE;
const BASE_URL   = 'https://web3.okx.com';

function sign(timestamp, method, requestPath, secretKey) {
  const prehash = timestamp + method.toUpperCase() + requestPath;
  return crypto.createHmac('sha256', secretKey).update(prehash).digest('base64');
}

/** OKX 要求的毫秒级 ISO 时间戳（保留 3 位毫秒） */
function okxTimestamp() {
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
}

/* ============================================================================
   402 付费墙熔断

   OKX 从 2026-09-29 起对 DEX / Explorer 接口启用 x402 付费：
     每月免费 100K 次（Basic 等级），超出后 $0.0001/次，
     只支持 X Layer 上的 USDG / USDT 支付，每次调用都要签一次 EIP-3009。
   免费额度用尽后每个请求都返回 402 + 支付要求（响应头里 x-ratelimit 其实还剩很多，
   所以看到 402 不要以为是限流）。

   命中后默认 10 分钟内不再尝试：既避免刷屏，也避免白白消耗按次预算。
   ============================================================================ */
const PAYWALL_COOLDOWN_MS = Number(process.env.OKX_402_COOLDOWN_MS || 10 * 60 * 1000);
let paywallUntil = 0;
let paywallLoggedAt = 0;

/** 当前是否处于付费墙冷却期（上层可以先查这个再决定要不要调用） */
export function paywallActive() {
  return Date.now() < paywallUntil;
}

/** 识别 402 并熔断；返回 true 表示「这是付费墙，别重试了」 */
function notePaywall(e) {
  if (!e || !e.response || Number(e.response.status) !== 402) return false;
  paywallUntil = Date.now() + PAYWALL_COOLDOWN_MS;
  if (Date.now() - paywallLoggedAt < PAYWALL_COOLDOWN_MS) return true;   // 同一次付费墙只详细打一次
  paywallLoggedAt = Date.now();
  const body = (e.response.data && typeof e.response.data === 'object') ? e.response.data : {};
  const a = (Array.isArray(body.accepts) && body.accepts[0]) || {};
  const sym = (a.extra && a.extra.symbol) || '';
  console.error('[OKX] ⛔ 402 付费墙：DEX/Explorer 接口的每月免费额度（Basic 100K 次）已用尽');
  if (a.payTo) console.error('[OKX]    单次收费 ' + a.amount + ' ' + sym + '（' + a.network + '）→ ' + a.payTo);
  console.error('[OKX]    三条路，任选：');
  console.error('[OKX]      ① 什么都不做：链上直采（WATCHER_INGEST=1）已覆盖 campaign 的全部 OKX 路由，完全免费');
  console.error('[OKX]      ② 充值 X Layer 的 USDG/USDT，用官方 @okxweb3/x402-axios 自动按次付费');
  console.error('[OKX]      ③ 调大 CRON_REALTIME 间隔，把日调用量压进预算');
  console.error('[OKX]    ' + Math.round(PAYWALL_COOLDOWN_MS / 60000) + ' 分钟内不再尝试（OKX_402_COOLDOWN_MS 可调）');
  return true;
}

function authHeaders(requestPath) {
  const timestamp = okxTimestamp();
  return {
    'OK-ACCESS-KEY': API_KEY,
    'OK-ACCESS-SIGN': sign(timestamp, 'GET', requestPath, SECRET_KEY),
    'OK-ACCESS-PASSPHRASE': PASSPHRASE,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'Content-Type': 'application/json',
  };
}

/**
 * 请求 OKX DEX trades 接口
 *   GET /api/v6/dex/market/trades?chainIndex=&tokenContractAddress=&after=&limit=
 */
export async function fetchTrades(params) {
  const allowed = ['chainIndex', 'tokenContractAddress', 'after', 'limit', 'tagFilter', 'walletAddressFilter'];
  const query = {};
  for (const k of allowed) {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') query[k] = params[k];
  }
  const requestPath = '/api/v6/dex/market/trades?' + new URLSearchParams(query).toString();

  if (paywallActive()) throw new Error('OKX DEX 接口处于 402 付费墙冷却期，已跳过（链上直采仍在工作）');

  // OKX 会突发 429（50011 Too Many Requests），退避重试
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.get(BASE_URL + requestPath, {
        headers: authHeaders(requestPath),
        timeout: 20000,
      });
      return res.data;
    } catch (e) {
      lastErr = e;
      if (notePaywall(e)) throw e;        // 402 = 付费墙，重试没意义
      const st = e.response ? e.response.status : 0;
      const code = e.response && e.response.data ? String(e.response.data.code || '') : '';
      const retryable = st === 429 || st >= 500 || code === '50011';
      if (!retryable || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, attempt * 800));
    }
  }
  throw lastErr;
}

/**
 * 批量查链上交易明细（OKX Explorer 接口，单次最多 20 个哈希，重复自动去重）
 *   GET /api/v6/explorer/transaction/transaction-multi?chainIndex=&txId=a,b,c
 *
 * 返回字段：txId / methodId / to / from / isToContract / isFromContract / state ...
 * @returns {Promise<Map<string, object>>} txId(小写) -> 明细
 */
export async function fetchTxMulti(txHashes, chainIndex = '8453') {
  const list = [...new Set((txHashes || []).filter(Boolean).map((h) => String(h).toLowerCase()))];
  const out = new Map();
  const CHUNK = 20;

  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const requestPath =
      '/api/v6/explorer/transaction/transaction-multi?' +
      new URLSearchParams({ chainIndex: String(chainIndex), txId: chunk.join(',') }).toString();

    if (paywallActive()) throw new Error('OKX Explorer 接口处于 402 付费墙冷却期，已跳过（路由判定已改走 RPC）');

    let res = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        res = await axios.get(BASE_URL + requestPath, { timeout: 20000, headers: authHeaders(requestPath) });
        break;
      } catch (e) {
        if (notePaywall(e)) throw e;
        const st = e.response ? e.response.status : 0;
        const code = e.response && e.response.data ? String(e.response.data.code || '') : '';
        if (attempt === 4) throw e;
        if (st && st !== 429 && st < 500 && code !== '50011') throw e;
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }

    const body = res.data || {};
    if (String(body.code) !== '0') {
      throw new Error('explorer api error: code=' + body.code + ' msg=' + (body.msg || ''));
    }
    for (const item of body.data || []) {
      if (item && item.txId) out.set(String(item.txId).toLowerCase(), item);
    }
    await new Promise((r) => setTimeout(r, 150)); // 轻节流，避开突发 429
  }
  return out;
}
