/**
 * 一买一卖的交易报告：CSV + JSON + 单文件 HTML。
 * 口径借鉴 okx-bank-wap/scripts/batch-report.js：
 *   投入 = 买腿链上真实流出多少 USDT；回收 = 卖腿链上真实流入多少 USDT；
 *   磨损 = 投入 − 回收；成本 bps = 磨损 ÷ 投入 × 10000（分母必须是本金，不是余额）；
 *   gas 由回执 gasUsed × 实际 gas 价；未清残留单列（残留就是裸敞口）。
 */
import fs from 'fs';
import path from 'path';
import { nativeSymbol, explorerTx } from './chains.js';

const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const f = (x, d) => (x == null || x === '' ? '' : Number(x).toFixed(d));
const escHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 区块浏览器链接按链取（Base→basescan，BSC→bscscan…）
const txLink = (h, chainId) => (h
  ? '<a class="mono" target="_blank" href="' + escHtml(explorerTx(chainId, h)) + '">' + escHtml(String(h).slice(0, 10)) + '…</a>'
  : '');

const COLUMNS = [
  'index', 'address', 'ok', 'stage', 'dry', 'positionOpen', 'direction',
  'spentUsdt', 'receivedUsdt', 'costUsdt', 'costBps',
  'buyOut', 'buyMin', 'sellIn', 'sellOut', 'residual',
  'gasBnb', 'slipIn', 'slipOut',
  'buyTx', 'sellTx', 'sweepTx',
  'seconds', 'error',
];

function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

function summarize(rows) {
  const ok = rows.filter((r) => Number(r.ok) === 1);
  const fail = rows.filter((r) => Number(r.ok) !== 1);
  const real = rows.filter((r) => !Number(r.dry) && Number(r.ok) === 1);
  const sum = (rs, k) => rs.reduce((s, r) => s + (num(r[k]) || 0), 0);
  const spentRows = real.filter((r) => num(r.spentUsdt) != null);
  const recvRows = real.filter((r) => num(r.receivedUsdt) != null);
  const spent = sum(spentRows, 'spentUsdt');
  const recv = sum(recvRows, 'receivedUsdt');
  const cost = spent - recv;
  const costBps = spent > 0 ? (cost / spent) * 10000 : null;
  const gasBnb = sum(real, 'gasBnb');
  const bps = real.map((r) => num(r.costBps)).filter((x) => x != null).sort((a, b) => a - b);
  const seconds = sum(rows, 'seconds');
  return {
    total: rows.length, ok: ok.length, fail: fail.length,
    dry: rows.length > 0 && real.length === 0,
    spent: spent, recv: recv, cost: cost, costBps: costBps, realN: real.length,
    gasBnb: gasBnb, seconds: seconds,
    avgBps: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : null,
    medBps: bps.length ? bps[Math.floor(bps.length / 2)] : null,
    minBps: bps.length ? bps[0] : null,
    maxBps: bps.length ? bps[bps.length - 1] : null,
    residualWallets: rows.filter((r) => Number(r.residual) > 0).length,
    openWallets: rows.filter((r) => Number(r.positionOpen) > 0).length,
    successRate: rows.length ? ok.length / rows.length : null,
  };
}

