/**
 * 带自动签名 + 重试 + 请求头随机化的 web3.okx.com 客户端。
 *
 * 默认行为：
 *   - 随机化身份类字段（devid / UA / fptoken / locale / platform / x-cdn / x-zkdex-env 等）；
 *   - 同一 session 复用同一份随机身份（sticky），避免签名/风控对不上；
 *   - 签名相关字段（ok-timestamp / ok-verify-sign / ok-verify-token / x-request-timestamp）不随机；
 *   - GET 不带 origin / content-type，POST/PUT/PATCH 才带。
 *
 * 可通过 session.headerRandom 控制：
 *   { enabled: false }        关闭随机，完全使用 session 上的固定字段
 *   { sticky: false }         每个请求换一份新身份（谨慎使用）
 *   { rng: fn }               注入自定义随机源（可复现）
 *   { identity: {...} }       手动指定一份身份
 *   { randomIdGroup: false }  不随机 x-id-group 前缀
 *
 * session 上显式给出的字段优先于随机值，例如 session.devid 一旦提供就固定。
 */

import crypto from 'crypto';
import { makeVerifySign } from './sign.js';
import { apiGate } from './pool.js';

export const codeOf = (j) => String(j?.code ?? j?.error_code ?? '');
export const msgOf = (j) => j?.msg || j?.error_message || j?.detailMsg || j?.raw || '';

const isTransient = (r) => {
  if (r.status >= 500 || r.status === 429) return true;
  if (/ECONN|ETIMEDOUT|fetch failed|socket hang up|network/i.test(String(r.json?.raw || ''))) return true;
  const code = String(r.json?.code ?? r.json?.error_code ?? '');
  const msg = String(r.json?.msg || r.json?.error_message || r.json?.detailMsg || r.json?.raw || '');
  // OKX 偶发 100010 / 10104（quoteId 秒级过期）等，重试可能有救
  if (/^(100010|10104)$/.test(code)) return true;
  if (/100010|10104|请求已过期|请重试|频繁|timeout|超时/i.test(msg)) return true;
  return false;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

/* ------------------------------------------------------------------ *
 * 随机工具
 * ------------------------------------------------------------------ */

const defaultRng = Math.random;

const randInt = (rng, min, max) => Math.floor(rng() * (max - min + 1)) + min;
const pick = (rng, arr) => arr[randInt(rng, 0, arr.length - 1)];

const hex = (rng, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += '0123456789abcdef'[randInt(rng, 0, 15)];
  return s;
};

const uuid = (rng) =>
  `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${pick(rng, ['8', '9', 'a', 'b'])}${hex(rng, 3)}-${hex(rng, 12)}`;

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];

const LANG_POOL = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'ja-JP,ja;q=0.9,en;q=0.8',
  'ko-KR,ko;q=0.9,en;q=0.8',
];

const LOCALE_POOL = ['en_US', 'en_GB', 'zh_CN', 'ja_JP', 'ko_KR'];
const PLATFORM_POOL = ['web', 'web', 'web', 'h5'];
const CDN_POOL = ['okx-cdn-a', 'okx-cdn-b', 'okx-cdn-c'];
const ZKDEX_POOL = ['prod', 'prod', 'prod', 'canary'];

/**
 * 生成一份随机身份。session 上显式给出的字段优先（可固定），否则随机。
 */
