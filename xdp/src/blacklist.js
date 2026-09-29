import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
// override: .env 优先于 Shell 环境变量（部署机上常有别的项目导出的 DB_* / CHAIN_* 变量）
dotenv.config({ override: true });

// ============================ 黑名单（支持热更新） ============================
// 启动时加载一次；之后每隔 BLACKLIST_RELOAD_MS 检查一次 .env 的修改时间，
// 一旦 .env 被改动就自动重新加载，无需重启进程。
// 优先读 .env 文件，读不到时回退到进程环境变量（容器 / systemd 场景）。
const ENV_FILE = path.resolve(process.cwd(), '.env');
const RELOAD_MS = Number(process.env.BLACKLIST_RELOAD_MS || 60000);

function parseList(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

function readRawFromEnvFile() {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    // 只用横向空白（[ \t]），别让 \s 跨行吃掉下一行的内容
    const m = content.match(/^[ \t]*BLACKLIST_WALLETS[ \t]*=[ \t]*(.*?)[ \t]*$/m);
    if (m) return m[1].split('#')[0];
  } catch {
    // .env 不存在或不可读，回退到进程环境变量
  }
  return process.env.BLACKLIST_WALLETS || '';
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

let blacklistSet = new Set();
let lastCheckAt = 0;
let lastMtimeMs = -1;

export function reloadBlacklist(force = false) {
  const now = Date.now();
  if (!force && now - lastCheckAt < RELOAD_MS) return false;

  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(ENV_FILE).mtimeMs;
  } catch {
    mtimeMs = -1;
  }

  if (!force && lastCheckAt !== 0 && mtimeMs === lastMtimeMs) {
    lastCheckAt = now;
    return false;
  }

  lastCheckAt = now;
  lastMtimeMs = mtimeMs;

  const next = parseList(readRawFromEnvFile());
  if (sameSet(next, blacklistSet)) return false;

  const added = [...next].filter((x) => !blacklistSet.has(x));
  const removed = [...blacklistSet].filter((x) => !next.has(x));
  blacklistSet = next;

  const brief = (arr) => (arr.length <= 5 ? arr.join(', ') : arr.slice(0, 5).join(', ') + ` … 等 ${arr.length} 个`);
  console.log(`[黑名单] 已加载 ${blacklistSet.size} 个地址`);
  if (added.length) console.log(`[黑名单] 新增: ${brief(added)}`);
  if (removed.length) console.log(`[黑名单] 移除: ${brief(removed)}`);
  return true;
}

/** 判断钱包是否在黑名单（同步，O(1)）；内部按节流间隔自动热更新 */
export function isBlacklisted(wallet) {
  if (!wallet) return false;
  reloadBlacklist();
  return blacklistSet.has(wallet.toLowerCase());
}

export function blacklistSize() {
  return blacklistSet.size;
}

reloadBlacklist(true);
