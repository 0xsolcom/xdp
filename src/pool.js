/**
 * 并发池 + 全局 API 闸门 + 带标签的日志上下文 —— 多钱包并发共用。
 *
 * 并发单位是「钱包」：每个钱包是**独立地址**，nonce 天然独立，互不冲突。
 * 真正要小心的是两件事：
 *   ① OKX 接口限流 —— 所有钱包共用同一个会话/devid，请求速率是全局的；
 *   ② 日志交错     —— 并发后分不清哪行属于哪个钱包。
 * ① 由 apiGate（整进程串行 + 最小间隔）和 runPool 的启动间隔一起解决，
 * ② 由 AsyncLocalStorage 标签解决。
 *
 * 语义约定：
 *   --concurrency 1  → 完全串行，行为与没有并发之前一致（日志也不带标签）
 *   --concurrency >1 → 同时跑 N 个；此时 --sleep 的含义从「每个钱包结束后等 N 秒」
 *                      变成「两次**启动**之间至少隔 N 秒」（全局节流）
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const logStore = new AsyncLocalStorage();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用当前异步上下文的标签给一行日志加前缀；串行（无标签）时原样返回 */
export function tagLine(s) {
  const tag = logStore.getStore()?.tag;
  return tag ? String(s).replace(/^(?!$)/, `${tag} `) : String(s);
}

/** 并发下的钱包标签：`[3/100 #37]`（序号按所选总数右对齐） */
export const walletTag = (n, total, index) =>
  `[${String(n).padStart(String(total).length)}/${total} #${index}]`;

/** 在带标签的异步上下文里跑 fn */
export function withTag(tag, fn) {
  return tag ? logStore.run({ tag }, fn) : fn();
}

/**
 * 并发执行池：同时最多跑 limit 个任务。
 * gapMs > 0 时保证**两次「启动」之间**至少隔 gapMs —— 时间槽是同步预留的，
 * 所以多个 worker 不会同时抢到同一个槽（这是躲 429 的关键）。
 *
 * @param {Array}    items       待处理项
 * @param {number}   limit       并发数（夹到 1..items.length）
 * @param {number}   gapMs       两次启动之间的最小间隔（0 = 不限）
 * @param {Function} fn          async (item, n, index) => void；n 从 1 起
 * @param {Function} shouldStop  返回 true 则不再领新任务（已在跑的不受影响）
 */
export async function runPool(items, limit, gapMs, fn, shouldStop = () => false) {
  let next = 0;
  let nextSlot = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    for (;;) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      if (gapMs > 0) {
        const now = Date.now();
        const at = Math.max(now, nextSlot);
        nextSlot = at + gapMs;
        if (at > now) await sleep(at - now);
      }
      await fn(items[i], i + 1, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** 解析 --concurrency（上限默认 8，防止手滑写个 1000 把接口打爆） */
export function parseConcurrency(raw, max = 8) {
  const n = Math.floor(Number(raw) || 1);
  return Math.min(max, Math.max(1, n));
}

/* ------------------------------------------------------------------ *
 * 全局 API 闸门
 * ------------------------------------------------------------------ *
 * 所有「走 OKX 接口」的请求都从这里过：整进程串行，任意两次请求间隔 >= gapMs。
 * 为什么不能各 worker 各自 sleep：那样并发数一高，实际请求速率就翻 N 倍，必然限流。
 * 这里把速率收成一个全局常量，与并发数解耦 —— 加并发只提升「同时在等回执」的位数，
 * 不提升请求速率。串行（gapMs<=0）时是空操作。
 */
let _gateChain = Promise.resolve();
let _gateLastAt = 0;
export function apiGate(gapMs) {
  const gap = Number(gapMs) || 0;
  if (gap <= 0) return Promise.resolve();
  _gateChain = _gateChain.then(async () => {
    const wait = _gateLastAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    _gateLastAt = Date.now();
  });
  return _gateChain;
}
export const apiGateLastAt = () => _gateLastAt;