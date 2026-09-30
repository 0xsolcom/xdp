# XDP · Doppler Finance on Base

**批量交易 + 活动数据采集 + 排行榜看板**。两条线放在一个仓库里，互不依赖：

| 子系统 | 目录 | 干什么 |
|---|---|---|
| **批量交易** | `bin/` `src/` | 每个钱包「**一买一卖**」（QUOTE → XDP → QUOTE）才算一轮，自动授权、链上模拟、扫残留、批量报告、真实磨损上报 |
| **采集与排行** | `xdp/` | 三级数据源采集 XDP 成交 → `trades` → 物化 `wallet_rank` → 单文件 PHP 看板（排行 + 增速 + 名额监测 + 我的钱包批量查询） |

> ⚠️ **涉及真钱、也用了逆向出来的私有接口**，与 OKX 官方无关，接口随时可能变更。
> **默认全部干跑** —— 不加 `--execute` 绝不签名、绝不广播。
> 建议用**专门的交易钱包**，不要用主钱包。

---

## 目录速览

```
bin/trade.js            交易 CLI（唯一入口：一买一卖 / 并发 / 断点续跑 / 报告）
src/                    交易底层（会话 / 签名 / DEX / 一买一卖原语 / 报告 / 磨损上报）
xdp/                    采集程序（链上直采 + 成交 WebSocket + REST）与运维脚本
xdp/web/xdp.php         单文件看板 —— ⚠️ 明文凭据，**不入库**（见第 12 节）
creds/  reports/  logs/ 会话 / 报告 / 日志 —— 全部不入库
```

**这一份 README 是完整手册**：命令与全部参数、工作原理、数据口径与判据、看板与部署运维、
踩坑与修复记录、安全清单都在下面。`xdp/README.md` 是采集器的细节展开版。

---

## 目录

