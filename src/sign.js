/**
 * OKX 私有接口请求签名（从 OKX Wallet 扩展 4.17.11 源码读出，实测全中）
 *
 * 三个头：
 *   Ok-Verify-Token = 随机 UUID v4
 *   Ok-Timestamp    = Date.now()（毫秒，原样回填）
 *   Ok-Verify-Sign  = base64( HMAC-SHA256(key, msg) )
 *     key: m = sha256hex(token)                // 64 个 hex 字符
 *          p = floor(Ok-Timestamp / 1000)      // 秒
 *          g = floor(p / 600  % 32)            // 10 分钟档
 *          S = floor(p / 3600 % 32)            // 小时档
 *          key = concat( m[(g + (S+E)*E) % 32] for E in 0..31 )   // 32 个 ASCII 字符
 *     msg: POST/PUT/PATCH → pathname + body（丢弃 query；body 必须与发送字节完全一致）
 *          其余方法      → (pathname + search) 去掉第一个 '?'
 *     ⚠️ msg 不含 timestamp。时间只影响 key 的取字符位置，
 *        所以签名与 Ok-Timestamp 是一对，换时间戳必须重签。
 *
 * web3.okx.com 上的请求**不需要** User-Device-Sign（那是 wallet.ouxyi.cash 的插件链路要的）。
 */

import crypto from 'crypto';

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** 由 token + 毫秒时间戳推出 HMAC 密钥（32 个 ASCII 字符） */
export function deriveVerifyKey(token, timestampMs) {
  const m = sha256hex(token);
  const p = Math.floor(timestampMs / 1000);
  const g = Math.floor((p / 600) % 32);
  const S = Math.floor((p / 3600) % 32);
  let key = '';
  for (let E = 0; E < 32; E++) key += m[(g + (S + E) * E) % 32];
  return key;
}

/** 算一次 Ok-Verify-Token / Ok-Timestamp / Ok-Verify-Sign */
export function makeVerifySign({ method, pathWithQuery, body = null, timestamp = Date.now() }) {
  const token = crypto.randomUUID();
  const key = deriveVerifyKey(token, timestamp);
  const upper = String(method || 'GET').toUpperCase();
  const msg = ['POST', 'PUT', 'PATCH'].includes(upper)
    ? pathWithQuery.split('?')[0] + (body ?? '')
    : pathWithQuery.replace('?', '');
  const signature = crypto
    .createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(Buffer.from(msg, 'utf8'))
    .digest('base64');
  return { token, timestamp, signature };
}

/**
 * 自检：拿 HAR 里已存在的请求重算签名逐条比对。
 * 用来确认算法/字段偏移没变（OKX 改版后可能需要重新逆向）。
 */
export function selfTest(harPath, fsMod) {
  const fs = fsMod;
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  let ok = 0;
  const bad = [];
  for (const e of har.log.entries) {
    const h = {};
    for (const x of e.request.headers) h[String(x.name).toLowerCase()] = x.value;
    if (!h['ok-verify-token'] || !h['ok-timestamp'] || !h['ok-verify-sign']) continue;
    const u = new URL(e.request.url);
    const body = e.request.postData?.text ?? null;
    const key = deriveVerifyKey(h['ok-verify-token'], Number(h['ok-timestamp']));
    const upper = e.request.method.toUpperCase();
    const msg = ['POST', 'PUT', 'PATCH'].includes(upper)
      ? u.pathname + (body ?? '')
      : (u.pathname + u.search).replace('?', '');
    const got = crypto
      .createHmac('sha256', Buffer.from(key, 'utf8'))
      .update(Buffer.from(msg, 'utf8'))
      .digest('base64');
    if (got === h['ok-verify-sign']) ok++;
    else bad.push({ url: u.pathname, method: upper, expect: h['ok-verify-sign'], got });
  }
  return { ok, bad, total: ok + bad.length };
}