function toHtml(meta, rows) {
  const s = summarize(rows);
  const gsym = nativeSymbol(meta.chain);           // 原生币符号（Base=ETH / BSC=BNB）
  const tx = (h) => txLink(h, meta.chain);
  const card = (label, value, sub) =>
    '<div class="card"><div class="k">' + label + '</div><div class="v">' + value +
    '</div><div class="s">' + (sub || '') + '</div></div>';
  const bodyRows = rows.map((r) => {
    const ok = Number(r.ok) === 1;
    const dry = Number(r.dry) === 1;
    return '<tr data-ok="' + (ok ? '1' : '0') + '" data-bps="' + (num(r.costBps) == null ? '' : num(r.costBps).toFixed(2)) + '">' +
      '<td>' + escHtml(r.index) + '</td>' +
      '<td class="mono">' + escHtml(r.address) + '</td>' +
      '<td class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? (dry ? '干跑' : '成功') : '失败') + '</td>' +
      '<td>' + f(r.spentUsdt, 6) + '</td>' +
      '<td>' + f(r.receivedUsdt, 6) + '</td>' +
      '<td>' + f(r.costUsdt, 6) + '</td>' +
      '<td>' + f(r.costBps, 2) + '</td>' +
      '<td>' + f(r.gasBnb, 8) + '</td>' +
      '<td>' + f(r.buyOut, 6) + '</td>' +
      '<td class="' + (Number(r.residual) > 0 ? 'bad' : '') + '">' + f(r.residual, 6) + '</td>' +
      '<td>' + tx(r.buyTx) + '</td>' +
      '<td>' + tx(r.sellTx) + '</td>' +
      '<td>' + tx(r.sweepTx) + '</td>' +
      '<td>' + f(r.seconds, 1) + 's</td>' +
      '<td class="err">' + escHtml(r.error) + '</td>' +
      '</tr>';
  }).join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>交易报告 ' + escHtml(meta.startedAt) + '</title>',
    '<style>',
    ':root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e8ee;--dim:#8b93a7;--ok:#3ddc84;--bad:#ff5c5c;--acc:#4c8dff}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif}',
    '.wrap{max-width:1500px;margin:0 auto;padding:28px 20px 60px}',
    'h1{font-size:20px;margin:0 0 6px}',
    'h2{font-size:14px;margin:0 0 10px}',
    '.sub{color:var(--dim);font-size:12px;margin-bottom:18px}',
    '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px}',
    '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
    '.card .k{color:var(--dim);font-size:11px;letter-spacing:.04em}',
    '.card .v{font-size:19px;font-weight:600;margin:4px 0 2px;font-variant-numeric:tabular-nums}',
    '.card .s{color:var(--dim);font-size:11px}',
    '.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:16px}',
    '.scroll{overflow:auto;max-height:70vh}',
    'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}',
    'th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}',
    'th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}',
    'th{position:sticky;top:0;background:#1c2029;color:var(--dim);font-weight:500;font-size:11px;z-index:1}',
    'tbody tr:hover{background:#1c2029}',
    '.ok{color:var(--ok)}.bad{color:var(--bad)}',
    '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
    'a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}',
    'input,select{background:#0f1115;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 9px;font-size:12px}',
    '.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
    '.err{max-width:340px;white-space:normal;color:var(--bad);font-size:11px;text-align:left}',
    '</style></head><body><div class="wrap">',
    '<h1>OKX DEX 一买一卖报告</h1>',
    '<div class="sub">' + escHtml(meta.startedAt) + ' → ' + escHtml(meta.finishedAt) + ' ｜ ' + escHtml(meta.mode) +
      ' ｜ 链 ' + escHtml(meta.chain) + ' ｜ 数量 ' + escHtml(meta.amount) + ' ｜ 会话 ' + escHtml(meta.session) + '</div>',
    '<div class="cards">',
    card('钱包数', String(s.total), '成功 ' + s.ok + ' ｜ 失败 ' + s.fail),
    card('成功率', s.successRate == null ? '—' : (s.successRate * 100).toFixed(1) + '%', '真跑 ' + s.realN + ' ｜ 干跑 ' + rows.filter((r) => Number(r.dry)).length),
    card('总投入', s.spent.toFixed(6), '买腿链上实际支出 USDT'),
    card('总回收', s.recv.toFixed(6), '卖腿链上实际到账 USDT'),
    card('总磨损', s.cost.toFixed(6), s.costBps == null ? '无可用数据' : s.costBps.toFixed(2) + ' bps（磨损÷投入）'),
    card('单钱包 bps', s.avgBps == null ? '—' : '均 ' + s.avgBps.toFixed(1) + ' / 中位 ' + s.medBps.toFixed(1),
      s.avgBps == null ? '无可用数据' : '区间 ' + s.minBps.toFixed(1) + ' ~ ' + s.maxBps.toFixed(1) + '（' + s.realN + ' 个）'),
    card('总 gas', s.gasBnb.toFixed(8) + ' ' + gsym, '回执 gasUsed × 实际 gas 价'),
    card('未清残留', s.residualWallets === 0 ? '0 ✅' : String(s.residualWallets),
      s.residualWallets ? '这些钱包还挂着币，有价格风险' : '所有钱包都清零'),
    card('总耗时', (s.seconds / 60).toFixed(1) + ' 分钟', '均 ' + (s.seconds / Math.max(1, s.total)).toFixed(1) + 's/钱包'),
    '</div>',
    '<div class="panel">',
    '<h2>明细</h2>',
    '<div class="filters">',
    '<input id="q" placeholder="搜索地址 / 序号">',
    '<select id="fstatus"><option value="">全部状态</option><option value="ok">只看成功</option><option value="fail">只看失败</option></select>',
    '<input id="minbps" placeholder="bps ≥ …">',
    '<span id="cnt" style="color:#8b93a7;align-self:center"></span>',
    '</div>',
    '<div class="scroll"><table>',
    '<thead><tr>',
    '<th>#</th><th>地址</th><th>状态</th><th>投入</th><th>回收</th><th>磨损</th><th>bps</th><th>gas ' + gsym + '</th>',
    '<th>买入量</th><th>残留</th><th>买入 tx</th><th>卖出 tx</th><th>扫尘 tx</th><th>耗时</th><th>错误</th>',
    '</tr></thead><tbody id="tb">',
    bodyRows,
    '</tbody></table></div>',
    '</div>',
    '</div>',
    '<script>',
    '(function(){',
    '  var rows = Array.prototype.slice.call(document.querySelectorAll("#tb tr"));',
    '  var q = document.getElementById("q");',
    '  var st = document.getElementById("fstatus");',
    '  var mb = document.getElementById("minbps");',
    '  var cnt = document.getElementById("cnt");',
    '  function apply(){',
    '    var v = (q.value || "").toLowerCase();',
    '    var sel = st.value;',
    '    var min = parseFloat(mb.value);',
    '    var shown = 0;',
    '    rows.forEach(function(tr){',
    '      var ok = tr.getAttribute("data-ok") === "1";',
    '      var bps = parseFloat(tr.getAttribute("data-bps"));',
    '      var show = (!v || tr.textContent.toLowerCase().indexOf(v) >= 0)',
    '        && (!sel || (sel === "ok") === ok)',
    '        && (isNaN(min) || (!isNaN(bps) && bps >= min));',
    '      tr.style.display = show ? "" : "none";',
    '      if (show) shown++;',
    '    });',
    '    cnt.textContent = "显示 " + shown + " / " + rows.length;',
    '  }',
    '  q.addEventListener("input", apply);',
    '  st.addEventListener("change", apply);',
    '  mb.addEventListener("input", apply);',
    '  apply();',
    '})();',
    '</script></body></html>',
  ].join('\n');
}

/**
 * 写报告。返回 { csvPath, htmlPath, jsonPath, latest, summary }；没有行返回 null。
 */
export function writeTradeReport({ dir = 'reports', meta = {}, rows = [] } = {}) {
  if (!rows.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const csvPath = path.join(dir, 'trade-' + stamp + '.csv');
  const htmlPath = path.join(dir, 'trade-' + stamp + '.html');
  const jsonPath = path.join(dir, 'trade-' + stamp + '.json');
  const latest = path.join(dir, 'trade-latest.html');
  fs.writeFileSync(csvPath, toCsv(rows));
  const html = toHtml(meta, rows);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(latest, html);
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: meta, rows: rows }, null, 2));
  return { csvPath: csvPath, htmlPath: htmlPath, jsonPath: jsonPath, latest: latest, summary: summarize(rows) };
}

export { summarize };
