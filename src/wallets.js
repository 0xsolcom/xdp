/**
 * 私钥文件解析与「这一轮处理哪些钱包」的选择。
 */

import fs from 'fs';
import { Wallet } from 'ethers';
import { placeholderSolPriv, parseSolKey } from './solana.js';

/**
 * 从文件里抠出所有 EVM 私钥。
 * 认三种写法：每行一个 0x…、每行一个裸 hex、夹在 env 文本里（KEY=0x…）。
 * 顺序即行序 —— `--from/--to` 和 `--sol-keys` 都按这个序号对应。
 */
export function parseEvmKeys(file) {
  if (!fs.existsSync(file)) throw new Error(`找不到私钥文件：${file}`);
  const txt = fs.readFileSync(file, 'utf8');
  const keys = [...txt.matchAll(/(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)]
    .map((m) => '0x' + m[1].toLowerCase());
  if (!keys.length) throw new Error(`私钥文件里没解析出 EVM 私钥：${file}`);
  return keys;
}

export function parseSolKeys(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`找不到 Solana 私钥文件：${file}`);
  return fs.readFileSync(file, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
}

/**
 * 选中要处理的钱包。
 *
 * --wallets 支持三种写法（逗号分隔，可混用）：
 *   序号区间：31-100        —— 按私钥文件行序取第 31~100 把（可交易）
 *   单个序号：7             —— 等价于 7-7
 *   地址    ：0xabc…,0xdef… —— 不需要私钥（只能查状态，不能交易/报名）
 * 不传 --wallets 时，按 --from/--to/--limit 从私钥文件切片。
 */
export function selectWallets({ walletsArg, keysFile, solKeysFile, from, to, limit, onWarn }) {
  if (walletsArg) {
    const parts = String(walletsArg).split(',').map((s) => s.trim()).filter(Boolean);
    const needKeys = parts.some((p) => /^\d+(-\d+)?$/.test(p));
    const keys = needKeys ? parseEvmKeys(keysFile) : null;
    const solRaw = needKeys ? parseSolKeys(solKeysFile) : null;
    const out = [];

    for (const p of parts) {
      const m = p.match(/^(\d+)(?:-(\d+))?$/);

      // ① 序号区间：31-100 / 7
      if (m) {
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        if (a < 1) throw new Error(`--wallets 序号从 1 开始：${p}`);
        if (b < a) throw new Error(`--wallets 区间写反了：${p}`);
        if (b > keys.length) onWarn?.(`--wallets ${p} 超出私钥文件（共 ${keys.length} 把），已截断到 ${keys.length}`);
        const last = Math.min(b, keys.length);
        for (let i = a; i <= last; i++) {
          const pk = keys[i - 1];
          if (!pk) continue;
          let solPriv;
          if (solRaw) {
            if (i - 1 >= solRaw.length) {
              onWarn?.(`--sol-keys 只给了 ${solRaw.length} 行，第 ${i} 个钱包没有对应 Solana 私钥，改用占位密钥`);
              solPriv = placeholderSolPriv(pk);
            } else {
              solPriv = parseSolKey(solRaw[i - 1]);
            }
          } else {
            solPriv = placeholderSolPriv(pk);
          }
          out.push({ index: i, pk, wallet: new Wallet(pk), solPriv });
        }
        continue;
      }

      // ② 地址
      if (/^0x[0-9a-fA-F]{40}$/.test(p)) {
        out.push({ index: out.length + 1, address: p, pk: null, wallet: null, solPriv: null });
        continue;
      }

      throw new Error(`--wallets 里有非法项：${p}（支持地址 0x…，或序号写法 7 / 31-100）`);
    }
    return limit > 0 ? out.slice(0, limit) : out;
  }

  const keys = parseEvmKeys(keysFile);
  const solRaw = parseSolKeys(solKeysFile);
  const out = [];
  const last = to > 0 ? Math.min(to, keys.length) : keys.length;
  for (let i = from; i <= last; i++) {
    const pk = keys[i - 1];
    if (!pk) continue;
    let solPriv;
    if (solRaw) {
      if (i - 1 >= solRaw.length) {
        onWarn?.(`--sol-keys 只给了 ${solRaw.length} 行，第 ${i} 个钱包没有对应 Solana 私钥，改用占位密钥`);
        solPriv = placeholderSolPriv(pk);
      } else {
        solPriv = parseSolKey(solRaw[i - 1]);
      }
    } else {
      solPriv = placeholderSolPriv(pk);
    }
    out.push({ index: i, pk, wallet: new Wallet(pk), solPriv });
  }
  return limit > 0 ? out.slice(0, limit) : out;
}
