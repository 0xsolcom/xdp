/**
 * Solana 那点东西：base58 编解码 + ed25519 密钥。
 *
 * 报名接口要一把 **ed25519 签名**（64 字节，对模板原文签），
 * 而 EVM 私钥推不出对应的 Solana 私钥 —— 好在服务端只按我们
 * `wallet/create` 时申报的 Solana 地址验签，不校验派生关系，
 * 所以没有真 Solana 私钥时用「占位密钥」即可（见 placeholderSolPriv）。
 */

import crypto from 'crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`非法 base58 字符：${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(hex, 'hex');
  let zeros = 0;
  for (const c of str) { if (c === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** 由 32 字节 seed 造 ed25519 私钥对象 */
export const ed25519FromSeed = (seed) => crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der',
  type: 'pkcs8',
});

export const solAddressOf = (priv) =>
  b58encode(crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).slice(-32));

/**
 * 占位 Solana 私钥：由 EVM 私钥确定性派生（同一把钱包每次跑结果一致）。
 * 服务端只按 create 时申报的地址验签，所以它不需要是该 EVM 地址真正的 Solana 对应地址。
 */
export const placeholderSolPriv = (evmPk) =>
  ed25519FromSeed(crypto.createHash('sha256').update(`okx-competition-sol:${evmPk}`).digest());

/** 解析用户给的 Solana 私钥：支持 base58(64 字节 / 32 字节) 或 64 位 hex seed */
export function parseSolKey(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const b = b58decode(s);
    if (b.length === 64) return ed25519FromSeed(b.slice(0, 32));
    if (b.length === 32) return ed25519FromSeed(b);
  } catch { /* 不是 base58，试 hex */ }
  const hex = s.replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return ed25519FromSeed(Buffer.from(hex, 'hex'));
  throw new Error(`无法识别的 Solana 私钥：${s.slice(0, 12)}…`);
}
