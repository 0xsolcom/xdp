#!/usr/bin/env node
/**
 * OKX Web3 DEX 批量交易 CLI —— 每个钱包「一买一卖」才算完成
 *
 *   买：计价币 QUOTE(USDT) → 交易币 TRADE(XDP)
 *   卖：交易币 → 计价币（按链上真实到账全部卖回）
 *   扫：残留交易币清零
 *
 *   node bin/trade.js                                 # 干跑：只报价
 *   node bin/trade.js --execute --yes                 # 真签真发
 *   node bin/trade.js --fast --loop 3 --execute --yes # 原子来回，每钱包 3 轮
 *   node bin/trade.js --approve-only --execute --yes  # 只做一次性无限授权
 *   node bin/trade.js --sweep-only --execute --yes    # 只清残留
 *
 * 全部参数都可以写进 .env（当前目录优先，其次项目根）。优先级：
 *   命令行参数 > 真实环境变量 > .env > 内置默认值。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseUnits } from 'ethers';

import { extractWeb3Session, saveSession, loadSession } from '../src/session.js';
import { createClient } from '../src/client.js';
import { selectWallets } from '../src/wallets.js';
import { writeTradeReport } from '../src/trade-report.js';
import { pushCostReport, latestReport, allReports, ingestEndpoint } from '../src/cost-push.js';
import { resolveRpc, approveOnly, approveBatch, sweepResidual, roundtripFast, roundtripNormal } from '../src/swap.js';
import { getTokenMeta, getNativeBalance, getTokenBalance, setRpcFallbacks } from '../src/dex.js';
import { runPool, withTag, walletTag, parseConcurrency, tagLine } from '../src/pool.js';
import { chainInfo, nativeSymbol } from '../src/chains.js';

const argv = process.argv.slice(2);
const arg = (k, d = '') => {
  const i = argv.lastIndexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes('--' + k);
// 短参数（-v / -h）：has() 只认 --xxx，短横线要单独判
const hasShort = (k) => argv.includes('-' + k);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inRoot = (rel) => path.join(ROOT, rel);

/** 版本号统一从 package.json 读，别手写（改 package.json 即自动生效） */
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(inRoot('package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const userPath = (p) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));

function loadDotEnv() {
  const seen = new Set();
  for (const f of [path.resolve(process.cwd(), '.env'), inRoot('.env')]) {
    if (seen.has(f)) continue;
    seen.add(f);
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const raw of txt.split(/\r?\n/)) {
      const s = raw.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      const q = v.match(/^(['"])(.*)\1(?:\s+#.*)?$/s);
      if (q) v = q[2]; else v = v.replace(/\s+#.*$/, '').trim();
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
loadDotEnv();

const ts = () => new Date().toTimeString().slice(0, 8);
// 并发时 tagLine 会给每行加 `[3/50 #37]` 前缀（AsyncLocalStorage），串行时原样输出
const log = (...a) => console.log(tagLine('[' + ts() + ']'), ...a);
const warn = (...a) => console.log(tagLine('[' + ts() + '] ❗'), ...a);
const say = (s) => console.log(tagLine(String(s)));
const die = (m) => { console.error('\n❌ ' + m); process.exit(1); };
const line = (c = '─', n = 74) => c.repeat(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argEnv = (k, d = '', ...envNames) => {
  const fromCli = arg(k, '');
  if (fromCli) return fromCli;
  for (const n of envNames) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return d;
};
const hasFlag = (k, ...envNames) => {
  if (has(k)) return true;
  return envNames.some((n) => /^(1|true|yes|on)$/i.test(String(process.env[n] || '').trim()));
};
const pathArg = (k, ...envNames) => {
  const fromCli = arg(k, '');
  if (fromCli) return fromCli;
  for (const n of envNames) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return '';
};

const SESSION_FILE = pathArg('session', 'SESSION_FILE')
  ? userPath(pathArg('session', 'SESSION_FILE')) : inRoot(path.join('creds', 'web3-session.json'));
const KEYS_FILE = pathArg('keys', 'KEYS_FILE')
  ? userPath(pathArg('keys', 'KEYS_FILE')) : path.resolve(process.cwd(), 'key.env');
const SOL_KEYS_FILE = pathArg('sol-keys', 'SOL_KEYS_FILE')
  ? userPath(pathArg('sol-keys', 'SOL_KEYS_FILE')) : '';
const WALLETS_ARG = argEnv('wallets', '', 'WALLETS');
const FROM_IDX = Number(argEnv('from', '1', 'FROM_INDEX'));
const TO_IDX = Number(argEnv('to', '0', 'TO_INDEX'));
const LIMIT = Number(argEnv('limit', '0', 'LIMIT'));

const QUOTE_TOKEN = argEnv('quote', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'QUOTE_TOKEN', 'SELL_TOKEN');
const TRADE_TOKEN = argEnv('trade', '0x07b3d902783c3c12b077508c3b5c00113d1291d0', 'TRADE_TOKEN', 'BUY_TOKEN');
const AMOUNT = argEnv('amount', '1', 'AMOUNT');

const FAST = hasFlag('fast', 'FAST');
const LOOP = Math.max(1, Number(argEnv('loop', '1', 'LOOP')));
const SLIPPAGE = argEnv('slippage', '', 'SLIPPAGE');
const SLIPPAGE_EXIT = argEnv('slippage-exit', '', 'SLIPPAGE_EXIT');
const BUY_RETRIES = Math.max(1, Number(argEnv('buy-retries', '3', 'BUY_RETRIES')));
const SELL_RETRIES = Math.max(1, Number(argEnv('sell-retries', '3', 'SELL_RETRIES')));
const DO_SWEEP = !hasFlag('no-sweep', 'NO_SWEEP');
const SWEEP_MIN_TOKEN = Number(argEnv('sweep-min', '0', 'SWEEP_MIN_TOKEN'));
const NO_APPROVE = hasFlag('no-approve', 'NO_APPROVE');

const MAX_SLIPPAGE = Number(argEnv('max-slippage', '0.03', 'MAX_SLIPPAGE'));
const MAX_VALUE_DIFF = Number(argEnv('max-value-diff', '0.003', 'MAX_VALUE_DIFF'));
const GATE_RETRIES = Math.max(1, Number(argEnv('slippage-retries', '3', 'GATE_RETRIES')));
const API_TRIES = Math.max(1, Number(argEnv('api-retries', '3', 'API_TRIES')));

const MIN_GAS_BNB = Number(argEnv('min-gas', '0.0002', 'MIN_GAS_BNB', 'MIN_GAS'));   // MIN_GAS 是别名，避免在 Base 上叫 BNB 别扭
const NO_PRECHECK = hasFlag('no-precheck', 'NO_PRECHECK');

const APPROVE_ONLY = hasFlag('approve-only', 'APPROVE_ONLY');
const SWEEP_ONLY = hasFlag('sweep-only', 'SWEEP_ONLY');
const APPROVE_TOKEN = argEnv('token', '', 'APPROVE_TOKEN');

const REFCODE = argEnv('refcode', '11OKB', 'COMPETITION_REFERRAL', 'REFCODE');
const ACCOUNT_ID = argEnv('account-id', '', 'ACCOUNT_ID') || crypto.randomUUID().toUpperCase();
const CHAIN = Number(argEnv('chain', '8453', 'CHAIN_ID', 'CHAIN'));
const gsym = nativeSymbol(CHAIN);   // 原生币符号（Base=ETH / BSC=BNB），只用于日志与提示
const RPC_ARG = argEnv('rpc', '', 'RPC_URL');
const BROADCAST_ARG = argEnv('broadcast-rpc', '', 'BROADCAST_RPC_URL');

// ── 磨损上报（真实成本入库，见 src/cost-push.js）──
//   交易跑完自动把每个钱包的「投入 − 回收」POST 到数据台；失败只提示，不影响交易结果。
const COST_INGEST_URL   = argEnv('cost-url', '', 'COST_INGEST_URL');
const COST_INGEST_TOKEN = argEnv('cost-token', '', 'COST_INGEST_TOKEN');
const NO_PUSH           = hasFlag('no-push', 'NO_PUSH');
const PUSH_COST         = hasFlag('push-cost', 'PUSH_COST');
const PUSH_COST_FILE    = (arg('push-cost', '') || argEnv('cost-file', '', 'COST_FILE')).trim();
const INTERVAL = Number(argEnv('interval', '1.2', 'INTERVAL'));

// ── 并发（--concurrency）──
// 并发单位是「钱包」：不同地址 nonce 天然独立，互不冲突，所以并发是安全的。
// 真正要小心的是 ① OKX 接口限流（所有钱包共用同一个 devid/会话）② 日志归属。
const CONCURRENCY = parseConcurrency(argEnv('concurrency', '1', 'CONCURRENCY'), 8);
// 并发时 --sleep = 两次**启动**之间的最小间隔（秒）；auto = 按历史单钱包耗时自动推算
const SLEEP_ARG = String(argEnv('sleep', '', 'SLEEP')).trim();
// 全局接口闸门（毫秒）：整个进程发往 OKX 的请求间隔下限，仅并发时生效
const API_GATE_MS = Math.max(0, Number(argEnv('api-gate', '350', 'API_GATE_MS')));
const GATE_MS = CONCURRENCY > 1 ? API_GATE_MS : 0;
// 进度文件（按钱包地址记录，断点续跑用）
const STATE_FILE = pathArg('state', 'STATE')
  ? userPath(pathArg('state', 'STATE')) : inRoot(path.join('creds', 'trade-state.json'));
const STATUS_ONLY = hasFlag('status', 'STATUS');
const RESET = hasFlag('reset', 'RESET');
const RETRY_OK = hasFlag('retry-ok', 'RETRY_OK');
const NO_RESUME = hasFlag('no-resume', 'NO_RESUME');
// ── 整批循环（--cycle）──
//   --loop  = 同一钱包来回几轮（钱包内）
//   --cycle = 整批（全部钱包）跑完再来一遍（钱包组外）；单钱包总来回数 = LOOP × CYCLE
//   注意用 Number.isFinite 兜底：Math.max(1, Number('abc')) 会得到 NaN，
//   那样 `for (c = 1; c <= NaN; c++)` 一次都不跑 —— 打错字会静默什么都不做。
const CYCLE = (function () {
  const n = Math.floor(Number(argEnv('cycle', '1', 'CYCLE')));
  return Number.isFinite(n) && n > 1 ? n : 1;
})();
// 两遍之间休息：空 = 0（立刻下一遍）/ 数字 = 秒 / auto = 按历史单钱包耗时 ÷ 并发
const CYCLE_SLEEP_ARG = String(argEnv('cycle-sleep', '', 'CYCLE_SLEEP')).trim();
const REPORT_DIR = pathArg('report-dir', 'REPORT_DIR')
  ? userPath(pathArg('report-dir', 'REPORT_DIR')) : inRoot('reports');
const DO_EXECUTE = hasFlag('execute', 'EXECUTE');
const YES = hasFlag('yes', 'YES');
const NO_REPORT = hasFlag('no-report', 'NO_REPORT');

function usage() {
  console.log([
    'OKX Web3 DEX 批量交易（每钱包一买一卖）',
    '',
    '用法',
    '  node bin/trade.js                                  # 干跑：只报价',
    '  node bin/trade.js --execute --yes                  # 真签真发',
    '  node bin/trade.js --fast --loop 3 --execute --yes  # 原子来回，每钱包 3 轮',
    '  node bin/trade.js --approve-only --execute --yes   # 只做无限授权',
    '  node bin/trade.js --sweep-only --execute --yes     # 只清残留',
    '  node bin/trade.js --wallets 1-10 --amount 10 --cycle 3 --execute --yes   # 整批跑 3 遍',
    '  node bin/trade.js --concurrency 5 --sleep 2 --execute --yes   # 5 个钱包并发',
    '  node bin/trade.js --status                        # 看断点续跑进度',
    '',
    '配置来源（优先级从高到低）',
    '  命令行参数  >  真实环境变量  >  .env（当前目录优先，其次项目根）  >  内置默认值',
    '',
    '交易对象',
    '  --quote <token>       计价币（钱），默认 USDT                            .env: QUOTE_TOKEN',
    '  --trade <token>       交易币（来回买卖），默认 XDP                       .env: TRADE_TOKEN',
    '  --amount <数量>       每个钱包每轮投入多少计价币（人类可读；all = 全余额）.env: AMOUNT',
    '',
    '模式',
    '  --fast                原子来回：买/卖 calldata 备好，nonce=N/N+1 背靠背广播',
    '  --loop <n>            同一钱包来回 n 轮（默认 1）                        .env: LOOP',
    '  --cycle <n>           整批（全部钱包）跑完再来 n 遍（默认 1）           .env: CYCLE',
    '  --cycle-sleep <秒|auto>  两遍之间休息多久（默认 0 = 立刻开始下一遍）  .env: CYCLE_SLEEP',
    '  --approve-only        只做一次性无限授权（配合 --token usdt,bank）       .env: APPROVE_ONLY',
    '  --sweep-only          只清残留（把交易币全部卖回计价币）                 .env: SWEEP_ONLY',
    '  --token <list>        approve-only 的币，逗号分隔（默认 quote,trade）     .env: APPROVE_TOKEN',
    '',
    '钱包选择',
    '  --keys <文件>         私钥文件（默认 当前目录/key.env）                  .env: KEYS_FILE',
    '  --wallets 31-100      只交易这些钱包：序号区间 31-100 / 单个 7 / 地址 0xa,0xb   .env: WALLETS',
    '  --from / --to         处理第几把到第几把（1 起含两端；--to 0 = 到最后）  .env: FROM_INDEX / TO_INDEX',
    '  --limit <n>           最多处理 n 把                                      .env: LIMIT',
    '',
    '并发（并发单位 = 钱包；不同地址 nonce 天然独立，所以并发安全）',
    '  --concurrency <n>     同时跑几个钱包（默认 1 = 严格串行；上限 8）        .env: CONCURRENCY',
    '  --sleep <秒|auto>     并发时 = 两次「启动」之间的间隔（默认取 --interval）.env: SLEEP',
    '                        auto = 按历史单钱包耗时 ÷ 并发数自动算',
    '  --api-gate <毫秒>     全局接口闸门：整个进程发往 OKX 的请求间隔下限      .env: API_GATE_MS',
    '                        （默认 350ms；仅并发时生效。加并发只增加「同时在等回执」',
    '                          的位数，不增加请求速率 —— 这是躲 429 的关键）',
    '  --status              只看断点续跑进度（不需要私钥，不交易）            .env: STATUS',
    '  --reset               清空进度文件后退出                                .env: RESET',
    '  --retry-ok            连上次成功的钱包也重跑                            .env: RETRY_OK',
    '  --no-resume           不用进度文件，全部重跑                            .env: NO_RESUME',
    '  --state <文件>        进度文件（默认 creds/trade-state.json）            .env: STATE',
    '',
    '行为 / 闸门',
    '  --slippage <比例>     买腿固定滑点（如 0.01 = 1%；留空自动）            .env: SLIPPAGE',
    '  --slippage-exit <比例> 卖腿滑点阶梯起点                                  .env: SLIPPAGE_EXIT',
    '  --max-slippage <比例> 报价滑点闸门（超过就重新报价）                     .env: MAX_SLIPPAGE',
    '  --max-value-diff <比例> 报价价差闸门（|diffPercent| 超过就重新报价）     .env: MAX_VALUE_DIFF',
    '  --slippage-retries <n> 闸门连续超限前的重新报价次数                      .env: GATE_RETRIES',
    '  --api-retries <n>     接口瞬时错误重试次数（100010/10104/超时）          .env: API_TRIES',
    '  --buy-retries <n>     买腿失败重试次数（revert 不建仓，重试安全）        .env: BUY_RETRIES',
    '  --sell-retries <n>    卖腿补卖次数（买了就必须卖出去）                   .env: SELL_RETRIES',
    '  --no-approve          授权不足也不补授权（直接失败）                     .env: NO_APPROVE',
    '  --min-gas <数量>      前置闸门：原生币低于这个数就跳过（不算失败）      .env: MIN_GAS_BNB',
    '  --no-precheck         关掉前置闸门                                       .env: NO_PRECHECK',
    '  --no-sweep            不做残留清扫                                       .env: NO_SWEEP=true',
    '  --sweep-min <n>       残留低于这个数量（交易币单位）就不扫；0 = 全部扫   .env: SWEEP_MIN_TOKEN',
    '  --rpc <url>           普通 RPC（可逗号分隔多个；启动时测速 + 探测回执能力）  .env: RPC_URL',
    '                        只快但取不到回执的节点会被自动排除（Base 上的 publicnode 就是）',
    '                        选中的节点失败时自动轮换到池里其它节点；可用环境变量微调：',
    '                        RECEIPT_TRIES / RECEIPT_INTERVAL_MS / RPC_TIMEOUT_MS / RPC_RETRIES',
    '  --broadcast-rpc <url> 广播兜底 RPC（优先用报价里的 BlockRazor 中继）     .env: BROADCAST_RPC_URL',
    '  --interval <秒>       两个钱包/两轮开始之间的最小间隔（默认 1.2）        .env: INTERVAL',
    '  --execute / --yes     真签真发 + 二次确认                                .env: EXECUTE / YES',
    '  --no-report           不写报告（默认 CSV + JSON + HTML）                 .env: NO_REPORT=true',
    '  --report-dir <目录>   报告目录（默认 reports）                           .env: REPORT_DIR',
    '',
    '磨损上报（真实成本入库 → 数据台「我的钱包批量查询」按地址显示累计磨损）',
    '  --cost-url <url>      数据台上报地址（如 https://boost.6117.com.cn/xdp/xdp.php）',
    '                                                                          .env: COST_INGEST_URL',
    '  --cost-token <串>     上报令牌（要和 xdp.php 里的 COST_INGEST_TOKEN 一致）',
    '                                                                          .env: COST_INGEST_TOKEN',
    '  --no-push             本次不上报（交易照跑）                            .env: NO_PUSH=true',
    '  --push-cost [文件]    手动补推：留空=最新一份，all=reports 下全部，或指定文件',
    '                        幂等：靠 runId 去重，重复推不会把磨损翻倍',
    '  --session <文件>      会话文件（默认 creds/web3-session.json）           .env: SESSION_FILE',
    '  -v, --version         显示版本号',
    '  -h, --help            这份帮助',
    '',
    '推荐流程（Base 拥堵，授权单独跑一次最省时间）',
    '  1) node bin/trade.js --approve-only --execute --yes    # 先一次性授权（幂等，已授权的自动跳过）',
    '  2) node bin/trade.js --fast --amount 10 --execute --yes  # 交易时仍会复查授权，缺了会先补',
    '  3) node bin/trade.js --sweep-only --execute --yes     # 清残留',
    '',
    '流程（每个钱包一买一卖；并发时一个失败不影响后面的）',
    '  1) 买 QUOTE→TRADE：报价闸门 → calldata 校验 → 余额检查 → **授权检查（不足先补授权并等确认）**',
    '     → 链上模拟 → gas 估算 → 广播',
    '  2) 卖 TRADE→QUOTE：按链上真实到账全部卖回；失败自动放宽滑点补卖',
    '  3) 扫 残留清零（可 --no-sweep 关闭）',
    '  --fast 时：买/卖两份 calldata 先备好，nonce=N/N+1 背靠背广播，敞口 ≈ 1 个区块',
    '',
    '安全',
    '  默认干跑不签名。真发会上链、不可撤销；请先用极小金额自测。',
  ].join('\n'));
}

function loadSessionOrDie() {
  if (fs.existsSync(SESSION_FILE)) return loadSession(SESSION_FILE);
  const hars = [];
  for (const d of [process.cwd(), ROOT, path.join(process.env.HOME || '', 'Downloads')]) {
    try { for (const n of fs.readdirSync(d)) if (/\.har$/i.test(n)) hars.push(path.join(d, n)); } catch { /* */ }
  }
  if (!hars.length) die('没有会话文件，也没找到 .har。请把 web3.okx.com 的 HAR 放到当前目录 / 项目根目录 / ~/Downloads（会自动抽取）');
  const s = extractWeb3Session(hars[0]);
  saveSession(SESSION_FILE, s);
  return s;
}

function sellLadder() {
  const explicit = SLIPPAGE_EXIT !== '' ? Number(SLIPPAGE_EXIT)
    : (SLIPPAGE !== '' ? Number(SLIPPAGE) : null);
  if (explicit == null || !Number.isFinite(explicit) || explicit <= 0) return [null];
  const rungs = [explicit];
  for (const v of [0.005, 0.02]) if (v > rungs[rungs.length - 1]) rungs.push(v);
  rungs.push(null);
  return rungs;
}

const TOKEN_ALIAS = {
  usdt: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  xdp: '0x07b3d902783c3c12b077508c3b5c00113d1291d0',
};
const resolveAlias = (v) => (v ? TOKEN_ALIAS[String(v).toLowerCase()] || v : v);
function approveTokenList() {
  const raw = APPROVE_TOKEN || (QUOTE_TOKEN + ',' + TRADE_TOKEN);
  return [...new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean).map(resolveAlias))];
}

async function finishReport(rows, meta, summaryFn) {
  const finishedAt = new Date().toISOString();
  meta.finishedAt = finishedAt;
  const okN = rows.filter((r) => Number(r.ok) === 1).length;
  const skipN = rows.filter((r) => r.stage === 'skipped').length;
  const failN = rows.length - okN - skipN;
  console.log(line('═'));
  log('完成：成功 ' + okN + ' / 失败 ' + failN + ' / 跳过 ' + skipN + ' / 共 ' + rows.length + (DO_EXECUTE ? '（已广播）' : '（干跑）'));
  const openN = rows.filter((r) => Number(r.positionOpen) > 0).length;
  if (openN) warn(openN + ' 把钱包买了没卖成（半截仓位），币还在钱包里，需要补卖（--sweep-only）');

  if (!NO_REPORT && rows.length) {
    const rep = writeTradeReport({ dir: REPORT_DIR, meta: meta, rows: rows });
    if (rep && summaryFn) summaryFn(rep);
    if (rep) {
      console.log('   CSV   ' + rep.csvPath);
      console.log('   HTML  ' + rep.htmlPath);
      console.log('   最新  ' + rep.latest);

      // 把真实磨损上报到数据台（xdp.php）。失败**不影响交易结果**，只提示 + 告诉怎么补推。
      if (!NO_PUSH && COST_INGEST_URL && COST_INGEST_TOKEN) {
        const pr = await pushCostReport(rep.jsonPath, {
          url: COST_INGEST_URL, token: COST_INGEST_TOKEN, chainIndex: meta.chain, onWarn: warn,
        });
        if (pr.ok) log('📊 磨损已上报：新增 ' + pr.inserted + ' 条 / 已存在 ' + pr.skippedCount + ' 条   runId=' + pr.runId);
        else if (pr.skipped) log('📊 磨损上报跳过：' + pr.msg);
        else warn('磨损上报失败：' + pr.msg + '\n   可稍后补推：node bin/trade.js --push-cost ' + rep.jsonPath);
      }
    }
  }
}

/* ───────────────── 进度状态（断点续跑） ───────────────── */
// 按**钱包地址**索引（不是下标）：私钥文件顺序变了、增删了都不会错位。
// 原子写（先写 .tmp 再 rename），中途断电也不会把状态文件写坏。
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { version: 1, keysFile: KEYS_FILE, wallets: {} };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.wallets) s.wallets = {};
    return s;
  } catch (e) {
    return die('状态文件 ' + STATE_FILE + ' 读不了（' + e.message + '）；用 --reset 清空，或 --state 换一个');
  }
}
function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_FILE + '.tmp';
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
/** 只有「真跑且成功」才算完成；干跑的成功不算（行情会变） */
const isDone = (w) => !!w && w.ok === true && w.executed === true;
/** 历史「单钱包一轮」耗时中位（秒）—— 给 --sleep auto 用 */
function historyMedianSeconds(state) {
  const a = Object.values(state.wallets || {})
    .filter((w) => w && w.executed && typeof w.seconds === 'number' && w.seconds > 0)
    .map((w) => w.seconds).sort((x, y) => x - y);
  return a.length < 3 ? null : a[Math.floor(a.length / 2)];
}
function printStatus(state) {
  const vals = Object.values(state.wallets || {});
  const ok = vals.filter((w) => w.ok === true).length;
  const fail = vals.filter((w) => w.ok === false).length;
  const done = vals.filter((w) => isDone(w)).length;
  console.log(line('═'));
  log('进度：' + STATE_FILE);
  log('  已记录 ' + vals.length + ' 条   成功 ' + ok + '   失败 ' + fail + '   真跑成功(会跳过) ' + done);
  log('  私钥文件 ' + KEYS_FILE);
  console.log(line('═'));
}
function recordState(state, w, row) {
  state.wallets[w.wallet.address] = {
    index: w.index, address: w.wallet.address, ok: Number(row.ok) === 1, executed: DO_EXECUTE,
    stage: row.stage || '', error: row.error || '', costBps: row.costBps || '',
    seconds: row.seconds, at: new Date().toISOString(),
  };
  saveState(state);
}

/**
 * 手动补推磨损（--push-cost）。
 *   node bin/trade.js --push-cost                  # 推最新一份报告
 *   node bin/trade.js --push-cost reports/xx.json  # 推指定报告
 *   node bin/trade.js --push-cost all              # 推 reports/ 下全部（幂等，重复推不会翻倍）
 * 用途：交易时断网、或者想把以前跑过的报告一次性灌进库里。
 */
async function pushCostMode() {
  if (!COST_INGEST_URL || !COST_INGEST_TOKEN) {
    return die('缺少上报配置：请在 .env 里配 COST_INGEST_URL（如 https://boost.6117.com.cn/xdp/xdp.php）和 COST_INGEST_TOKEN');
  }
  const endpoint = ingestEndpoint(COST_INGEST_URL);

  let files;
  if (!PUSH_COST_FILE) {
    const f = latestReport(REPORT_DIR);
    if (!f) return die('在 ' + REPORT_DIR + ' 下没找到报告文件（trade-<时间戳>.json）');
    files = [f];
  } else if (PUSH_COST_FILE.toLowerCase() === 'all') {
    files = allReports(REPORT_DIR);
    if (!files.length) return die('在 ' + REPORT_DIR + ' 下没找到报告文件');
  } else {
    files = [userPath(PUSH_COST_FILE)];
  }

  log('上报磨损 → ' + endpoint);
  log('共 ' + files.length + ' 份报告，各钱包「投入 − 回收」累计入库（幂等，重复推不会翻倍）');
  let okN = 0, insN = 0, dupN = 0, skipN = 0, failN = 0;
  for (const f of files) {
    const r = await pushCostReport(f, {
      url: COST_INGEST_URL, token: COST_INGEST_TOKEN, chainIndex: CHAIN, onWarn: warn,
    });
    const name = path.basename(f);
    if (r.ok) {
      okN++; insN += Number(r.inserted || 0); dupN += Number(r.skippedCount || 0);
      console.log('  ✅ ' + name + '  runId=' + r.runId + '  新增 ' + r.inserted + ' 条 / 已存在 ' + r.skippedCount + ' 条');
    } else if (r.skipped) {
      skipN++;
      console.log('  ⏭ ' + name + '  ' + r.msg);
    } else {
      failN++;
      console.log('  ❌ ' + name + '  ' + r.msg);
    }
  }
  console.log(line('═'));
  log('上报完成：成功 ' + okN + ' 份 / 跳过 ' + skipN + ' 份 / 失败 ' + failN + ' 份');
  log('  新增明细 ' + insN + ' 条，已存在（重复推送）' + dupN + ' 条');
  if (failN) warn('有 ' + failN + ' 份失败，修好网络/配置后重跑同一条命令即可（幂等）');
}

async function main() {
  if (has('version') || hasShort('v')) { console.log('okx-trade v' + VERSION); return; }
  if (has('help') || hasShort('h')) return usage();
  if (RESET) { fs.rmSync(STATE_FILE, { force: true }); console.log('✅ 已清空 ' + STATE_FILE); return; }
  if (STATUS_ONLY) return printStatus(loadState());
  if (PUSH_COST) return pushCostMode();
  if (!AMOUNT && !APPROVE_ONLY && !SWEEP_ONLY) return die('缺少 --amount');
  if (String(QUOTE_TOKEN).toLowerCase() === String(TRADE_TOKEN).toLowerCase()) {
    return die('计价币与交易币不能相同（一买一卖需要两个不同的币）');
  }

  const session = loadSessionOrDie();
  const client = createClient(session, { gateMs: GATE_MS });

  let wallets;
  try {
    wallets = selectWallets({
      walletsArg: WALLETS_ARG, keysFile: KEYS_FILE, solKeysFile: SOL_KEYS_FILE,
      from: FROM_IDX, to: TO_IDX, limit: LIMIT, onWarn: warn,
    });
  } catch (e) {
    return die(e.message);
  }
  if (!wallets.length) return die('没有选中任何钱包（检查 --from/--to/--limit 或私钥文件）');
  if (wallets.some((w) => !w.pk)) return die('本工具需要私钥签名，--wallets 只给地址不够。请用 --keys <私钥文件>');
  if (DO_EXECUTE && !YES) return die('真发需要显式加 --yes');

  const rpcInfo = await resolveRpc({ chainId: CHAIN, rpcArg: RPC_ARG, onWarn: warn });
  const rpcUrl = rpcInfo.url || chainInfo(CHAIN).rpc[0] || '';
  if (!rpcUrl) return die('链 ' + CHAIN + ' 没有可用 RPC，请加 --rpc <url>');
  // 主节点某个方法报错时（Base 上最常见的是取不到回执），rpc() 会按这个顺序轮换到备用节点。
  // 只测速不测能力时被选中的 base-rpc.publicnode.com 就是这么坑掉每笔授权的。
  setRpcFallbacks(rpcInfo.all && rpcInfo.all.length ? rpcInfo.all : chainInfo(CHAIN).rpc);
  const broadcastUrl = BROADCAST_ARG || rpcUrl;

  const quoteMeta = await getTokenMeta(rpcUrl, QUOTE_TOKEN).catch(() => ({ symbol: 'QUOTE', decimals: 18 }));
  const tradeMeta = await getTokenMeta(rpcUrl, TRADE_TOKEN).catch(() => ({ symbol: 'TRADE', decimals: 18 }));

  log('okx-trade v' + VERSION + '   链 ' + CHAIN + '  ' + quoteMeta.symbol + ' → ' + tradeMeta.symbol + ' → ' + quoteMeta.symbol +
    (APPROVE_ONLY ? '  （只授权）' : SWEEP_ONLY ? '  （只清残留）' : '  每钱包 ' + AMOUNT + ' ' + quoteMeta.symbol + (LOOP > 1 ? ' × ' + LOOP + ' 轮' : '') + (FAST ? '  --fast' : '')));
  log('RPC ' + rpcUrl + (rpcInfo.picked ? '（池中测速 ' + rpcInfo.picked + '）' : ''));
  if (broadcastUrl !== rpcUrl) log('广播兜底 ' + broadcastUrl);

  const base = {
    client, chainId: CHAIN, rpcUrl, broadcastUrl,
    accountId: ACCOUNT_ID, refCode: REFCODE, doExecute: DO_EXECUTE, onWarn: warn, apiTries: API_TRIES,
  };
  const ladder = sellLadder();
  if (ladder.length > 1) log('卖腿滑点阶梯：' + ladder.map((x) => (x == null ? '自动' : (x * 100).toFixed(2) + '%')).join(' → '));
  const ropts = { maxSlippage: MAX_SLIPPAGE, maxValueDiff: MAX_VALUE_DIFF, gateRetries: GATE_RETRIES, buyRetries: BUY_RETRIES, sellRetries: SELL_RETRIES, ladder: ladder, noApprove: NO_APPROVE };
  const startedAt = new Date().toISOString();
  // runId：上报磨损时的幂等键。同一份报告重推多少次，服务端都只算一次。
  const runMeta = {
    version: VERSION,
    runId: 'trade-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex'),
    startedAt: '', mode: '', chain: CHAIN, amount: AMOUNT + ' ' + quoteMeta.symbol, session: SESSION_FILE, rpc: rpcUrl,
  };
  let rows = [];     // 每一遍（--cycle）重建一次，报告按遍独立
  const state = NO_RESUME ? { version: 1, wallets: {} } : loadState();
  const wallStart = Date.now();

  // ── 并发运行器（串行时与旧版逐行等价）──
  // 并发单位是钱包：不同地址 nonce 独立；请求速率由 client 的全局闸门统一限制。
  function gapSec() {
    if (SLEEP_ARG) {
      if (SLEEP_ARG.toLowerCase() === 'auto') {
        const T = historyMedianSeconds(state) || 30;
        return Math.max(0.5, Math.round((T / CONCURRENCY) * 10) / 10);
      }
      const v = Number(SLEEP_ARG);
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return Math.max(0, INTERVAL);
  }
  // 两遍之间休息几秒：空=0 立刻开始；数字=秒；auto=沿用 --sleep 的推算
  const cycleGapSec = () => {
    if (!CYCLE_SLEEP_ARG) return 0;
    if (CYCLE_SLEEP_ARG.toLowerCase() === 'auto') return gapSec();
    const v = Number(CYCLE_SLEEP_ARG);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  const concNote = () => (CONCURRENCY > 1
    ? '   并发 ' + CONCURRENCY + '   启动间隔 ' + gapSec() + 's' + (SLEEP_ARG.toLowerCase() === 'auto' ? '(auto)' : '') + '   接口闸门 ' + GATE_MS + 'ms'
    : '');
  async function runMode(items, runOne) {
    const total = items.length;
    const gapMs = CONCURRENCY > 1 ? Math.round(gapSec() * 1000) : 0;
    await runPool(items, CONCURRENCY, gapMs,
      (w, n) => withTag(CONCURRENCY > 1 ? walletTag(n, total, w.index) : null, () => runOne(w, n, total)),
      () => false);
    rows.sort((a, b) => Number(a.index) - Number(b.index));
  }
  // 串行：保持旧行为（每个钱包**结束后**等 INTERVAL）；并发：交给 runPool 的启动闸门，不再各自等
  const tailSleep = async (n, total) => {
    if (CONCURRENCY === 1 && n < total && INTERVAL > 0) await sleep(INTERVAL * 1000);
  };
  const finishConcurrency = (t0) => {
    if (CONCURRENCY <= 1) return;
    const wallSec = (Date.now() - (t0 || wallStart)) / 1000;
    const sumSec = rows.reduce((s, r) => s + (Number(r.seconds) || 0), 0);
    log('并发 ' + CONCURRENCY + '   墙钟 ' + wallSec.toFixed(1) + 's   钱包耗时合计 ' + sumSec.toFixed(1) + 's   平均占用 ' + (wallSec > 0 ? (sumSec / wallSec).toFixed(2) : '0') + ' 位');
    if (wallSec > 0 && sumSec / wallSec < CONCURRENCY * 0.8) warn('并发位没用满：瓶颈多半是 --sleep ' + gapSec() + 's 或接口闸门，可调小后再试');
  };

  /* ───────────────── 只授权 ───────────────── */
  if (APPROVE_ONLY) {
    const list = approveTokenList();
    const total = wallets.length;
    log('模式：一次性无限授权  ' + list.join(' / ') + '  ×  ' + total + ' 把钱包' + concNote());
    log('  ' + list.length + ' 个代币在同一把钱包里背靠背广播（nonce N/N+1…），只等一个回执窗口');
    await runMode(wallets, async (w, n) => {
      const t0 = Date.now();
      say(line('━'));
      log('[' + n + '/' + total + '] ' + w.wallet.address);
      const done = [];
      let ok = true; let msg = '';
      // 一把钱包的所有代币一起授权：报价/查授权 → 背靠背广播 → 一起等回执
      const rs = await approveBatch(Object.assign({}, base, {
        wallet: w.wallet, tokens: list,
        otherTokenOf: (tk) => (tk.toLowerCase() === String(QUOTE_TOKEN).toLowerCase() ? TRADE_TOKEN : QUOTE_TOKEN),
      }), { onWarn: warn });
      for (const r of rs) {
        if (r.ok) done.push(r.symbol + (r.alreadyMax ? '(已无限)' : r.dry ? '(干跑)' : r.lateReceipt ? '(已授权·回执晚到)' : '(已授权)'));
        else { ok = false; msg = (r.symbol + ' ' + (r.msg || '授权失败')).trim(); }
      }
      if (!rs.length) { ok = false; msg = '没有需要处理的代币'; }
      say('[' + ts() + '] ' + String(w.index).padStart(4) + '  ' + w.wallet.address + '  ' + (ok ? '✅ ' + done.join(' / ') : '❌ ' + msg));
      const row = { index: w.index, address: w.wallet.address, ok: ok ? 1 : 0, stage: ok ? 'done' : 'approve', dry: DO_EXECUTE ? 0 : 1, direction: '授权', seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), error: ok ? '' : msg };
      rows.push(row); recordState(state, w, row);
      await tailSleep(n, total);
    });
    runMeta.mode = DO_EXECUTE ? '真实授权' : '授权干跑';
    return finishReport(rows, runMeta, null);
  }

  /* ───────────────── 只清残留 ───────────────── */
  if (SWEEP_ONLY) {
    const total = wallets.length;
    log('模式：只清残留  ' + tradeMeta.symbol + ' → ' + quoteMeta.symbol + concNote());
    if (!DO_EXECUTE) {
      await runMode(wallets, async (w) => {
        let bal = 0n; try { bal = await getTokenBalance(rpcUrl, TRADE_TOKEN, w.wallet.address); } catch { /* */ }
        const human = Number(bal) / Math.pow(10, tradeMeta.decimals);
        say('[' + ts() + '] ' + String(w.index).padStart(4) + '  ' + w.wallet.address + '  ' + tradeMeta.symbol + ' ' + human);
        rows.push({ index: w.index, address: w.wallet.address, ok: 1, stage: 'dry', dry: 1, direction: '清残留', residual: human, seconds: 0, error: '' });
      });
      runMeta.mode = '清残留干跑';
      return finishReport(rows, runMeta, null);
    }
    await runMode(wallets, async (w, n) => {
      const t0 = Date.now();
      say(line('━'));
      log('[' + n + '/' + total + '] ' + w.wallet.address);
      const sw = await sweepResidual(Object.assign({}, base, {
        wallet: w.wallet, fromToken: TRADE_TOKEN, toToken: QUOTE_TOKEN, minToken: SWEEP_MIN_TOKEN, rounds: 2, onWarn: warn,
      }));
      say('[' + ts() + '] ' + String(w.index).padStart(4) + '  ' + w.wallet.address + '  ' + (sw.ok ? '✅ 残留 ' + sw.residual : '❌ ' + sw.msg));
      const row = { index: w.index, address: w.wallet.address, ok: sw.ok ? 1 : 0, stage: sw.ok ? 'done' : 'sweep', dry: 0, direction: '清残留', residual: sw.residual != null ? sw.residual : '', sweepTx: sw.hash || '', gasBnb: sw.gasBnb ? Number(sw.gasBnb).toFixed(8) : '', seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), error: sw.ok ? '' : (sw.msg || '') };
      rows.push(row); recordState(state, w, row);
      await tailSleep(n, total);
    });
    runMeta.mode = '真实清残留';
    finishConcurrency();
    return finishReport(rows, runMeta, null);
  }

  /* ───────────────── 前置闸门 ───────────────── */
  let planned = wallets;
  const skipped = [];
  if (!NO_PRECHECK) {
    const need = String(AMOUNT).toLowerCase() === 'all' ? null : parseUnits(String(AMOUNT), quoteMeta.decimals);
    log('');
    log('前置检查 ' + wallets.length + ' 个钱包（' + gsym + ' ≥ ' + MIN_GAS_BNB + (need != null ? '，' + quoteMeta.symbol + ' ≥ ' + AMOUNT : '') + '）…');
    const checked = new Array(wallets.length).fill(null);
    const checkOne = async (w, i) => {
      try {
        const bnb = await getNativeBalance(rpcUrl, w.wallet.address);
        const bal = await getTokenBalance(rpcUrl, QUOTE_TOKEN, w.wallet.address);
        if (bnb < parseUnits(String(MIN_GAS_BNB), 18)) {
          checked[i] = { index: w.index, address: w.wallet.address, reason: 'gas 不足（' + (Number(bnb) / 1e18).toFixed(6) + ' ' + gsym + '）' };
        } else if (need != null && bal < need) {
          checked[i] = { index: w.index, address: w.wallet.address, reason: quoteMeta.symbol + ' 不足（' + (Number(bal) / Math.pow(10, quoteMeta.decimals)) + '）' };
        } else {
          checked[i] = { w: w };
        }
      } catch (e) { checked[i] = { w: w }; }
    };
    // 前置检查只打 RPC（不走 OKX 接口），并发安全；并发时一并并行化，别把它变成新瓶颈
    if (CONCURRENCY > 1) await runPool(wallets, Math.min(CONCURRENCY, 6), 0, (w, n, i) => checkOne(w, i));
    else for (let i = 0; i < wallets.length; i++) await checkOne(wallets[i], i);
    planned = [];
    for (const c of checked) {
      if (!c) continue;
      if (c.w) planned.push(c.w); else skipped.push(c);
    }
    if (skipped.length) warn('跳过 ' + skipped.length + ' 个（不计入失败）：' + skipped.slice(0, 5).map((x) => x.address.slice(0, 8) + '…').join(' '));
    log('实际执行 ' + planned.length + ' 个钱包');
  }

  // ── 断点续跑：跳过上次「真跑且成功」的（干跑的成功不算）──
  if (!NO_RESUME && !RETRY_OK) {
    const done = [];
    planned = planned.filter((w) => {
      if (isDone(state.wallets[w.wallet.address])) { done.push(w); return false; }
      return true;
    });
    if (done.length) log('断点续跑：跳过 ' + done.length + ' 个上次已成功的（要重跑加 --retry-ok）');
  }
  for (const s of skipped) {
    rows.push({ index: s.index, address: s.address, ok: 0, stage: 'skipped', dry: DO_EXECUTE ? 0 : 1, direction: quoteMeta.symbol + '→' + tradeMeta.symbol, seconds: 0, error: s.reason });
  }

  /* ───────────────── 主循环（--cycle 把整批跑 n 遍）───────────────── */
  const total = planned.length;
  if (FAST) log('模式：原子来回（--fast）');
  log('开始 ' + total + ' 个钱包' + (LOOP > 1 ? '（每个 ' + LOOP + ' 轮）' : '') +
      (CYCLE > 1 ? '，整批 ' + CYCLE + ' 遍' : '') + concNote());

  const baseRunId = runMeta.runId;
  const preRows = rows.slice();     // 前置检查跳过的行，每遍的报告都带上
  for (let c = 1; c <= CYCLE; c++) {
    if (CYCLE > 1) {
      log('');
      log('══════ 第 ' + c + '/' + CYCLE + ' 遍   ' + total + ' 个钱包' +
          (LOOP > 1 ? ' × ' + LOOP + ' 轮' : '') + ' ══════');
    }
    // 每遍都是独立一次上报 —— runId 必须不同，否则服务端 (run_id, 钱包) 的幂等
    // 会把第 2 遍起同一钱包的成本当成「已存在」直接丢掉，磨损就少记了。
    rows = preRows.slice();
    runMeta.runId = (CYCLE > 1) ? (baseRunId + '-c' + c) : baseRunId;
    const cycleStart = Date.now();

  await runMode(planned, async (w, n) => {
    const address = w.wallet.address;
    say(line('━'));
    log('[' + n + '/' + total + '] ' + address);
    const t0 = Date.now();
    const agg = { spent: 0, received: 0, gas: 0, buyOut: '', buyMin: '', sellIn: '', residual: '0', buyTx: '', sellTx: '', sweepTx: '', positionOpen: 0, failed: false, msg: '', stage: 'buy', okRounds: 0 };

    for (let r = 1; r <= LOOP; r++) {
      const tag = LOOP > 1 ? '[' + r + '/' + LOOP + '] ' : '';
      let res;
      const args = Object.assign({}, base, { wallet: w.wallet, fromToken: QUOTE_TOKEN, toToken: TRADE_TOKEN, amount: AMOUNT, slippage: SLIPPAGE, label: tag });
      if (FAST) res = await roundtripFast(args, ropts);
      else res = await roundtripNormal(args, ropts);

      if (!res.ok) {
        agg.failed = true;
        agg.stage = res.stage || 'fail';
        agg.msg = res.msg || (res.buy && res.buy.msg) || '失败';
        if (res.positionOpen) agg.positionOpen = 1;
        break;
      }
      agg.okRounds++;
      const b = res.buy; const s = res.sell;
      if (b && b.spentHuman != null) agg.spent += Number(b.spentHuman);
      if (s && s.receivedHuman != null) agg.received += Number(s.receivedHuman);
      if (b && b.gasBnb) agg.gas += Number(b.gasBnb);
      if (s && s.gasBnb) agg.gas += Number(s.gasBnb);
      agg.buyOut = b && b.receivedHuman != null ? b.receivedHuman : (b && b.receiveAmount ? b.receiveAmount : agg.buyOut);
      agg.buyMin = b && b.minimumReceived ? b.minimumReceived : agg.buyMin;
      agg.sellIn = s && s.spentHuman != null ? s.spentHuman : agg.sellIn;
      agg.buyTx = b && b.txHash ? b.txHash : agg.buyTx;
      agg.sellTx = s && s.txHash ? s.txHash : agg.sellTx;

      if (DO_EXECUTE && DO_SWEEP) {
        const sw = await sweepResidual(Object.assign({}, base, {
          wallet: w.wallet, fromToken: TRADE_TOKEN, toToken: QUOTE_TOKEN, minToken: SWEEP_MIN_TOKEN, rounds: 2, onWarn: warn,
        }));
        if (sw.gasBnb) agg.gas += Number(sw.gasBnb);
        if (sw.receivedUsdt) agg.received += Number(sw.receivedUsdt);   // 扫残留卖回的 USDT 也算回收
        if (sw.hash) agg.sweepTx = sw.hash;
        agg.residual = sw.residual != null ? sw.residual : '0';
        if (!sw.ok) { agg.msg = '扫残留失败：' + (sw.msg || ''); agg.failed = true; agg.stage = 'sweep'; }
      }
      if (r < LOOP && INTERVAL > 0) await sleep(INTERVAL * 1000);
    }

    const ok = (!agg.failed && agg.okRounds === LOOP && !agg.positionOpen) ? 1 : 0;
    const spent = agg.spent > 0 ? agg.spent : null;
    const received = agg.received > 0 ? agg.received : null;
    const cost = (spent != null && received != null) ? spent - received : null;
    const bps = (cost != null && spent > 0) ? (cost / spent) * 10000 : null;
    const row = {
      index: w.index, address: address, ok: ok, stage: ok ? 'done' : agg.stage, dry: DO_EXECUTE ? 0 : 1,
      positionOpen: agg.positionOpen, direction: quoteMeta.symbol + '→' + tradeMeta.symbol + '→' + quoteMeta.symbol,
      spentUsdt: spent != null ? spent.toFixed(6) : '',
      receivedUsdt: received != null ? received.toFixed(6) : '',
      costUsdt: cost != null ? cost.toFixed(6) : '',
      costBps: bps != null ? bps.toFixed(2) : '',
      buyOut: agg.buyOut, buyMin: agg.buyMin, sellIn: agg.sellIn,
      residual: agg.residual, gasBnb: agg.gas ? agg.gas.toFixed(8) : '',
      rounds: agg.okRounds,
      buyTx: agg.buyTx, sellTx: agg.sellTx, sweepTx: agg.sweepTx,
      seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
      error: ok ? '' : agg.msg,
    };
    rows.push(row); recordState(state, w, row);

    if (ok) {
      const bits = [];
      if (agg.buyOut) bits.push('买入 ' + agg.buyOut + ' ' + tradeMeta.symbol);
      if (spent != null) bits.push('投入 ' + spent.toFixed(6) + ' ' + quoteMeta.symbol);
      if (received != null) bits.push('回收 ' + received.toFixed(6) + ' ' + quoteMeta.symbol);
      if (bps != null) bits.push('磨损 ' + bps.toFixed(2) + ' bps');
      say('[' + ts() + '] ' + String(w.index).padStart(4) + '  ' + address + '  ' + (DO_EXECUTE ? '✅ 一买一卖完成' : '✅ 双向报价成功') + (bits.length ? '  ' + bits.join('  ') : '') + '  ' + row.seconds + 's');
    } else {
      say('[' + ts() + '] ' + String(w.index).padStart(4) + '  ' + address + '  ❌ ' + agg.msg + '  ' + row.seconds + 's');
    }
    await tailSleep(n, total);
  });
    finishConcurrency(cycleStart);

    const cycTag = (CYCLE > 1) ? ('（第 ' + c + '/' + CYCLE + ' 遍）') : '';
    runMeta.mode = DO_EXECUTE ? (FAST ? '真实原子来回' : '真实交易') : '干跑';
    finishReport(rows, runMeta, (rep) => {
      const s = rep.summary;
      console.log('');
      console.log(DO_EXECUTE ? ('📄 一买一卖报告' + cycTag + ':') : ('📄 报告（干跑，金额列为空）' + cycTag + ':'));
      if (DO_EXECUTE) {
        console.log('   总投入 ' + s.spent.toFixed(6) + ' ｜ 总回收 ' + s.recv.toFixed(6) + ' ｜ 磨损 ' + s.cost.toFixed(6) + (s.costBps == null ? '' : '（' + s.costBps.toFixed(2) + ' bps）'));
        console.log('   gas ' + s.gasBnb.toFixed(8) + ' ' + gsym + ' ｜ 成功 ' + s.ok + ' / ' + s.total + ' ｜ 未清残留 ' + s.residualWallets);
      }
    });

    if (c < CYCLE) {
      const gap = cycleGapSec();
      log('');
      log('第 ' + c + '/' + CYCLE + ' 遍完成，' + (gap > 0 ? '休息 ' + gap + 's 后' : '立刻') + '开始第 ' + (c + 1) + ' 遍…');
      if (gap > 0) await sleep(gap * 1000);
    }
  }
  if (CYCLE > 1) { log(''); log('✅ 整批 ' + CYCLE + ' 遍执行完毕'); }
}

main().catch((e) => die(e.stack || e.message));
