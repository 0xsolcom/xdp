/**
 * 共享 JSON-RPC 客户端（带批量 + 节点轮换）。
 *
 * 为什么单独抽出来：OKX 的 DEX / Explorer 接口在 2026-09-29 切到了 x402 付费
 * （每月免费 100K 次，超出 $0.0001/次）。但我们真正需要的只有「一个 tx 的 to + input」
 * —— eth_getTransactionByHash 在公共 RPC 上免费就能给。所以把这类查询全部改成走 RPC。
 *
 * ⚠️ Base 公共节点里有一部分取不到回执（publicnode 直接报 archive token，llamarpc 返回 HTML），
 *    所以默认给了一组实测可用的备用节点，主节点失败自动轮换。
 */
import axios from 'axios';
import dotenv from 'dotenv';
// 和 db.js / okx.js / config.js 一样：override 让 .env 优先于 Shell 环境变量
// （部署机上常有别的项目导出的 CHAIN_RPC_URL / DB_* 变量，不 override 会串味）
dotenv.config({ override: true });

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const PRIMARY = splitList(process.env.CHAIN_RPC_URL || 'https://mainnet.base.org');
const FALLBACK = splitList(
  process.env.CHAIN_RPC_FALLBACKS ||
  'https://base.drpc.org,https://mainnet.base.org,https://base.gateway.tenderly.co,https://developer-access-mainnet.base.org'
);

export const RPC_URLS = [...new Set([...PRIMARY, ...FALLBACK])];

let rr = 0;
const nextUrl = () => RPC_URLS[rr++ % RPC_URLS.length];

/** 单条 JSON-RPC；失败自动换下一个节点 */
export async function rpcCall(method, params = [], { timeout = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < RPC_URLS.length; i++) {
    const url = nextUrl();
    try {
      const res = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout });
      if (res.data && res.data.error) throw new Error(res.data.error.message || 'rpc error');
      return res.data ? res.data.result : null;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有 RPC 节点都失败');
}

const envNum = (k, d) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** 试一次 JSON-RPC batch；节点把批量吞掉（返回条数对不上）就算失败，返回 null */
async function tryBatch(chunk, timeout) {
  const body = chunk.map((c, j) => ({ jsonrpc: '2.0', id: j + 1, method: c.method, params: c.params }));
  for (let a = 0; a < RPC_URLS.length; a++) {
    const url = nextUrl();
    try {
      const res = await axios.post(url, body, { timeout });
      const arr = Array.isArray(res.data) ? res.data : [];
      // ★ 完整性校验：公共节点对批量的支持差异极大
      //   实测 base.org 发 20 条只回 1 条、drpc 免费版直接 500 拒绝 >3 条。
      //   条数对不上宁可当作失败，也不能返回半截结果造成「静默漏判」。
      if (arr.length !== chunk.length) continue;
      const byId = new Map(arr.filter(Boolean).map((x) => [x.id, x]));
      const out = [];
      let complete = true;
      for (let j = 1; j <= chunk.length; j++) {
        const one = byId.get(j);
        if (!one) { complete = false; break; }
        out.push(one.error ? null : one.result);
      }
      if (complete) return out;
    } catch (e) { /* 换下一个节点 */ }
  }
  return null;
}

/**
 * 批量 JSON-RPC：小批量走 batch，拿不全就退回单条并发查询。
 * 保证「能查到的都查到」，绝不会因为节点不支持批量而静默漏掉一批。
 */
export async function rpcBatch(calls, opts = {}) {
  const timeout = opts.timeout || 25000;
  const chunkSize = Math.max(1, opts.chunkSize || envNum('RPC_BATCH_SIZE', 5));
  const conc = Math.max(1, opts.concurrency || envNum('RPC_CONCURRENCY', 6));
  const out = new Array(calls.length).fill(null);

  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    const got = await tryBatch(chunk, timeout);
    if (got) {
      for (let j = 0; j < chunk.length; j++) out[i + j] = got[j];
      continue;
    }
    // 单条兜底（限并发，别把公共节点打挂）
    for (let j = 0; j < chunk.length; j += conc) {
      const part = chunk.slice(j, j + conc);
      const rs = await Promise.all(part.map((c) => rpcCall(c.method, c.params, { timeout }).catch(() => null)));
      for (let k = 0; k < part.length; k++) out[i + j + k] = rs[k];
    }
  }
  return out;
}
