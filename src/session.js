/**
 * web3.okx.com 的会话：从浏览器导出的 HAR 里抽出可长期复用的东西。
 *
 * 关键只有 `x-fptoken`（设备指纹令牌，payload 里没有 exp，抓一次能用很久）
 * 和 `devid`。每次请求都会变的 `ok-verify-*` 一律不要 —— 由 src/sign.js 现场重算。
 *
 * ⚠️ `x-fptoken` 等价于「这台设备已登录的凭据」，泄露 = 别人能拿你的会话调接口。
 */

import fs from 'fs';
import path from 'path';

export const HOST = 'https://web3.okx.com';

/**
 * 复刻真实会话时要一并带上的「稳定请求头」。
 * 每次请求都会变的（ok-verify-*、x-id-group、x-web3-authsign…）不收；
 * accept-encoding / content-length 交给 Node 的 fetch 自己管理，也不收。
 */
const BROWSER_EXTRA_HEADERS = [
  'cache-control', 'pragma', 'priority',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'x-discover-auth-token', 'x-simulated-trading',
];

const lcHeaders = (headers) => {
  const o = {};
  for (const h of headers) o[String(h.name).toLowerCase()] = h.value;
  return o;
};

/** 从 HAR 里抽 web3.okx.com 的会话 */
export function extractWeb3Session(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  const entries = har?.log?.entries || [];
  if (!entries.length) throw new Error(`HAR 里没有请求：${harPath}`);

  const onHost = entries.filter((e) => /web3\.okx\.com/.test(e.request.url));
  if (!onHost.length) throw new Error('HAR 里没有 web3.okx.com 的请求（确认抓的是 web3.okx.com 页面）');

  const ref = onHost.find((e) => {
    const h = lcHeaders(e.request.headers);
    return h['x-fptoken'] && h['devid'];
  }) || onHost.find((e) => /\/priapi\//.test(e.request.url)) || onHost[0];

  const h = lcHeaders(ref.request.headers);
  if (!h['x-fptoken']) throw new Error('HAR 里没有 x-fptoken —— 需要在已登录 OKX Web3 的浏览器里抓包');
  if (!h['devid']) throw new Error('HAR 里没有 devid');

  // 浏览器稳定头：跨所有 web3.okx.com 请求取首个出现的值
  // （有些头只出现在部分请求上，只看 ref 那一条会漏）
  const headerExtras = {};
  for (const e of onHost) {
    const eh = lcHeaders(e.request.headers);
    for (const n of BROWSER_EXTRA_HEADERS) {
      if (headerExtras[n] === undefined && eh[n] !== undefined) headerExtras[n] = eh[n];
    }
  }

  return {
    host: HOST,
    devid: h['devid'],
    deviceToken: h['device-token'] || h['devid'],
    fptoken: h['x-fptoken'],
    fptokenSignature: h['x-fptoken-signature'] || '',
    siteInfo: h['x-site-info'] || '',
    referer: h['referer'] || 'https://web3.okx.com/zh-hans/boost/trading-competition',
    origin: h['origin'] || 'https://web3.okx.com',
    userAgent: h['user-agent'] || '',
    acceptLanguage: h['accept-language'] || 'zh-CN,zh;q=0.9',
    locale: h['x-locale'] || 'zh_CN',
    xCdn: h['x-cdn'] || 'https://static.coinall.ltd',
    xUtc: h['x-utc'] || '8',
    xZkdexEnv: h['x-zkdex-env'] || '0',
    platform: h['platform'] || 'web',
    cookie: h['cookie'] || '',
    headerExtras,
    capturedAt: ref.startedDateTime || new Date().toISOString(),
    sourceHar: harPath,
  };
}

export function saveSession(file, session) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

export function loadSession(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 在 当前目录 / 项目根 / ~/Downloads 里找 .har，按修改时间倒序 */
export function findHarFiles(projectRoot) {
  const dirs = [process.cwd(), projectRoot, path.join(process.env.HOME || '', 'Downloads')];
  const out = [];
  for (const d of dirs) {
    if (!d) continue;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/\.har$/i.test(n)) continue;
      const full = path.join(d, n);
      try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* 忽略 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.file);
}

/**
 * 汇总 HAR 里浏览器到 web3.okx.com 的请求头（按请求方法取并集），
 * 供 `--verify-headers` 比对「工具发的头 vs 浏览器真实头」。
 * HTTP/2 伪头（:authority 等）已剔除。
 */
export function collectBrowserHeaders(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  const entries = (har?.log?.entries || []).filter((e) => /web3\.okx\.com/.test(e.request.url));
  const byEndpoint = {};
  for (const e of entries) {
    const u = new URL(e.request.url);
    const method = String(e.request.method || 'GET').toUpperCase();
    const key = `${method} ${u.pathname}`;
    if (byEndpoint[key]) continue;                 // 每个 endpoint 只取第一条
    const headers = {};
    for (const h of e.request.headers) {
      const k = String(h.name).toLowerCase();
      if (k.startsWith(':')) continue;
      headers[k] = String(h.value);
    }
    byEndpoint[key] = { method, path: u.pathname, headers };
  }
  return { byEndpoint, total: entries.length };
}