export function makeRandomIdentity({ rng = defaultRng, session = {} } = {}) {
  const hr = session.headerRandom || {};
  const ua = hr.userAgent || pick(rng, UA_POOL);
  const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1] || '124';
  const plat = /Windows/.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/.test(ua) ? 'macOS'
      : /Android/.test(ua) ? 'Android'
        : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : 'Linux';
  // devid 默认用会话里抓到的：服务端把会话和 devid 绑定了，乱换会让 DEX 报价返回空路由。
  // 想强制随机设 RANDOM_DEVID=1；想固定设 DEVID=<uuid>；hr.devid 最优先。
  const randomDevid = /^(1|true|yes|on)$/i.test(String(hr.randomDevid ?? process.env.RANDOM_DEVID ?? '').trim());
  const devid = hr.devid || process.env.DEVID || (randomDevid ? crypto.randomUUID() : (session.devid || crypto.randomUUID()));
  return {
    devid: devid,
    userAgent: ua,
    acceptLanguage: hr.acceptLanguage || pick(rng, LANG_POOL),
    locale: hr.locale || pick(rng, LOCALE_POOL),
    platform: hr.platform || pick(rng, PLATFORM_POOL),
    // 跟 UA 对齐的 Client Hints（随机化 UA 时必须一起换，否则对不上）
    secChUa: '"Chromium";v="' + chrome + '", "Google Chrome";v="' + chrome + '", "Not-A.Brand";v="99"',
    secChUaMobile: /Android|iPhone|iPad/.test(ua) ? '?1' : '?0',
    secChUaPlatform: '"' + plat + '"',
    // 有明确取值 / 必须和会话一致的，不随机
    xCdn: session.xCdn ?? pick(rng, CDN_POOL),
    xZkdexEnv: session.xZkdexEnv ?? pick(rng, ZKDEX_POOL),
    fptoken: session.fptoken ?? hex(rng, 32),
    // device-token 也是设备标识：会话里没有独立值就用随机 devid
    deviceToken: (session.deviceToken && session.deviceToken !== session.devid) ? session.deviceToken : devid,
    xDiscoverAuthToken: session.xDiscoverAuthToken ?? '',
    xUtc: hr.xUtc || String(randInt(rng, -12, 14)),
    origin: session.origin,
    referer: session.referer,
  };
}

/* ------------------------------------------------------------------ *
 * 头组装
 * ------------------------------------------------------------------ */

/**
 * 组装一个请求的头。
 *
 * 不随机化签名相关字段：
 *   ok-timestamp / ok-verify-sign / ok-verify-token / x-request-timestamp
 *
 * 不随机化 origin / content-type：
 *   只在带 body 的方法上出现（浏览器 GET 不发）。
 */
