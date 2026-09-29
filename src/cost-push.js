/**
 * 把交易报告里的「每个钱包真实磨损」上报到数据台（xdp/web/xdp.php?action=cost-ingest）。
 *
 * 为什么走 HTTP 而不是直连 MySQL：数据台和交易端不在同一台机器上，
 * 让 MySQL 的 3306 暴露到公网风险太大；服务器上已经有 PHP，让它代写最省事。
 *
 * 幂等性靠 runId：
 *   服务端唯一键是 (run_id, wallet_address)，同一份报告推多少次都只算一次。
 *   所以 runId 必须**对同一份报告稳定**，重推才不会翻倍：
 *     ① 报告 meta 里有 runId（新版本交易端会写）→ 直接用
 *     ② 没有（旧的报告文件）→ 用文件名 `trade-<时间戳>` 兜底
 *   两者都满足服务端的 /^[A-Za-z0-9._:-]{6,64}$/ 校验。
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_TIMEOUT_MS = Number(process.env.COST_PUSH_TIMEOUT_MS || 15000);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 拼上报地址：允许配 `.../xdp.php`、`.../xdp/` 或直接带 action 的完整 URL */
export function ingestEndpoint(base) {
  const u = String(base || '').trim();
  if (!u) return '';
  if (/[?&]action=/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'action=cost-ingest';
}

/** 同一份报告必须得到同一个 runId，否则重推会重复累加 */
export function runIdOf(report, jsonPath = '') {
  const fromMeta = report && report.meta && report.meta.runId;
  if (fromMeta && /^[A-Za-z0-9._:-]{6,64}$/.test(String(fromMeta))) return String(fromMeta);
  if (jsonPath) {
    const base = path.basename(String(jsonPath)).replace(/\.json$/i, '');
    if (/^[A-Za-z0-9._:-]{6,64}$/.test(base)) return base;
  }
  const meta = (report && report.meta) || {};
  const stamp = String(meta.finishedAt || meta.startedAt || '').replace(/[^0-9]/g, '').slice(0, 14);
  return 'trade-' + (stamp || Date.now());
}

/**
 * 从报告里挑出可直接入库的行。
 *   跳过：非地址 / 干跑（dry=1，没有真实支出）/ 完全没有金额的行（失败、跳过）
 * 注意「失败」行只要真有链上支出（花了钱没卖回来）也必须入库 —— 半截仓位照样是成本。
 */
export function buildCostPayload(report, { runId, chainIndex = 8453 } = {}) {
  const meta = (report && report.meta) || {};
  const rows = Array.isArray(report && report.rows) ? report.rows : [];
  const tradedAt = meta.finishedAt || meta.startedAt || new Date().toISOString();
  const wallets = [];

  for (const r of rows) {
    const addr = String((r && r.address) || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    if (Number(r.dry) === 1) continue;                      // 干跑没有真实支出
    const spent = num(r.spentUsdt);
    const received = num(r.receivedUsdt);
    if (spent == null && received == null) continue;        // 没花也没收 → 没成本
    const cost = num(r.costUsdt);
    wallets.push({
      address: addr,
      spent: spent || 0,
      received: received || 0,
      cost: cost != null ? cost : (spent || 0) - (received || 0),
      volume: (spent || 0) + (received || 0),               // 买 + 卖，与排行榜 volume 同口径
      gas: num(r.gasBnb) || 0,
      rounds: num(r.rounds) || 0,
      ok: Number(r.ok) === 1 ? 1 : 0,
      buyTx: r.buyTx || '',
      sellTx: r.sellTx || '',
      sweepTx: r.sweepTx || '',
      seconds: num(r.seconds),
      tradedAt,
    });
  }
  return { runId, chainIndex: String(chainIndex), wallets };
}

/** 上报一份报告文件。返回 { ok, skipped?, msg?, inserted?, skipped? } */
export async function pushCostReport(jsonPath, { url, token, chainIndex = 8453, timeoutMs = DEFAULT_TIMEOUT_MS, onWarn } = {}) {
  if (!url || !token) return { ok: false, skipped: true, msg: '未配置 COST_INGEST_URL / COST_INGEST_TOKEN' };
  if (!jsonPath || !fs.existsSync(jsonPath)) return { ok: false, msg: '报告文件不存在：' + jsonPath };

  let report;
  try { report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) { return { ok: false, msg: '报告解析失败：' + e.message }; }

  const runId = runIdOf(report, jsonPath);
  const payload = buildCostPayload(report, { runId, chainIndex });
  if (!payload.wallets.length) return { ok: false, skipped: true, runId, msg: '报告里没有可上报的真实交易（干跑 / 无金额）' };

  const endpoint = ingestEndpoint(url);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Ingest-Token': String(token) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); }
    catch { return { ok: false, runId, msg: 'HTTP ' + res.status + ' 返回非 JSON：' + txt.replace(/\s+/g, ' ').slice(0, 120) }; }
    if (!res.ok || !j.ok) return { ok: false, runId, status: res.status, msg: j.error || ('HTTP ' + res.status) };
    return { ok: true, runId, endpoint, received: j.received, inserted: j.inserted, skippedCount: j.skipped };
  } catch (e) {
    if (onWarn) onWarn('上报磨损失败：' + e.message);
    return { ok: false, runId, msg: e.message };
  }
}

/** 找 reports/ 下最新的报告文件（按文件名里的时间戳排，不靠 mtime） */
export function latestReport(dir = 'reports') {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const files = names.filter((n) => /^trade-\d{14}\.json$/.test(n)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : '';
}

/** 找 reports/ 下全部报告文件（按时间升序） */
export function allReports(dir = 'reports') {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^trade-\d{14}\.json$/.test(n)).sort().map((n) => path.join(dir, n));
}