1. [它解决什么问题](#1-它解决什么问题)
2. [从零开始](#2-从零开始)
3. [目录结构](#3-目录结构)
4. [命令与参数](#4-命令与参数)
5. [工作原理](#5-工作原理)
6. [数据口径与判据](#6-数据口径与判据)
7. [看板](#7-看板)
8. [授权 / 残留 / gas](#8-授权--残留--gas)
9. [真实磨损上报](#9-真实磨损上报)
10. [部署与运维](#10-部署与运维)
11. [踩坑与修复记录](#11-踩坑与修复记录)
12. [安全与密钥管理](#12-安全与密钥管理)
13. [免责声明](#13-免责声明)

---

## 1. 它解决什么问题

活动按**交易量**排名，手动在 App 里一轮轮点「买 → 卖」既慢又难对账。这个项目把两件事变成脚本：

### 交易（`bin/trade.js`）

| 能力 | 说明 |
|---|---|
| 一买一卖 | 每个钱包买完（QUOTE→XDP）必须卖回（XDP→QUOTE）才算完成 |
| 原子来回 | `--fast`：买卖两份 calldata 备好，nonce=N / N+1 背靠背广播，敞口压到约 1 个区块 |
| 自动授权 | 按报价里的真实 spender 查链上额度，不足先补授权并等确认，再交易 |
| 链上模拟 | 广播前先 `eth_call` 模拟，过不了就不发 |
| 报价闸门 | 滑点 / 价差超限就重新报价，避开坏价 |
| 卖腿补卖 | 买了就必须卖出去，滑点逐级放宽，绝不留下裸仓位 |
| 扫残留 | 把钱包里残余的交易币全部卖回，清零 |
| 只授权 / 只清残留 | `--approve-only` / `--sweep-only` 独立模式 |
| 多钱包并发 | `--concurrency N`，失败隔离，前置闸门跳过没 gas / 没币的 |
| 断点续跑 | 按**地址**记进度，重跑自动跳过已成功 |
| 批量报告 | CSV + JSON + 单文件 HTML（投入 / 回收 / 磨损 / bps / gas / 残留） |
| 磨损上报 | 跑完把每个钱包真实成本 POST 到数据台累计（第 9 节） |

### 采集与排行（`xdp/`）

| 能力 | 说明 |
|---|---|
| 三级数据源 | 链上直采（免费最快）+ 成交 WebSocket（OKX 自己的口径）+ REST（最准，花额度） |
| 入库过滤 | **只留官方计分的成交**，丢掉非 OKX 路由与「订单式成交」，省 90%+ 存储（第 6 节） |
| 跨源去重 | 三条源 trade_id 格式不同，一律按 `(tx_hash, wallet_address, type)` 认 |
| 物化排行 | 每 10 秒把窗口排行榜算好写进 `wallet_rank`，页面毫秒级读取 |
| 单文件看板 | 排行 + 增速 + 名额监测 + 门槛测算 + 我的钱包批量查询，无构建无框架 |
| 官网对账 | 直查 OKX 榜单接口；「净化排名」口径与官方吻合度 **104.8%** |

**做不到的**：判断行情（只按你给的参数下单）、拿到官方完整报名名单（官方只公开前 100）。

---

## 2. 从零开始

### 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **18+**（用了全局 `fetch` 与 ethers v6）。⚠️ 采集端的**链上 WSS 依赖 Node 22+**；服务器是 Node 16 时必须装 `ws` 包（已在 `xdp/package.json` 依赖里） |
| 钱包 | 一个或多个 Base 钱包，里面有计价币（USDC/USDT）和一点 ETH 做 gas |
| Chrome | 已登录 web3.okx.com，**只为导出一次 HAR** 拿会话，导完就不需要了 |
| 可选 | OKX API Key（只读权限即可）—— 只有想用 REST 回溯 / 对账才需要 |

### 第 1 步 · 装依赖并配置

```bash
git clone git@github.com:0xsolcom/xdp.git
cd xdp
npm install
cp .env.example .env && chmod 600 .env
printf '0x第一把私钥\n0x第二把私钥\n' > key.env && chmod 600 key.env
```

### 第 2 步 · 抓一次 HAR（拿会话）

接口凭据（`devid` / `x-fptoken` / UA 等）只存在于浏览器里，抓**一次**存下来即可：

1. Chrome 打开 web3.okx.com（已登录）→ F12 → Network
2. 随便刷新页面或做一次查询
3. 右键任意请求 → **Save all as HAR with content** → 存成 `web3.har`
4. 放到**当前目录、项目根目录或 `~/Downloads`**，跑 `node bin/trade.js` 时会自动发现并抽取

会话存在 `creds/web3-session.json`（已存在就直接复用；想换就删掉再放新 HAR）。

> `x-fptoken` 等价于「这台设备已登录的凭据」—— **泄露 = 别人能拿你的会话调接口**，绝不外传、不提交。

### 第 3 步 · 干跑（不签名、不广播）

```bash
node bin/trade.js --amount 1                        # 走一遍报价 → calldata → 打印待签交易
node bin/trade.js --wallets 0x你的地址 --amount 1    # 只给地址，纯只读
```

这一步通了，说明会话和参数都没问题。

### 第 4 步 · 小额真跑

```bash
node bin/trade.js --amount 3 --execute --yes
```

跑完看报告里的 **bps** —— 落在 40~50 bps 属正常（服务费 0.4% + 池子费/价差 0.04% = 0.44%，
即 **44 bps**；见第 9 节）。

### 第 5 步 · 上多钱包

```bash
node bin/trade.js --limit 3 --fast --execute --yes              # 先试 3 个
node bin/trade.js --concurrency 5 --sleep auto --fast --execute --yes   # 并发
npm run trade:status                                            # 看进度（不需要私钥）
```

### 第 6 步 · 起采集器与看板

```bash
cd xdp
npm install && cp .env.example .env      # 填 DB_* / CHAIN_* / 代币地址
npm run initdb
chmod +x start.sh stop.sh status.sh      # 从压缩包/同步工具拷过来会丢可执行位
./start.sh && tail -f logs/index.log
```

看板 `web/xdp.php` 是单文件，直接放进站点目录访问即可（第 10 节）。

### 第 7 步 · 出问题看这里

| 现象 | 先看 |
|---|---|
| 报价返回空路由 | 会话/设备号不对（第 3 节的 HAR 抓法） |
| 卖腿一直 revert | 滑点阶梯没放开；看报告里的「补卖」行 |
| 报告里磨损 = 投入全额 | 残留没卖出去（第 8 节） |
| 采集器日志 `Request failed with status code 429` | OKX 接口限流，或额度用尽（第 6 节） |
| 看板数字和官网差一大截 | 第 6 节的判据与对账表 |
| 数据暴涨 | 入过过滤没开（`INGEST_ONLY_OKX`） |

---

## 3. 目录结构

```
xdp
├── bin/
│   └── trade.js              交易 CLI（一买一卖，唯一入口）
├── src/
│   ├── session.js            从 HAR 抽 web3.okx.com 会话
│   ├── sign.js               Ok-Verify-* 请求签名（现场重算）
│   ├── client.js             带签名 + 重试 + 请求头随机化的客户端
│   ├── wallets.js            私钥文件解析 + 钱包选择
│   ├── solana.js             Solana 私钥解析（保留兼容，本工具不用）
│   ├── chains.js             各链基础信息（原生币 / 浏览器 / RPC 池）
│   ├── dex.js                DEX 底层：报价 / 签名 / 广播 / 回执 / 链上读取
│   ├── swap.js               一买一卖原语：准备 / 广播 / 等回执 / 原子来回 / 授权 / 扫残留
│   ├── cost-push.js          真实磨损上报（POST 到数据台）
│   └── trade-report.js       报告：CSV + JSON + 单文件 HTML
├── xdp/
│   ├── src/
│   │   ├── index.js          采集调度（cron 编排 + 启动横幅 + 版本号）
│   │   ├── config.js         全部配置与口径常量（唯一真源）
│   │   ├── db.js             MySQL 连接池（会话时区固定 UTC）
│   │   ├── rpc.js            JSON-RPC 批量调用（完整性校验 + 单条兜底 + 多节点轮换）
│   │   ├── router.js         路由判定：eth_getTransactionByHash → { okx, methodId }
│   │   ├── save.js           入库：过滤 → 跨源去重 → 落库（唯一写入口之一）
│   │   ├── onchain.js        链上直采（newHeads WSS + 解析回执 Transfer 日志）
│   │   ├── ws-trades.js      OKX DEX 成交 WebSocket
│   │   ├── realtime.js       REST 实时抓取（默认关，省额度）
│   │   ├── okx.js            OKX 接口客户端（含 402 付费墙熔断）
│   │   ├── backfill.js       增量回溯
│   │   └── blacklist.js      黑名单热更新
│   ├── scripts/              11 个运维脚本（回溯 / 对账 / 扫描 / 状态 / 排行刷新）
│   ├── web/xdp.php           单文件看板（⚠️ 含明文凭据，不入库）
│   ├── schema.sql            建表
│   └── start.sh stop.sh status.sh
├── creds/                    会话文件（不入库）
├── reports/                  报告输出（不入库）
├── key.env                   私钥（不入库）
└── .env / .env.example       配置
```

---

## 4. 命令与参数

### 4.1 npm 快捷命令

**交易端**（根目录）

| 命令 | 等价于 |
|---|---|
| `npm run trade` / `trade:execute` | 干跑 / 真跑（`--execute --yes`） |
| `npm run trade:fast` / `trade:fast:exec` | 原子来回 / 原子来回 + 真跑 |
| `npm run trade:par` / `trade:par:exec` | 并发 5 + `--sleep auto`（干跑 / 真跑） |
| `npm run trade:approve[:exec]` | 只做一次性无限授权 |
| `npm run trade:sweep[:exec]` | 只清残留 |
| `npm run trade:status` / `trade:reset` | 看进度 / 清进度（都不需要私钥） |
| `npm run trade:report` | 打开最新报告页 |

**采集端**（`cd xdp`）

| 命令 | 说明 |
|---|---|
| `npm start` / `stop` / `restart` | 起停采集调度（`status.sh` 看进程/明细/Top10） |
| `npm run status` | 一行看版本 / 进程 / 窗口 / 表量 / 物化榜 |
| `npm run initdb` | 建库 + 建表 |
| `npm run rank:refresh` | 手动刷一次物化榜 |
| `npm run rescan` | 完整回溯（链上，免费，约 2h） |
| `npm run rescan:resume` | 从断点续跑 |
| `npm run rescan:rest` | 链上 + OKX REST 回溯（最准，花额度） |
| `npm run reconcile` | 与官方榜逐钱包对账 |
| `npm run scan:routers` | 补齐未判定的路由 |
| `npm run poll:launchpool` | 抓官方榜采样（做对照用） |

### 4.2 通用约定

- **默认全部干跑**：不加 `--execute` 绝不签名、绝不广播。
- **私钥来源**：`--keys <path>`（默认 `key.env`）；**不接受命令行明文私钥**。
- **退出码**：0 = 全部成功；1 = 有失败（方便外面脚本串）。
- **优先级**：命令行参数 > 真实环境变量 > `.env`（当前目录优先，其次项目根）> 内置默认。

### 4.3 交易参数

**交易对象**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--quote TOKEN` | USDC | 计价币（钱）；可写符号或地址 |
| `--trade TOKEN` | XDP | 交易币（来回买卖） |
| `--amount N` | 1 | 每钱包每轮投入多少计价币；`all` = 全余额 |

**模式**

| 参数 | 说明 |
|---|---|
| `--fast` | 原子来回：买/卖 calldata 备好，nonce N / N+1 背靠背广播 |
| `--loop n` | **同一钱包**来回 n 轮（默认 1） |
| `--cycle n` | **整批（全部钱包）**跑完再来 n 遍（默认 1）；单钱包总来回 = `--loop` × `--cycle` |
| `--cycle-sleep 秒\|auto` | 两遍之间休息多久（默认 0 = 立刻开始下一遍；`auto` 沿用 `--sleep` 的推算） |
| `--approve-only` | 只做一次性无限授权 |
| `--sweep-only` | 只清残留 |
| `--token LIST` | `--approve-only` 的币（默认 quote,trade） |

**钱包与挑选**

| 参数 | 说明 |
|---|---|
| `--keys FILE` | 私钥文件（默认 `key.env`） |
| `--wallets ...` | 序号区间 `31-100` / 单个 `7` / 地址 `0xa,0xb`（地址没有私钥，只能查状态） |
| `--from` / `--to` | 第几把到第几把（1 起含两端；`--to 0` = 到最后） |
| `--limit n` | 最多处理 n 把 |

**并发 / 断点续跑**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--concurrency n` | 1 | 同时跑几个钱包（1 = 严格串行；上限 8） |
| `--sleep 秒\|auto` | 跟随 `--interval` | 并发时两次「启动」的间隔；`auto` = 按历史耗时 ÷ 并发数算 |
| `--api-gate ms` | 350 | 全局接口闸门：整进程发往 OKX 的请求间隔下限（仅并发时生效） |
| `--status` / `--reset` | 关 | 只看进度 / 清进度（不需要私钥） |
| `--retry-ok` / `--no-resume` | 关 | 连成功的也重跑 / 完全不用进度文件 |
| `--state FILE` | `creds/trade-state.json` | 进度文件路径 |

> ⚠️ **并发单位是钱包**：不同地址 nonce 天然独立。但**请求速率是全局的**，不随并发放大 ——
> 所有走 OKX 接口的请求都过一道进程级闸门。加并发提升的是「同时在等回执」的位数，
> 不是请求速率，这是躲 429 / 风控的关键。

**行为 / 闸门**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--slippage R` | 自动 | 买腿固定滑点（0.01 = 1%）；同时作为卖腿阶梯起点 |
| `--slippage-exit R` | 跟随 | 卖腿滑点阶梯起点 |
| `--max-slippage R` | 0.03 | 报价滑点闸门：超过就重新报价；`0` = 不限制 |
| `--max-value-diff R` | 0.003 | 报价价差闸门（`abs(diffPercent)`） |
| `--slippage-retries n` | 3 | 闸门连续超限前的重新报价次数 |
| `--api-retries n` | 3 | 接口瞬时错误重试 |
| `--buy-retries` / `--sell-retries n` | 3 | 买腿重试 / 卖腿补卖次数 |
| `--no-approve` | 关 | 授权不足也不补授权 |
| `--min-gas N` | 0.0002 | 前置闸门：原生币低于此值跳过该钱包（不算失败） |
| `--no-precheck` / `--no-sweep` | 关 | 关掉前置闸门 / 不做残留清扫 |
| `--sweep-min n` | 0 | 残留低于此数量就不扫；`0` = 全扫 |

**网络 / 执行**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--rpc URL` | 该链内置池 | 可逗号分隔多个，启动时测速选最快 |
| `--broadcast-rpc URL` | 同 rpc | 广播兜底；优先用报价里的 BlockRazor 私有中继 |
| `--interval SEC` | 1.2 | 两个钱包 / 两轮开始之间的最小间隔 |
| `--chain ID` | 8453 | 链 id |
| `--account-id UUID` | 随机 | 报价用 accountId |
| `--refcode CODE` | `11OKB` | referralCode |
| `--execute` / `--yes` | 关 | 真签真发 + 二次确认 |
| `--no-report` / `--report-dir DIR` | 关 / `reports` | 报告开关与目录 |
| `--session FILE` | `creds/web3-session.json` | 会话文件 |
| `--push-cost [文件\|all]` / `--no-push` | — | 磨损上报（第 9 节） |

### 4.4 采集端关键环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `INGEST_ONLY_OKX` | `1` | 只入库官方计分的成交（第 6 节） |
| `INGEST_DROP_ORDER_SWAP` | `1` | 连「订单式成交」也丢（约占入库量一半） |
| `REQUIRE_OKX_ROUTE` | `1` | 排行只算经 OKX 路由的成交 |
| `CLASSIFY_ROUTES_ON_SAVE` | 跟随上者 | 入库前顺带判路由 |
| `RPC_BATCH_SIZE` | 20 | `eth_getTransactionByHash` 批量大小（base.org 超 10~20 会截断，有完整性校验自动降级） |
| `CHAIN_RPC_URL` | `mainnet.base.org` | 采集用 RPC（换 Ankr keyed 端点可把批量开到 50） |
| `WS_TRADES_ENABLED` | `1` | 成交 WebSocket |
| `REST_REALTIME_ENABLED` | `0` | REST 实时抓取（默认关，省额度） |
| `ONCHAIN_RESCAN_MINUTES` | 20 | 链上重扫回溯窗口 |
| `CAMPAIGN_START_UTC` / `END_UTC` | — | 统计窗口（半开区间） |
| `VALID_QUOTE_SYMBOLS` | USDC,USDT,WETH,ETH,USDbC | 有效币对 |

---

## 5. 工作原理

### 5.1 交易链路

每个钱包独立执行（默认严格串行），一个失败不影响后面的：

```
[1/N] 地址
  ① 买  QUOTE → TRADE
       报价闸门 → calldata 校验(收款人/输出币/deadline) → 余额检查
       → 授权检查(真实 spender，不足自动补 approve) → eth_call 链上模拟
       → gas 估算 → 签名 → 广播 → 等回执
  ② 卖  TRADE → QUOTE
       按链上真实到账全部卖回；失败按滑点阶梯逐级放宽补卖
```

**报价闸门（quoteId 的寿命）**：`quoteId` 秒级过期，quote → calldata 的窗口很短，
所以脚本是「拿到报价立刻换 calldata」，中间不做耗时操作。

**gas**：`gasLimit = max(接口值, eth_estimateGas × 1.2)`，下限 300000 ——
⚠️ 接口给的 gas **会偏低**，直接用会 OutOfGas 空 revert。

**RPC 选点**：启动时对池子做**两项**探测 —— 延迟（`eth_blockNumber`）+ **回执能力**
（`eth_getTransactionReceipt` 一个不存在的 hash，正常节点返回 `null`）。

> 只测延迟会被坑：`base-rpc.publicnode.com` 最快（~200ms），但取回执直接报
> `Archive requests require a personal token` —— 选它当主节点，每笔授权都要空等
> 一整个回执预算才超时。现在这类节点会被**自动排除**并打印原因，主节点报错时
> `rpc()` 还会自动轮换到池里其它节点。

### 5.2 采集端：三级数据源

| 源 | 怎么来 | 延迟 | 成本 | 角色 |
|---|---|---|---|---|
| `onchain` | 订阅 Base `newHeads`（WSS），出块就解析回执里的 Transfer 日志 | **2~6 秒** | 免费 | **主力**（占新增约 94%） |
| `ws` | OKX DEX 成交 WebSocket `wss://wsdexpri.okx.com/ws/v5/ipublic`，频道 `dex-market-trade-history-pub` | 3~15 秒 | 免费 | **补漏**：链上认不出来的（第三方代付、ETH 计价）它兜住 |
| `okx` | REST `/api/v6/dex/market/trades` | 秒级 | 花额度 | **最准**（OKX 自己的口径），默认关 |

三条源的 `trade_id` 格式互不相同，**必须按 `(tx_hash, wallet_address, type)` 去重**
（不认 `trade_id`）；优先级 `okx > ws > onchain`，只有 `okx` 会**覆盖**已有的 ws/onchain 行。

> 日志里 `[WS] 收 2028 笔 / 入库 28 笔` 不是「WS 没用」—— 是链上早到了几秒，
> 那 2000 笔已被链上抢先写入，WS 推来时按去重规则丢掉。

### 5.3 入库过滤（省 90%+ 存储的核心）

采集端把**每一笔新成交**都先判一次「官方认不认」，不认的直接不进库：

```
非 OKX 路由（is_okx=0）        → 丢        （丢掉约 92%，本来进不了任何统计）
dagSwapByOrderId（订单式成交） → 丢        （约占入库量一半，官方一封都不算）
dagSwapTo                      → 收
判不出来（节点没返回）          → 保留 NULL，留给 scan-routers 补判（绝不因一次抖动丢真实成交）
```

两条写入路径**都要过滤**（这是踩过的坑，见第 11 节 B1）：

| 路径 | 入口 | 过滤在哪 |
|---|---|---|
| WS / REST | `save.js` 的第 2.4 步 | `okxMap.get(txHash)` → `{okx, methodId}` |
| 链上直采 | `onchain.js` 的 `ingestOnchain()` —— ⚠️ **它有自己的 INSERT，绕过 save.js** | `isDroppedSwap(tx)` |

实测丢弃率：`丢非OKX 124 笔 / 丢订单式 13 笔 / 保留 OKX 17 笔（丢弃率 89%）`。

### 5.4 跨源去重

```
okx: 1790644953000!@#1509!@#77976518507
ws:  1790644791000!@#854
onchain: oc:0x…:0x…:buy
```

三种格式完全不同，所以**只认 `(tx_hash, wallet_address, type)`**（复用 `idx_tx_wallet_type`）。
判断的是**库里**有没有，不是本批有没有 —— 一个 tx 里可能有两笔同向成交，`(tx,wallet,type)` 相同但必须都入库。

---

## 6. 数据口径与判据

### 6.1 活动与统计窗口

| 项 | 值 |
|---|---|
| 活动 | Doppler Finance X Launch（`launchpoolId = 792`，`navName = dopplerfinance`） |
| 链 | Base（chainId **8453**） |
| 代币 | XDP `0x07b3d902783c3c12b077508c3b5c00113d1291d0` |
| **参与时间** | **2026-09-28 21:40 ~ 2026-09-30 21:40（UTC+8）** = `2026-09-28T13:40:00Z` ~ `2026-09-30T13:40:00Z` |
| 奖励 | **20,000,000 XDP** = 均分 10,000,000 + 交易量 10,000,000，最多 **8000** 个获奖钱包 |
| 有效币对 | XDP-USDC / USDT / WETH / ETH / USDbC |
| OKX 路由合约 | `0x67d03631fe51b741c0c00c4e16eb662ac84381df` |

统计窗口是**半开区间**：`trade_time >= 起 AND < 止` —— 09-30 21:40:00 那一刻**不计入**。
库里时间一律存 **UTC**，自己写 SQL 复核时注意。

### 6.2 ★ 有效成交的判据：MethodID（不是笔数、不是金额）

`tx.to` 都是同一个 OKX 路由，**只差调用的函数**：

| MethodID | 签名 | 笔数 | 钱包 | 成交额 | **官网前 100 用它** |
|---|---|---|---|---|---|
| `0x0c307f76` | **`dagSwapTo`** | 14,243 | 890 | $3,002,363 | **99 / 100** |
| `0xf2c42696` | **`dagSwapByOrderId`** | 13,341 | **62** | **$3,767,922** | **0 / 100** |

- `dagSwapTo` = 普通兑换（自己指定收款地址）→ **官方活动认这个**
- `dagSwapByOrderId` = **按订单号成交**（订单式 / 做市 API 路径）→ **官方一封都不算**

覆盖率 **100%**：`is_okx=1` 的成交全部能查到 `method_id`（`okx_route` 表缓存）。
签名由 [4byte](https://www.4byte.directory/) 解出，与 calldata 形状吻合
（`dagSwapTo` 4320 字节带原生币哨兵 + 大签名块；`dagSwapByOrderId` 992 字节标准参数）。

### 6.3 本地 vs 官方对账

| 口径 | 本地 | 官方 | 比值 |
|---|---|---|---|
| 全部 `is_okx=1` | $6,767,653 | $2,864,433 | **232%** ❌ 误导 |
| **排除 `dagSwapByOrderId`（净化口径）** | **$3,002,363** | $2,864,433 | **104.82%** ✅ |

**为什么 232% 是假的**：本地榜统计「所有走 OKX 路由的钱包」，官方只统计**已报名参与者**。
本地高位被一批高频地址占满（如 `0x58e4bacd…` 393 笔 / $40,975，是官方第 1 名的 1.5 倍），
官方一个都不算。

**残余的 4.82%** 是「没报名的正常散户」—— 画像正常（`0x016a88b7…` 16 笔 / $22,165、
`0x5c403bb5…` 5 笔 / $19,894，这种量如果报了名稳进官方前 3，不在榜上只能是没报名）。
官方只公开前 100、也没有按地址查询的接口（`my` 只认 `accountId`），所以拿不到完整名单，
**这个 4.82% 压不下去**。

> ⚠️ 所以：**本地榜的单个钱包名次不能当官方名次用**。要准确名次请看看板的「官网排名」列
> —— 那是拿你的 `accountId` 直接查官方接口回来的。

### 6.4 费率：磨损 = 成交额 × 0.44%

| 项 | 值 | 证据 |
|---|---|---|
| OKX DEX 服务费 | **0.4%**（每腿） | 官方费率页 <https://web3.okx.com/zh-hans/dex-fees>；链上回执里每腿都有 0.4% 的 USDC 打给 OKX 收款地址；XDP/USDC 池是 Uniswap V3 `fee tier 100 = 0.01%`，OKX 报价恰好 = 直连报价 × 0.996 |
| 池子费 / 价差 | 0.04% | Uniswap V3 0.01% × 2 + 少量价差 |
| **合计** | **0.44%** | 实测 80.000000 投入 → 0.705157 磨损 / 159.294843 成交额 = **0.4427%** |

**磨损与金额无关**（0.5 → 3000 USDC 实测恒 ~44 bps），只有 gas 随金额摊薄。

---

## 7. 看板

`xdp/web/xdp.php` —— **单文件**，服务端只出 JSON，浏览器负责渲染。不要框架、不要构建、
图表用 CSS 画。**明文凭据写在文件顶部，整个 `xdp/web/` 不入库**。

### 接口清单

| 接口 | 说明 |
|---|---|
| `?api=bundle` | 概览 + 增速 + 名额 + 门槛 + 榜单首页（首屏一次拿全） |
| `?action=local` | 批量查询的本地列（`addresses=`，读 `wallet_rank`，每 10 秒轮询） |
| `?action=combined` | 批量查询的官网列（服务端代理 OKX 榜单接口，免 CORS） |
| `?action=trades` | 单钱包成交明细 |
| `?action=cost-ingest` | 磨损上报入口（`X-Ingest-Token` 鉴权 + `INSERT IGNORE` 幂等） |

### 「我的钱包批量查询」

每行一条 `地址,AccountId`：

| 列 | 数据源 | 刷新 |
|---|---|---|
| 本地交易量 / 本地名次 / 真实磨损 | `wallet_rank` + `wallet_cost` | **每 10 秒自动刷** |
| **官网交易量 / 官网排名** | OKX 榜单接口（`?action=combined`） | **点「🌐 拉官网」才拉** |
| 预计奖励 | 拉过官网就用官网的，否则本地奖池公式估 | — |
| 估算损耗 | 本地成交额 × 0.44%（悬停里有 OKX 流水口径的交叉验证） | — |
| **净化排名** | 只算 `dagSwapTo`、剔除订单式成交的名次 | 自动刷 |

不自动拉官网的原因：那接口是**逐个钱包**查的（URL 只认 `accountId`），几十个钱包就是
几十次外部请求，10 秒一次会拖慢页面还可能被限流。

> ⚠️ **配对告警**：官网返回的 `walletAddress` 才是 `accountId` 真正对应的钱包。
> 行里写的地址跟它对不上会打 ⚠️ —— 否则你会拿 A 地址的本地数据去对 B 账号的名次。

---

## 8. 授权 / 残留 / gas

### 授权

- 额度固定 `MaxUint256`（无限），**每个币只做一次**；已经是无限就跳过。
- spender 以报价返回的 `approveTxInfo.dexContractAddress` 为准（平台 11）。
- 判断是否已授权用**链上 allowance**（用阈值，不跟 `MaxUint256` 比等号）。
- 交易时发现不足会**自动补一笔，并等确认后再发 swap**。
- `--approve-only` 里同一钱包的多个代币**背靠背广播**（nonce N / N+1），最后一起等回执
  —— Base 出块 ~2s，一笔一笔「发完等确认」会把等待线性叠加。
- ⚠️ 报价里的 `approveTxInfo.nonce` **不用**，一律取链上 pending nonce。

### 残留清理（残留 = 裸敞口）

三层兜底：

1. 一买一卖后立刻扫（读链上真实余额，全部卖回）
2. 扫完复核，没清零再扫一轮（最多 2 轮）
3. 随时可跑 `--sweep-only` 单独清

### gas 与 RPC

- gasLimit = max(接口值, `eth_estimateGas` × 1.2)，下限 300000。
- 原子来回的卖单此时手里还没币，`estimateGas` 必失败，用「接口值 × 1.5」兜底。
- 回执轮询按 2s 一轮（默认 30 轮 = 60s）。**回执超时不等于失败** —— 会回查链上状态，
  真的上链了就当成功（Base 拥堵时回执常晚到）。

---

## 9. 真实磨损上报

交易端跑完把**每个钱包的真实成本** POST 到数据台累计，按地址入库：

```
交易端 bin/trade.js  →  POST ?action=cost-ingest  →  wallet_cost_detail  →  wallet_cost（按地址累计）
```

- **幂等靠 `runId`**（`trade-<时间戳>-<hex>`）：重推同一份报告不会重复累加；
  旧报告用文件名兜底。
- 配置（`.env`）：`COST_INGEST_URL` / `COST_INGEST_TOKEN`；想临时关掉用 `--no-push`。
- 手动补推：`node bin/trade.js --push-cost`（最新一份）/ `--push-cost all`（全部历史）。
- **为什么不让交易端直连 MySQL**：数据台在公网服务器上，把 3306 暴露出去风险太大；
  服务器上已有 PHP，让它代写最省事，还能顺便做鉴权和幂等。

看板「我的钱包批量查询」里的**真实磨损**列读的就是它。

---

## 10. 部署与运维

### 10.1 服务器布局

```
/root/xdp/                                  采集程序（Node）
  ├── src/ scripts/ .env package.json
  ├── logs/index.log                        运行日志
  └── .rescan-state.json                    回溯断点
/www/wwwroot/<域名>/xdp/xdp.php             看板（PHP，属主 www:www，755）
/root/backup/                               数据清理前的备份（.tsv.gz）
```

### 10.2 部署（rsync + install + restart）

```bash
# 采集程序（保留属主，改完代码必须 restart —— Node 会缓存已加载的模块）
rsync -az src/ scripts/ .env root@host:/tmp/dep/
ssh root@host 'install -o root -g root -m 644 /tmp/dep/src/*.js /root/xdp/src/ && \
               cd /root/xdp && ./stop.sh && ./start.sh && tail -5 logs/index.log'

# 看板（必须保留 www:www 755，否则 php-fpm 读不到）
ssh root@host 'install -o www -g www -m 755 /tmp/xdp.php /www/wwwroot/<域名>/xdp/xdp.php && \
               php -l /www/wwwroot/<域名>/xdp/xdp.php'
```

> ⚠️ `rsync -a` 会连**属主和权限**一起带过去（本地 UID 501 → 服务器上变成 501:games）。
> 部署后要 `chown -R root:root /root/xdp`，看板那份用 `install -o www -g www` 单独落位。

### 10.3 上线自检

```bash
cd /root/xdp
tail -n 30 logs/index.log | grep -E '启动|入库过滤|路由口径|成交 WS'   # 版本/开关/连接
curl -s '/path/xdp.php?action=local&addresses=0x…' | head -c 200       # 看板接口
mysql -e "SELECT source,is_okx,COUNT(*) FROM trades GROUP BY 1,2"      # 库里只有 is_okx=1
```

### 10.4 巡检

| 命令 | 看什么 |
|---|---|
| `xdp/status.sh` | 版本 / 进程 / 明细 / 物化快照 / Top10 |
| `npm run status` | 同上（不需要可执行位） |
| `grep '\[过滤\]' logs/index.log \| tail` | 丢弃率是否正常（80~95%） |
| `grep '\[WS\]' logs/index.log \| tail` | WS 收/入库/重连（汇总每 5 分钟一行） |
| `grep 429 logs/index.log` | OKX 限流（偶发正常，持续就要降速） |
| `npm run reconcile` | 与官方榜逐钱包对账 |

### 10.5 数据体积（实测）

| 阶段 | 整库 | 说明 |
|---|---|---|
| 最初（不过滤 + 全量收） | **423 MB** | 非 OKX 占 86% |
| 清掉 141,328 笔非 OKX 行 | 139.5 MB | `is_okx=0` 删净；榜单**一分没变**（它本来就不计入） |
| 清掉 13,361 笔订单式成交 | 131.5 MB | 这笔**会改榜单**：$6.9M → $3.1M，正好对上官方 |
| 清掉 `okx_route` 里 163,591 条死缓存 | **46.9 MB** | 缓存表比数据表大 3 倍 |

> 删之前一律先备份成 `.tsv.gz` 到 `/root/backup/`，并记录「删除前基准」，
> 删完逐项核对（不变项必须一字不差，变化项要能对上账）。

---

## 11. 踩坑与修复记录

### A. 交易端

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| A1 | 授权每笔都空等一整个回执预算（60s） | RPC 选点只测了延迟 —— `base-rpc.publicnode.com` 最快却取不到回执（`Archive requests require a personal token`） | 启动探测加**回执能力**，不行的**自动排除**并打印原因；主节点报错自动轮换 |
| A2 | `--sweep-only` 首次 revert 就放弃，留下裸敞口 | 滑点太紧 | 滑点阶梯 `[null, 0.03, 0.06]` 重试 |
| A3 | 回执超时被当成失败，但链上其实成功了 | Base 拥堵时回执晚到 | 超时后复查链上（allowance / 持仓），真上了就算成功 |
| A4 | `.env` 里的变量不生效 | `dex.js` 在 `loadDotEnv()` 之前就 `Number(process.env.X)` 求值了 | 改惰性读取（`envNum()`） |

### B. 采集端

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| B1 | 入库过滤开了，但库里仍冒出 `is_okx=0` / 订单式成交 | **两个独立漏点**：① `scripts/scan-routers.js`（每 20 秒一次的兜底）无条件 `UPDATE … is_okx = 0`，没尊重 `INGEST_ONLY_OKX`；② `src/onchain.js` 有**自己的 INSERT**，完全绕过 `save.js` 的过滤 | 两处都补：兜底改为「判明非 OKX 就**删**」，直采加 `isDroppedSwap()` 且**连回执都不再取** |
| B2 | 改了代码重启，行为没变 | 服务器上还挂着一个**旧进程**在跑（`full-rescan.js` 后台跑了 14 分钟没人知道），用的是旧代码，一边塞垃圾一边抢 RPC 把实时通道打出一片 429 | `full-rescan.js` 加**单实例锁** `.rescan.lock`（重复启动直接退出并报旧 PID） |
| B3 | 「未判定」的行永远躺在库里 | 入库那一刻节点没返回 → 存 NULL，事后判明是 0 却只标记 | 过滤开启时，事后判明的非 OKX 行**直接删**（只删 `is_okx IS NULL` 的，判过 1 的绝不碰） |
| B4 | 拉块失败后那个块被**永久跳过** | `seen.add(num)` 写在了拉块之前 | 失败时 `seen.delete(num)` |
| B5 | WSS 断线不补洞（HTTP 轮询有、WSS 没有） | 两条路径实现不一致 | WSS 也补洞（`GAP_FILL_MAX=300`） |
| B6 | 服务器日志只说「WSS 不可用」，没有原因 | `ws.onerror = () => {}` 把错误吞了 | 打全原因 + `resolveWebSocket()` 回退到 `ws` 包（Node 16 没有全局 WebSocket） |
| B7 | 原生 WebSocket 回调收到 `[object MessageEvent]`，静默丢包 | Node 的 `MessageEvent` 与 `ws` 包的裸数据回调参数不同 | `const text = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw` |
| B8 | 用 `mysql` CLI 查出来的数据量级完全不对 | CLI 没设 `time_zone`，`created_at`（本地时区）跟 `UTC_TIMESTAMP()` 比，窗口实际放大成 8 小时 | 统一走 Node（`SET time_zone='+00:00'`） |
| B9 | `Column 'is_okx' in where clause is ambiguous` | `trades` 和 `okx_route` 都有 `is_okx` 列，JOIN 后没加表前缀；重试循环把真实错误吞了 | 加 `t.` 前缀；重试循环打印最后一次错误 |
| B10 | 一笔交易的成交人被记成"付款方" | 链上是「付款方 ≠ 收币方」—— `from` 出 USDC，XDP 进了另一个地址的口袋 | **不是 bug**：OKX 自己的接口给的 `userAddress` 就是收币方，两边一致 |

### C. 看板

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| C1 | 增速看板短窗口全是 0 | `valid_pair_condition` 用 `raw_json LIKE '%"tokenSymbol": …%'`，漏掉所有 `source='onchain'` 的行 | 改成优先 `quote_symbol IN (…)` |
| C2 | 同一档「已达标」在两处不相等 | 一处按全局参与人数、一处按档位 | 统一成同一个公式 |
| C3 | 官网列拉了但地址对不上 | 官网接口认 `accountId`，返回的 `walletAddress` 才是真身 | 加配对告警 ⚠️ |
| C4 | 「本地/官方 = 232%」误导 | 本地含未报名的高频地址 | 加「净化排名/净化总量」口径（第 6.2 节） |

---

## 12. 安全与密钥管理

这个项目**真的会动钱**。按重要性排：

1. **默认干跑**：不加 `--execute` 绝不签名、绝不广播
2. **私钥只从 `.env` / `--keys` 读**，不接受命令行明文（不进 `ps` / shell history）
3. **广播前双重校验**：`tx.from` 必须等于你的地址 + 每笔先 `eth_call` 模拟
4. **失败只跳过单个钱包**，不会带着裸仓位继续跑
5. **私钥文件 `chmod 600`**，单独放加密盘 / 离线介质；别同步网盘
6. **先用极小金额试**，确认报告和链上都对得上再放量

### 绝不入库的文件（都已在 `.gitignore`）

| 文件 / 目录 | 里面有什么 |
|---|---|
| `.env` | 会话相关、返佣码、磨损上报令牌 |
| `key.env`、`*.key`、`k.txt`、`*.txt` | 钱包私钥 |
| `creds/` | **会话凭据**（含 `x-fptoken`，等价于已登录设备凭据） |
| `reports/` | 报告页 / CSV，含钱包地址与磨损 |
| `xdp/web/` **整个目录** | `xdp.php` 把**数据库密码 / OKX API 密钥 / 上报令牌明文写在文件里** |
| `xdp/.env`、`xdp/.rescan-state.json`、`xdp/.rescan.lock` | 配置与运行状态 |
| `logs/`、`*.log`、`*.har` | 日志与抓包 |
| `.ssh/`、`*.pem`、`id_ed25519*` | 密钥 |

`.env.example` 是**占位模板**，可以入库。

### 上传 GitHub 前的自检

```bash
# 1) 确认敏感文件被忽略
git check-ignore -v .env key.env creds/ reports/ xdp/web/ xdp/.env
# 2) 全仓扫密钥 —— ⚠️ 关键字从 .env 里现读，绝不把凭据写进文档
SECRETS=$(grep -hE '^(DB_PASSWORD|OKX_API_KEY|OKX_SECRET_KEY|COST_INGEST_TOKEN)=' .env xdp/.env 2>/dev/null \
  | cut -d= -f2 | grep -v '^$' | tr '\n' '|' | sed 's/|$//')   # macOS 的 BSD paste 不认 -d'|'
FILES=$(git ls-files -co --exclude-standard)          # 已跟踪 + 待新增
[ -n "$FILES" ] && echo "$FILES" | tr '\n' '\0' \
  | xargs -0 grep -lnE "$SECRETS|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY" 2>/dev/null; true
# 3) 看真正会被提交的清单
git add -A --dry-run | sort
```

> 已经不小心提交过凭据：**改密码 / 换私钥** → `git filter-repo` 或重建仓库 —— 历史里也能翻出来。

---

## 13. 免责声明

这是与 OKX 官方无关的第三方脚本，用的是逆向出来的私有接口，接口可能随时变更。
链上交易不可撤销，**先用干跑确认，再自己决定要不要签名广播**。
批量刷量可能触及平台风控与活动规则，后果自负。