export function buildHeaders(session, {
  method,
  path,
  bodyStr = null,
  timestamp = Date.now(),
  idPrefix = Date.now(),
  seq = 1,
  headers = null,
  random = {},
} = {}) {
  const upper = String(method || 'GET').toUpperCase();

  // 随机开关：默认开启
  const randomEnabled = random.enabled ?? session.headerRandom?.enabled ?? true;
  const sticky = random.sticky ?? session.headerRandom?.sticky ?? true;
  const rng = random.rng || session.headerRandom?.rng || defaultRng;

  let identity;
  if (randomEnabled) {
    if (sticky) {
      // 会话级缓存：同一 session 复用同一身份
      if (!session.__identity) {
        session.__identity = random.identity || makeRandomIdentity({ rng, session });
      }
      identity = session.__identity;
    } else {
      // 每请求一份新身份
      identity = random.identity || makeRandomIdentity({ rng, session });
    }
  } else {
    identity = {
      devid: session.devid,
      userAgent: session.userAgent,
      acceptLanguage: session.acceptLanguage,
      locale: session.locale,
      platform: session.platform,
      xCdn: session.xCdn,
      xZkdexEnv: session.xZkdexEnv,
      fptoken: session.fptoken,
      deviceToken: session.deviceToken,
      xDiscoverAuthToken: session.xDiscoverAuthToken,
      xUtc: session.xUtc,
      origin: session.origin,
      referer: session.referer,
    };
  }

  // 签名必须基于真实 method / path / body / timestamp
  const { token, signature } = makeVerifySign({
    method: upper,
    pathWithQuery: path,
    body: bodyStr,
    timestamp,
  });

  const h = {
    accept: 'application/json',
    'accept-language': identity.acceptLanguage,
    devid: identity.devid,
    'device-token': identity.deviceToken,
    'ok-timestamp': String(timestamp),
    'ok-verify-sign': signature,
    'ok-verify-token': token,
    platform: identity.platform,
    referer: identity.referer,
    'user-agent': identity.userAgent,
    'x-cdn': identity.xCdn,
    'x-fptoken': identity.fptoken,
    'x-id-group': `${idPrefix}-c-${seq}`,
    'x-locale': identity.locale,
    'x-request-timestamp': String(timestamp),
    'x-utc': identity.xUtc,
    'x-zkdex-env': identity.xZkdexEnv,
    ...(session.headerExtras || {}),
  };

  // x-id-group 默认也随机前缀
  if (randomEnabled && (random.randomIdGroup ?? session.headerRandom?.randomIdGroup ?? true)) {
    h['x-id-group'] = `${hex(rng, 8)}-c-${seq}`;
  }

  if (BODY_METHODS.includes(upper)) {
    h.origin = identity.origin;
    h['content-type'] = 'application/json';
  }

  if (session.fptokenSignature) h['x-fptoken-signature'] = session.fptokenSignature;
  if (session.siteInfo) h['x-site-info'] = session.siteInfo;

  if (headers) Object.assign(h, headers);

  // UA 对齐的 Client Hints（UA 随机化时必须一起换，否则对不上）
  if (randomEnabled) {
    if (identity.secChUa) h['sec-ch-ua'] = identity.secChUa;
    if (identity.secChUaMobile) h['sec-ch-ua-mobile'] = identity.secChUaMobile;
    if (identity.secChUaPlatform) h['sec-ch-ua-platform'] = identity.secChUaPlatform;
  }

  // cookie：带上本次请求的 devid（okx_device_id）；会话里抽到 cookie 就用会话的
  const devidForCookie = (headers && headers.devid) || identity.devid;
  const noCookie = session.headerRandom && session.headerRandom.noCookie;
  if (devidForCookie && !h.cookie && !noCookie) {
    h.cookie = session.cookie || ('okx_device_id=' + devidForCookie);
  }

  // 按接口族精确对齐
  if (!path.startsWith('/priapi/v2/wallet/')) delete h['device-token'];
  if (!/^\/priapi\/v1\/dapp\//.test(path)) delete h['x-discover-auth-token'];

  for (const k of Object.keys(h)) if (h[k] === undefined || h[k] === '') delete h[k];
  return h;
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

export function createClient(session, { gateMs = 0 } = {}) {
  let seq = 0;
  const idPrefix = Date.now();
  const rng = session.headerRandom?.rng || defaultRng;

  async function request(method, pathname, { body = null, query = null, headers = null } = {}) {
    // 全局节流（可选）：多钱包并发时，把整个进程发往 OKX 的请求速率压成一个常量，
    // 与并发数解耦 —— 加并发只增加「同时在等回执」的位数，不增加请求速率。
    if (gateMs > 0) await apiGate(gateMs);
    const qs = query ? new URLSearchParams(query).toString() : '';
    const path = qs ? `${pathname}?${qs}&t=${Date.now()}` : `${pathname}?t=${Date.now()}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    const timestamp = Date.now();

    const h = buildHeaders(session, {
      method,
      path,
      bodyStr,
      timestamp,
      idPrefix,
      seq: ++seq,
      headers,
      random: {
        enabled: session.headerRandom?.enabled ?? true,
        sticky: session.headerRandom?.sticky ?? true,
        rng,
      },
    });

    const res = await fetch(session.host + path, {
      method,
      headers: h,
      body: bodyStr ?? undefined,
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    return { status: res.status, json };
  }

  return {
    post: (p, body, headers) => request('POST', p, { body, headers }),
    get: (p, query, headers) => request('GET', p, { query, headers }),
  };
}

/* ------------------------------------------------------------------ *
 * 重试
 * ------------------------------------------------------------------ */

/**
 * 带重试的调用。只重试网络错误 / 5xx / 429；
 * 业务错误（code 非 0）立刻返回 —— 重试也不会变。
 */
export async function apiRetry(fn, { label = '接口', tries = 3, onWarn } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fn();
      if (isTransient(r) && i < tries) {
        onWarn?.(`${label} 第 ${i} 次失败（HTTP ${r.status}），${600 * i}ms 后重试`);
        await sleep(600 * i);
        continue;
      }
      return r;
    } catch (e) {
      last = e;
      if (i >= tries) break;
      onWarn?.(`${label} 第 ${i} 次异常：${e.message}，${600 * i}ms 后重试`);
      await sleep(600 * i);
    }
  }
  throw last || new Error(`${label} 重试 ${tries} 次仍失败`);
}