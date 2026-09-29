# xdp（XDP / Doppler Finance on Base 交易量采集与排行榜）

抓取 **Base** 链上 **XDP（Doppler Finance，`0x07b3d902783c3c12b077508c3b5c00113d1291d0`）**
的买卖成交记录，写入 MySQL 做钱包维度汇总，并提供排行榜页面。
结构、口径、运维方式对齐仓库里的 `bank/`（OKX DEX 采集 + 排行榜），针对 Base/XDP 做了适配。

- 链：Base（`CHAIN_INDEX=8453`，原生币 ETH，浏览器 basescan.org）
- 代币：`0x07b3d902783c3c12b077508c3b5c00113d1291d0`
- 数据源：OKX DEX 成交接口 `/api/v6/dex/market/trades`（HMAC 签名）
- 运行环境：Node.js 18+（ESM，已在 v24 实测）

## 活动信息（来自 OKX 官方接口，非猜测）

活动页 <https://web3.okx.com/zh-hans/boost/x-launch/dopplerfinance>，
配置取自 `/priapi/v1/dapp/boost/launchpool/detail?navName=dopplerfinance`：

| 项 | 值 |
| --- | --- |
| launchpoolId | **792**（`leaderboard?launchpoolId=792` 可查官方榜） |
| 名称 / 链 | Doppler Finance X Launch / Base（chainId 8453） |
| **参与时间** | **2026-09-28 21:40 ~ 2026-09-30 21:40（UTC+8）** = 2026-09-28 13:40 ~ 2026-09-30 13:40（UTC） |
| **奖励领取时间** | **2026-09-30 23:40 ~ 2026-10-14 23:40（UTC+8）** = 2026-09-30 15:40 ~ 2026-10-14 15:40（UTC） |
| 奖励 | **20,000,000 XDP** = 均分奖池 10,000,000 + 交易量奖池 10,000,000，最多 **8000** 个获奖钱包 |
| 有效币对（Base） | **XDP-WETH / XDP-USDC / XDP-USDbC / XDP-ETH / XDP-USDT** |
| OKX 路由合约（Base） | **0x67d03631fe51b741c0c00c4e16eb662ac84381df**（methodId `0x0c307f76`） |

**口径结论（已实测验证）**：官方 Boost 交易量 = **经 OKX DEX 路由**的成交额，
所以本项目 `REQUIRE_OKX_ROUTE=1`。验证方法见下方「官方榜对账」。

**另一条同样重要的结论 —— 官方榜只收录「已报名」钱包：**

实测证据：官方榜**尾部有钱包交易量是 $0.00**，说明官方**没有交易量门槛**；
而本地一个交易量 $42,924 的地址（远超官方第 1 名 $13,055）却完全不在榜上。
=> 差异与交易量无关，纯粹是**有没有报名**（`participants` 一千多，其中只有几十个有量；
没报名的大额地址多是做市/搬砖机器人）。

所以本项目 `ONLY_OFFICIAL_WALLETS=1`：`scripts/poll-launchpool.js` 每 60 秒把官方榜
的报名钱包名单写进 `official_wallet` 表，`refresh-rank.js` 只统计名单内的钱包。
名单为空时自动降级为不过滤（避免空榜）。

### 奖励规则（与 bank 的差异）

活动详情原文：**进入前 8000 名即可瓜分奖池**

- **均分奖池 10,000,000 XDP** —— 由前 8000 名用户平均分配
- **交易量奖池 10,000,000 XDP** —— 按「你的交易量 ÷ 前 8000 名用户总交易量」的比例分配

落到公式（与 bank 是**同一个结构**）：

    预计奖励 = 均分奖池 ÷ 当前有效人数 + (交易量奖池 ÷ 总交易量) × 个人交易量

`xdp.php` 的 `okx_launchpool_total()` 用官方榜单每行 `estimatedReward`/`boostVolume`
做最小二乘拟合 `y = c + k·x`：`c` = 均分池每人、`k` = 单位交易量奖励，
`获奖人数 = 均分奖池 ÷ c`（所以榜单被截断也能反推准确）。

**差别（结构相同，参数与币种不同）：**

| | bank（Lorenzo，id 789） | xdp（Doppler Finance，id 792） |
| --- | --- | --- |
| 奖励币种 | **USDT**（稳定币，奖励价值固定） | **XDP**（就是被交易的代币，奖励价值随币价波动） |
| 总奖励 | 200,000 USDT | 20,000,000 XDP |
| 均分奖池 | 80,000（占 **40%**） | 10,000,000（占 **50%**） |
| 交易量奖池 | 120,000（占 **60%**） | 10,000,000（占 **50%**） |
| 分奖名次 | 前 **5000** 名 | 前 **8000** 名 |
| 均分池每人 | 动态 = 均分奖池 ÷ 当前有效人数 | 同 |
| 公式 | 均分 + 交易量占比 | 同 |

## 目录结构

```
xdp/
├── .env                     # 采集器配置（含密钥，禁止提交）
├── .env.example             # 配置模板
├── schema.sql               # 数据库建表脚本
├── start.sh / stop.sh / status.sh   # 采集启停与状态
├── src/
│   ├── config.js            # 集中读 .env：链/代币/窗口/币对/路由口径
│   ├── index.js             # 主入口：cron 调度实时 + 回溯 + 合约检测 + 排行刷新
│   ├── okx.js               # OKX API 客户端（HMAC-SHA256 签名 + 429 退避）
│   ├── db.js                # mysql2 连接池（UTC 会话时区）
│   ├── realtime.js          # 实时增量抓取
│   ├── backfill.js          # 历史回溯（游标续传 + 截止时间）
│   ├── save.js              # 写库（幂等去重 + 黑名单 + 采集上界）
│   ├── router.js            # OKX 路由判定（可选口径）
│   └── blacklist.js         # 黑名单（.env 热更新）
├── scripts/
│   ├── init-db.js           # 建库 + 导入 schema.sql
│   ├── scan-contracts.js    # eth_getCode 批量识别合约地址（断点续传）
│   ├── scan-routers.js      # 路由判定兜底扫描
│   ├── find-okx-routers.js  # 路由发现：统计 to/methodId 分布，找出 OKX 路由
│   ├── refresh-rank.js      # 物化排行榜（wallet_rank / rank_meta）
│   ├── reconcile-official.js# 与 OKX 官方榜对账（验证口径 / 漏单）
│   ├── poll-launchpool.js   # 官方榜单采样（可选，配 LAUNCHPOOL_ID 才启用）
│   └── status.js            # 状态与 Top10
└── web/
    └── xdp.php              # 排行榜：bank.php 原样移植 + canopy 后端内联，仍是单文件
```

## 快速开始

```
cd xdp
npm install
cp .env.example .env        # 填入 OKX API、数据库、代币地址等
npm run initdb              # 建库 + 建表（库名取 .env 的 DB_NAME，默认 okx_xdp）

# 首次：给启停脚本加可执行位（从 Windows / 压缩包 / 同步工具拷过来会丢这个位）
chmod +x start.sh stop.sh status.sh

./start.sh                  # 后台常驻（写 logs/index.log）
tail -f logs/index.log      # 实时看日志（另开一个窗口）
```

> 不想用 shell 脚本也行：`npm start` 直接前台跑采集（不需要可执行位），
> 停就用 `Ctrl-C`。`./start.sh` 只是多了「后台 + PID 文件 + 日志」这几件事。

> ⚠️ **本项目的 .env 优先于 Shell 环境变量**（`dotenv.config({ override: true })`）。
> 部署机上常有别的项目导出的 `DB_*` / `CHAIN_*`，若不覆盖会出现「连错数据库 / 抓错链」
> （首次搭建时就踩过一次：把表建进了共享库 `okx_dex`）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run initdb` | 建库 + 导入 `schema.sql` |
| `./start.sh` | 后台常驻（需可执行位；否则 `bash start.sh`） |
| `npm start` | 前台常驻，不需要可执行位，`Ctrl-C` 停 |
| `./status.sh` / `npm run status` | 查看进程、明细、物化快照与 Top10 |
| `./stop.sh` / `npm run stop` | 停止采集（`npm run stop` 不需要可执行位） |
| `npm run restart` | 停 + 重启（改了代码必须重启，否则内存里还是旧模块） |
| `tail -f logs/index.log` / `npm run logs` | **实时看日志** |
| `tail -f logs/index.log \| grep 链上` | 只看链上实时通道（出块触发 / 直采） |
| `npm run realtime` / `npm run backfill` | 单次实时 / 回溯 |
| `npm run scan:contracts` | 扫描钱包地址是否为合约（可反复跑，续传） |
| `npm run scan:routers` | 路由判定兜底扫描（`REQUIRE_OKX_ROUTE=1` 时才有意义） |
| `npm run scan:routers:discover` | 路由发现：打印 to/methodId 分布 |
| `npm run rank:refresh` | 物化排行榜（`wallet_rank` / `rank_meta`），页面读的就是它 |
| `npm run reconcile` | **与 OKX 官方榜对账**（逐钱包比对，验证口径/漏单） |
| `npm run status` | 查看明细 / 游标 / 物化快照 / Top10 |

## 数据流

1. `realtime.js` / `backfill.js` 调 OKX `/api/v6/dex/market/trades`，用 `after` 游标翻页。
2. `save.js` 过滤黑名单 / 聚合器重复条目 / 超过 `COLLECT_END_TIME` 的成交，
   解析计价币符号（`changedTokenInfo` 里非本代币的那个）写入 `quote_symbol`，
   再 `INSERT IGNORE trades`（`trade_id` 唯一实现幂等）。
3. `backfill.js` 用 `crawl_cursor` 记录游标，翻到截止时间或接口尾部后置 `is_initialized=1`。
4. `scan-contracts.js` 用 `eth_getCode` 批量判定地址是否为合约，写 `contract_check`，
   并回填 `trades.wallet_is_contract`。
5. `refresh-rank.js` 按口径物化 `wallet_rank` / `rank_meta`（默认每 10 秒）。
6. `web/xdp.php` 页面直接读 `wallet_rank` 出榜，没有中间文件。

## 实时性：比官方榜快

官方榜的刷新是几十秒级的（实测 25 秒内 `totalBoostVolume` 完全不变），
OKX 的 trades 接口本身只落后链上 1~2 秒 —— **慢的从来不是数据源，是我们的轮询间隔**。
所以加了一条链上实时通道（`src/onchain.js`）：

| 通道 | 作用 |
| --- | --- |
| **出块订阅**（WSS `newHeads`） | 订阅 Base 新区块；只要块里有「打到 OKX 路由且 methodId=0x0c307f76」的交易，**立刻**触发一次抓取 + 刷新排行，把定时轮询的等待时间抹掉 |
| **链上直采**（`WATCHER_INGEST=1`） | 自己解析回执里的 `Transfer` 日志，直接算出「谁 / 买还是卖 / 多少量」入库（`source='onchain'`），**不等 OKX 索引**。随后 OKX 接口到达同一笔时，`save.js` 会用官方口径覆盖它（`source` 改回 `okx`）—— **速度靠直采，准确性仍以 OKX 为准** |
| **定时兜底** | `CRON_REALTIME=*/2`，防止 WSS 抖动漏单 |

直采只处理**稳定币计价**（USDC / USDT / USDbC，价格 ≈ 1，不需要喂价）；
ETH/WETH 计价与智能钱包（4337）交给 OKX 接口兜底，避免喂价与归因出错。
去重靠 `(tx_hash, wallet_address, type)`（`idx_tx_wallet_type`）。

**实测（改动前后）：**

| | 落后当前时间 | vs OKX 接口 |
| --- | --- | --- |
| 改之前（10 秒轮询） | 6 ~ 12 s | 慢 6 ~ 10 s |
| 改之后（出块触发 + 直采） | **1.1 ~ 2.9 s** | 5 次采样里 **4 次追平或更快** |

补历史/补漏：`npm run scan:onchain -- --minutes 90` —— 从链上重建指定区间的成交，
用来补齐 OKX 接口不返回的那几个钱包（现在有 6 个官方钱包在接口里查不到）。

## 补漏：周期性增量回溯（`npm run recheck`）

**问题**：OKX 的 trades 接口对新交易有**索引延迟** —— 一笔成交上链了，接口可能几分钟后才返回它，
甚至先返回空。而 `backfill.js` 是一次性的：游标 `is_initialized=1` 之后**永不再扫**，
这些「晚索引」的成交就永久丢了。

**实测代价**：重置游标重扫一遍后，与官方榜的对账命中率 **84% → 99%**，
6 个官方钱包从「本地查不到」变成能查到。

**修法（两条，都已落地）**：

1. `scripts/recheck-window.js` —— 不管回溯是否完成，每 `CRON_RECHECK`（默认 10 分钟）
   把最近 `RECHECK_MINUTES`（默认 120 分钟）重扫一遍。写入走 `saveTrades`
   （`trade_id` 唯一 → `INSERT IGNORE`），天然幂等，不会重复计数。
2. `backfill.js` 不再「一次空页就认定翻到头」：空页只累加 `empty_streak`，
   连续 `BACKFILL_EMPTY_CONFIRM`（默认 3）次才置 `is_initialized=1`，否则下一轮继续试。

```
npm run recheck            # 手动重扫最近 120 分钟
node scripts/recheck-window.js 30    # 指定分钟数
```

> 这套「空结果不算数 + 周期性增量回溯」的思路来自 `okx-multiply-trader` 的踩坑记录
> （B1/B2/B3），它那边靠这套把回填窗口内的 71 笔 / 19,271 交易量救回来了。

## 奖励金额的美元折算

奖励是 **XDP** 计价的，币价会动，所以页面上**凡是 XDP 金额后面都补一个「（≈ $x）」**：

- 均分奖池每人、每 1000 USD 交易量 ≈、增速看板的现在/预计、奖池总额
- 排行榜的「预计奖励」列、批量查询的「预计奖励」列

价格来自 **OKX DEX 1 分钟 K 线的最新收盘价**（`/api/v6/dex/market/candles`，PHP 端 20 秒缓存），
失败时回退到活动 `detail` 接口的 `tradingTokens[0].price`（与官方活动页同源）。

## 数据库表

| 表 | 说明 |
| --- | --- |
| `trades` | 交易明细，`trade_id` 唯一 |
| `wallet_rank` | 钱包排行榜物化表（含买/卖量、笔数、名次） |
| `rank_meta` | 排行榜汇总 + 刷新时间 |
| `crawl_cursor` | 回溯游标与完成状态 |
| `contract_check` | 地址是否为合约（EIP-7702 委托 EOA 不算合约） |
| `okx_route` | 链上 tx 是否经 OKX 路由（可选口径） |
| `okx_launchpool_snap` | OKX 官方榜单采样（可选） |
| `wallet_cost_detail` | **真实磨损明细**：一轮一个钱包一行，由交易端上报（`run_id` + 钱包唯一） |
| `wallet_cost` | **钱包累计磨损**：页面直接读，由明细全量重算（只增不减） |

## 关键配置（.env）

| 变量 | 说明 |
| --- | --- |
| `CHAIN_INDEX` / `TOKEN_ADDRESS` | 链与代币（Base = 8453） |
| `DB_NAME` | 数据库名（默认 `okx_xdp`） |
| `CRON_REALTIME` / `CRON_BACKFILL` | 实时 / 回溯 cron |
| `MAX_PAGES_REALTIME` / `MAX_PAGES_BACKFILL` | 单轮翻页上限 |
| `BACKFILL_STOP_TIME` | 回溯下界（毫秒或 ISO，留空不限制） |
| `COLLECT_END_TIME` | 采集上界：晚于它的成交不入库 |
| `CAMPAIGN_START_UTC` / `CAMPAIGN_END_UTC` | 排行榜统计窗口（UTC，留空 = 不限制） |
| `VALID_QUOTE_SYMBOLS` | 有效币对（XDP 主要是 USDC / ETH；留空 = 全算） |
| `REQUIRE_OKX_ROUTE` | 1 = 只统计经 OKX 路由的成交（**默认 1**，与官方活动口径一致） |
| `ONLY_OFFICIAL_WALLETS` | 1 = 只统计**官方榜已报名钱包**（**默认 1**，排除没报名的做市/搬砖） |
| `OKX_ROUTERS` | OKX 路由合约地址（Base 实测：`0x67d03631fe51b741c0c00c4e16eb662ac84381df`） |
| `BLACKLIST_WALLETS` | 黑名单钱包，逗号分隔，**改动后无需重启**（默认 60s 内生效） |
| `CHAIN_RPC_URL` | 链上路径的 RPC（可逗号分隔多个，自动轮换） |
| `CHAIN_RPC_FALLBACKS` | 备用 RPC（主节点失败时轮换到这里） |
| `RPC_CONCURRENCY` / `RPC_BATCH_SIZE` | 批量查询的并发与批量大小 |
| `ROUTER_USE_OKX_API` | **0（默认）**=路由判定走公共 RPC（免费）；1=走 OKX Explorer 接口（**已收费**） |
| `OKX_402_COOLDOWN_MS` | 命中 402 付费墙后的冷却时间（默认 10 分钟） |

### 黑名单热更新

`src/blacklist.js` 启动时加载一次，之后按 `BLACKLIST_RELOAD_MS`（默认 60s）检查 `.env` 修改时间，
文件变化即自动重载，**无需重启进程**。黑名单只拦截**新写入**的交易，已入库的历史数据不会自动删除。

## 排行榜

排行榜口径（`schema.sql` / `refresh-rank.js` / `xdp.php` 三处一致）：

1. **统计窗口**：`trades.trade_time ∈ [CAMPAIGN_START_UTC, CAMPAIGN_END_UTC)`（留空 = 不限制）
2. **有效币对**：`quote_symbol IN (VALID_QUOTE_SYMBOLS)`（留空 = 全算）
3. **排除合约地址**：`wallet_is_contract = 0`（EIP-7702 委托 EOA 不算合约）
4. **去重**：`OKX Labs DEX Aggregator+` 是同一笔 swap 的重复条目，剔除
5. **OKX 路由**：只在 OKX DEX 路由上的成交才算（`REQUIRE_OKX_ROUTE=1`）

### 排行榜页面（`web/xdp.php`，单文件）

**就是 bank.php 那一套页面**，原样移植到 XDP；bank 原本依赖的同目录 `canopy-x-launch.php`
（批量查询 / 损耗测算 / 官方榜）已**内联进同一个文件**，所以仍然只有**一个文件**：
CSS / JS / PHP 全在里面，不读 `.env`、不依赖任何 css/js/json，丢到 PHP 站点目录即可。

功能（与 bank.php 一致）：

- **排行榜**：概览卡片 + **交易量增速看板** + 钱包榜（排名 / 交易量 / 买入 / 卖出 / 净买 / 笔数 / 最近成交）
  + **按地址模糊搜索**（名次仍是全局真实名次）+ 排序 / 分页 / 导出本页 CSV + 10 秒自动刷新
- **奖励测算**：每 1 交易量 ≈ 多少 XDP；榜单「预计奖励」列（前 8000 名才显示）
- **门槛测算**：第 N 名需要多少交易量（100 / 500 / 1000 / … / 8000）
- **明细弹窗**：单钱包逐笔成交 + basescan 链接
- **我的钱包批量查询**：粘贴「地址,AccountId」，看官网交易量 / 本地交易量 / 官网排名 / 本地排名 /
  预计奖励 / **损耗（估算）** / **真实磨损（实测累计）** / 明细
  - 「损耗」= 官方成交量 × 0.44% 的**估算**（0.4% OKX 服务费 + 0.04% 池子费/价差）
  - 「真实磨损」= 交易端实际上报的**账单**（买入花的 − 卖出收回的），多次交易**累加**；
    鼠标悬停看累计投入 / 回收 / 成交额 / 磨损率 / gas / 首次与最后交易时间
- 活动倒计时、明暗主题

接口：

| 接口 | 说明 |
| --- | --- |
| `?api=bundle` | 概览 + 增速看板 + 榜单（页面默认调用） |
| `?api=overview` / `?api=ranking` | 分项数据 |
| `?api=trades&wallet=…` | 单钱包交易明细 |
| `?action=combined&address=&accountId=&launchpoolId=` | 批量查询：官网榜 + 损耗 + 明细（内联自 canopy） |
| `?action=local&addresses=a,b,c` | 批量查询：本地交易量 / 本地排名 / **累计真实磨损** |
| `?action=trades&address=…` | 批量查询用的明细 |
| `?action=cost-ingest` | **磨损上报**（POST JSON，需 `X-Ingest-Token`），见下节 |

## 真实磨损上报（交易端 → 数据台）

排行榜里的「损耗」是**估算**（官方成交量 × 0.44%）。想看到**实际花了多少钱**，就靠这条链路：

```
Mac:  node bin/trade.js --fast ... --execute --yes
        ↓ 跑完自动读 reports/trade-<时间>.json
        ↓ POST  X-Ingest-Token: <token>
Server: https://boost.6117.com.cn/xdp/xdp.php?action=cost-ingest
        ↓ 校验 token → 写明细（INSERT IGNORE）→ 从明细全量重算汇总
MySQL:  wallet_cost_detail（事实）  →  wallet_cost（页面读）
        ↓
页面:  「我的钱包批量查询」→「真实磨损」列（累计，只增不减）
```

### 为什么不用直连 MySQL

交易跑在本地 Mac，数据台在服务器上。把 3306 暴露到公网风险太大；
服务器上已经有 PHP，让它代写最省事，而且能顺便做鉴权和幂等。

### 幂等（重要）

服务端唯一键是 `(run_id, wallet_address)`，`run_id` 对同一份报告**稳定**：

1. 新交易端写进报告 `meta.runId`（形如 `trade-20260928174559-a1b2c3`）
2. 旧报告没有 `runId`，就用文件名 `trade-<时间戳>` 兜底

所以同一份报告推多少次，磨损都不会翻倍（实测：重复推送 `inserted=0`）。
汇总表也**不是累加**的，而是每次从明细 `SUM ... GROUP BY` 重算 —— 明细是事实，汇总永远等于事实。

### 配置

两边必须一致：

| 位置 | 变量 |
| --- | --- |
| `xdp/web/xdp.php` 配置区 | `const COST_INGEST_TOKEN = '…';` |
| 交易端 `.env` | `COST_INGEST_URL=https://boost.6117.com.cn/xdp/xdp.php` 和 `COST_INGEST_TOKEN=…` |

`COST_INGEST_TOKEN` 留空 / 保持 `CHANGE_ME` 开头时，写入接口直接返回 **500**，不会裸奔。
上报失败**不影响交易**，只在结尾提示，并给出补推命令。

### 命令

```bash
# 交易跑完自动上报（配好上面两个变量即可，想临时关掉用 --no-push）

# 手动补推：最新一份 / 指定文件 / 全部历史报告
node bin/trade.js --push-cost
node bin/trade.js --push-cost reports/trade-20260928174559.json
node bin/trade.js --push-cost all
```

### 费率口径（2026-09-29 修正）

`xdp.php` 里原本 `DEX_PLATFORM_FEE = 0.2%`，实测是 **0.4%**，已改：

| 证据 | 内容 |
| --- | --- |
| 链上日志 | 买/卖每腿都有 0.4% 的 USDC 打给 OKX 的服务费收款地址 |
| 对照实验 | XDP/USDC 池子是 Uniswap V3 `fee tier 0.01%`；同时取数，OKX 报价恰好比直连差 **40 bps**，且 `OKX = 直连报价 × 0.996`（先扣 0.4% 再原样丢进同一个池子） |
| 其他币对 | WETH / AERO / cbBTC 走 OKX **反而好 17 bps**（有路由优化，没抽成）—— 说明这 0.4% 是 XDP 专属 |
| 官方文档 | <https://web3.okx.com/zh-hans/dex-fees> 写明 DEX 服务费 0.4% |
| 实测校验 | 80.000000 投入 → 0.705157 磨损 / 159.294843 成交额 = **0.4427%**，与 0.44% 吻合 |

所以现在是 `DEX_PLATFORM_FEE = 0.004` + `DEX_SLIPPAGE = 0.0004` = **0.44%**。
注意：**磨损跟单笔金额无关**（0.5 → 3000 USDC 实测都是恒定比例），只有 gas 会随金额摊薄。

## 官方榜对账（`npm run reconcile`）

`scripts/reconcile-official.js` 会拉 OKX 官方 leaderboard，把每个官方钱包的交易量和本地
（同窗口 / 同币对 / 同路由口径）逐条比对，用来验证口径对不对、有没有漏单。

实测结果（2026-09-28，采集窗口内）：

```
官方 12 名合计 $47302.32
  本地全部 DEX : $46786.53 (98.9%)  命中钱包 12/12
  本地仅 OKX   : $46674.85 (98.7%)  命中钱包 12/12

rank  official      local(OKX)    笔数  吻合度   wallet
   1     10464.85     10463.64     39    100%   0xce99d5ef…f2a5f0
   2      9735.92      9735.60     36    100%   0xcbbf7a18…f82de4
   5      5241.52      5240.23      7    100%   0x461f756b…6f6bf
   8      1052.19      1052.18     24    100%   0xcd8723ca…535b4e
```

结论：

1. **官方参与者 100% 走 OKX 路由**（对官方钱包的 253 笔 tx 统计：248 笔打到 OKX 路由，
   其余是 ERC-4337 EntryPoint 等智能钱包外层调用）——所以路由口径是必须的。
2. 本地总量会**高于**官方 `totalBoostVolume`：官方只统计**已报名**钱包，
   而公开数据无法知道谁报了名，因此榜单里会混入「同样走 OKX 路由但没报名」的做市/搬砖地址。
   这与 `bank/` 的取舍一致（bank 对账 93/100，差异来自 OKX 内部反刷量）。
3. 未命中/偏差主要来自：采集时段内接口限流漏单（重新回溯一次即可补齐）、
   智能钱包（4337）外层调用导致路由判定为「非 OKX」、以及 OKX 内部的反刷量扣减。

## 与 bank 的差异（Base/XDP 适配）

- 链/代币/浏览器换成 Base 与 XDP；原生币 ETH。
- 新增 `quote_symbol` 普通列（从 `changedTokenInfo` 解析），用 `IN (...)` 过滤币对，
  不再依赖 JSON 文本 `LIKE` 的生成列，币对清单可以直接改 `.env`。
- `REQUIRE_OKX_ROUTE` 默认 **开启**（已用官方榜验证口径）；Base 上的 OKX 路由实测为
  `0x67d03631fe51b741c0c00c4e16eb662ac84381df`（`methodId = 0x0c307f76` dagSwapTo）。
- 时间一律显式写 **UTC 字符串**，并固定 MySQL 会话时区 `+00:00`，避免 +08 机器上整体偏移 8 小时。
- 合约扫描改为 **JSON-RPC 批量 + 429 退避**（主网公共 RPC 单发会被限流、单批上限 10 个）。
- 修复了 `blacklist.js` 里 `\s` 跨行匹配导致把下一行配置当黑名单地址的隐患。
- `.env` 用 `override: true`，避免被部署机上的其它项目环境变量覆盖。

## 成交 WebSocket（免费实时，现在是成交主力）

REST `/api/v6/dex/market/trades` 每月只有 100K 免费额度，超额 $0.0001/次。
而 OKX **网页端自己用的 WebSocket 通道**是免费、公开、实时推送的：

    URL   wss://wsdexpri.okx.com/ws/v5/ipublic          （公开，不需要 API Key / 登录）
    频道  dex-market-trade-history-pub
    订阅  {"op":"subscribe","args":[{"channel":"dex-market-trade-history-pub",
                                     "chainId":"8453","tokenAddress":"0x07b3…"}]}
    心跳  ping|<nonce>|<timestamp>   ← ⚠️ 裸字符串，不是 JSON！

> 心跳这个坑很深：协议常量里写的是 `PING:"ping"`，但写成 `{"op":"ping"}`、`"ping"`
> 都会返回 `Illegal request` code 60012。**必须是裸字符串**，三段用 `|` 分隔。
> 返回 `pong|<nonce>`（回显 nonce，可以顺便算往返延迟）。

### 实测数据（2026-09-29）

| 项 | 结果 |
| --- | --- |
| 需要 API Key | ❌ 不需要 |
| 推送速率 | 325 ~ 392 笔/分钟 |
| 与 REST 完整性 | **最近 100 笔 / 86 个唯一 tx，100% 重叠、0 遗漏** |
| 长连接 | 90s+ 稳定 |
| 方向字段 | `isBuy=1` ↔ REST `type=buy`，用**链上 XDP 流向做裁判 96/96 全对** |
| 报文结构 | 与 REST 完全一致（`changedTokenInfo`/`volume`/`price`/`dexName`/`userAddress`） |

字段映射：`timestamp`→`time`、`isBuy '1'/'0'`→`type 'buy'/'sell'`，
另外 WS **白送 `txHash`**（REST 得从 `txHashUrl` 里切）。

### 三层数据源分工

| 来源 | 角色 | 说明 |
| --- | --- | --- |
| `ws` | **实时主力** | 免费、推送、不会翻页落后 |
| `onchain` | **独立兜底** | 不依赖 OKX 任何服务，还覆盖第三方代付的捆绑交易 |
| `okx` | 对账 / 回补 | 口径最准，但花额度；`REST_REALTIME_ENABLED=0` 时完全停用 |

### ⚠️ 跨源去重（最容易翻倍的地方）

三条源对**同一笔交易**生成的 `trade_id` 格式完全不同：

    okx     : 1790644953000!@#1509!@#77976518507
    ws      : 1790644791000!@#854
    onchain : oc:0x4d741…:0x866a…:buy

所以**绝对不能拿 `trade_id` 做跨源去重**，必须认 `(tx_hash, wallet_address, type)`
（`trades` 表已有 `idx_tx_wallet_type` 索引）。优先级 **okx > ws > onchain**：

- `okx` 到达时，把同键的 `ws`/`onchain` 行删掉再插（官方口径为准）
- `ws`/`onchain` 见到库里已有同键就跳过（只补不覆盖）

> 注意判断的是**库里**有没有，不是本批里有没有 —— 一个 tx 里可能有两笔同向成交，
> 它们 `(tx,wallet,type)` 相同，但必须都入库。

## ⚠️ OKX 接口 402 付费墙（2026-09-29）

### 现象

    [OKX] 实时请求失败: Request failed with status code 402
    [实时] 2026-09-28T18:15:28.805Z 拉取 0 条，新增 0 条      ← 每 2 秒刷一屏

### 原因（不是限流！）

OKX 把 DEX / Explorer 接口切到了 **x402 付费协议**：

- 每个 API-Key **每月 100K 次免费**（Basic 等级），超出后 **$0.0001/次**
- 只支持 **X Layer（eip155:196）** 上的 USDG / USDT 支付，每次调用签一次 EIP-3009
- 文档：<https://web3.okx.com/zh-hans/onchainos/dev-docs/market/market-api-fee>

**402 响应体里就是支付要求**（注意响应头 `x-ratelimit-remaining-minute: 309/310` —— 额度还剩 99.7%，所以别当成限流去重试）：

```json
{ "x402Version": 2,
  "accepts": [{ "scheme":"exact", "network":"eip155:196", "amount":"100",
                "payTo":"0x0dedc3c5e15bee45166924ea5b02f54a35b1f9c6",
                "asset":"0x4ae46a509f6d…", "extra":{"symbol":"USDG"} }] }
```

为什么额度会用光：`CRON_REALTIME=*/2 * * * * *` 每 2 秒一次 = **43,200 次/天**，
100K 免费额度 **2.3 天**就烧完了。

### 我们怎么绕开的

关键发现：**campaign 真正算的交易，链上直采本来就能全覆盖。**

实测 `okx_route` 表里 `is_okx=1` 的**只有 `0x67d03631…` 一个路由**
（两个方法 `0xf2c42696` 4456 笔 / `0x0c307f76` 2829 笔），
官方钱包 2,520 笔成交里 **2,457 笔（97.5%）** 都在这个路由上。
而 `src/onchain.js`（区块订阅 + 直采）盯的**正好就是它** —— 完全免费。

之前日志里 `onchain` 只入库 81 笔，不是漏采，而是 `ingestOnchain` 发现
「接口已经写过这条」就跳过；接口每次都抢了先。接口停掉后它自然会补上
（时间线可见：okx 最后 18:13:57 → onchain 接到 18:15:59）。

改动：

| 文件 | 改动 |
| --- | --- |
| `src/rpc.js`（新增） | 共享 JSON-RPC：批量 + **完整性校验** + 单条兜底 + 节点轮换 |
| `src/router.js` | 路由判定从 OKX Explorer 接口改成 **`eth_getTransactionByHash`（免费）** |
| `scripts/scan-routers.js` | `ROUTER_USE_OKX_API=0`；批量改用 `rpcBatch`（原来的 `batchGetTx` 会把 20 条批量静默吞成 1 条） |
| `src/onchain.js` | 方法 ID 用配置的 `OKX_METHOD_IDS`，不再写死 `0x0c307f76` |
| `src/okx.js` | **402 熔断**：识别付费墙，详细提示一次，之后 10 分钟不再尝试 |
| `src/realtime.js` | 修「追平判断」bug（见下）；翻满上限时打告警 |
| `src/onchain.js` | **WSS 断线补洞**（见下）；改用共享 RPC（多节点轮换）；回执批量化；**WSS 回退到 `ws` 包** |
| `package.json` | 加了 `ws` 依赖（Node < 22 没有全局 WebSocket） |
| `.env` | `CRON_REALTIME` 2s → 60s；`MAX_PAGES_REALTIME` 2 → 20；`ROUTER_USE_OKX_API=1` → 0 |

### ⚠️ 链上监听的 WSS 依赖 Node 版本

`src/onchain.js` 原来直接用**全局 `WebSocket`**，而它 **Node 22+ 才有**：

    Node 22+  → WebSocket 存在        → WSS 正常
    Node 18/20 → WebSocket 是 undefined → new WebSocket() 抛错 → 被 catch 吞掉
                                      → 静默退化成 HTTP 轮询

表现就是日志里只有一句 `[链上] WSS 不可用，改用 HTTP 轮询`，**看不出为什么**。
现在改成：**优先全局 WebSocket，没有就退回 `ws` 包**；并且把失败原因完整打出来
（订阅超时会提示「该节点不提供 WS，或服务器出站被防火墙拦了」）。

先在服务器上确认版本：

    node -v && node -e "console.log('global WebSocket:', typeof WebSocket)"

**Node < 22 就必须 `cd xdp && npm install`**（`ws` 已在 dependencies 里）。
订阅成功时日志会带实现来源：`（Node 内置 WebSocket）` 或 `（ws 包）`。

> HTTP 轮询本身**不会丢数据**（`httpLoop` 会补 `lastHeight+1..latest` 的整段），
> 只是延迟略高、RPC 调用更多。但能走 WSS 就走 WSS —— 更省、更实时。

### 顺带修掉的三个 bug

**① `realtime.js` 的「追平就停」失效（会让接口费成倍上涨）**

    if (totalNew === 0) break; // 这一页全是旧数据，已追上   ← 判断的是累计值

累计值一旦 >0 就永不归零 → **每轮都翻满 MAX_PAGES 页**，追平了也不停。
本该是「本页新增为 0」。改成 `if (pageNew === 0)` 后，MAX_PAGES 才真正成为
**上限而不是固定开销** —— 追平后每轮只 1~2 页就退出。

各速率下需要几页（LIMIT=100，60s 一轮）：

| XDP 全市场速率 | 需要页数/轮 | 旧配置(2页) | 新配置(20页上限) |
| --- | --- | --- | --- |
| 低峰 20 笔/分 | 2 | ✅ | ✅ |
| 平均 270 笔/分 | 4 | ❌ 追不上 | ✅ |
| 峰值 440 笔/分 | 6 | ❌ 追不上 | ✅ |

> 注意：真正要算的 `is_okx=1` 只有 **21 笔/分钟**，而接口返回的是**全市场**
> （过滤在本地做）—— 继续用接口等于花 20 倍的钱下载要丢掉的数据。

**② `onchain.js` WSS 断线不补洞（会永久丢数据）**

`wssLoop` 重连后只处理新块：

    if (num > lastHeight) { lastHeight = num; enqueue(num); }   ← 中间漏掉的块没人管

`httpLoop` 早就在补（`for n = lastHeight+1..latest`），只有 WSS 路径漏。
接口还活着时能靠它兜底，**接口停了就是真丢**。现在两条路径语义一致，并且
单次补洞上限 `WATCHER_GAP_FILL_MAX`（默认 300 块），超出会提示用 `scan-onchain.js` 补。

**③ `onchain.js` 单节点直连（70% 失败率）**

回扫 5 分钟区间实测：**命中 56 笔 → 39 次失败**。原因是用单个
`mainnet.base.org` 且并发 8 取回执，被限流。改用 `src/rpc.js` 的多节点轮换 +
批量取回执后：**命中 89 笔 → 失败 0**。

> **为什么批量要校验完整性**：Base 公共节点对 JSON-RPC batch 的支持差异极大 ——
> 实测 `mainnet.base.org` 发 20 条只回 1 条、`drpc` 免费版直接 500 拒绝 >3 条。
> 不校验的话会「返回空数组但看不出错」，造成整批静默漏判。

### 如果你想继续用 OKX 接口（可选）

1. 往 **X Layer** 钱包充值 USDG 或 USDT
  （USDG `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8`，USDT `0x779ded0c9e1022225f8e0630b35a9b54be713736`）
2. 装官方 SDK：`npm i @okxweb3/x402-axios @okxweb3/x402-evm @okxweb3/x402-core viem`
3. 用 `wrapAxiosWithPaymentFromConfig` 包一层 axios（x402 v2 头名是 `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`）
4. 成本参考：按 `MAX_PAGES_REALTIME` 页/次、60s 一次算，约 **1,440 次/天 ≈ $0.14/天**

**但注意**：接口返回的是**全部** XDP 成交，而 campaign 只算官方钱包里 `is_okx=1` 的那一小部分。
也就是说绝大部分调用费花在了我们本地要过滤掉的数据上 —— 除非要做全市场分析，否则不值得。

## 常见问题

| 现象 | 原因 / 解决 |
| --- | --- |
| **`-bash: ./start.sh: Permission denied`** | 脚本没有**可执行位**（从 Windows / 压缩包 / 部分同步工具拷到服务器会丢）。执行 `chmod +x start.sh stop.sh status.sh`；或不用脚本，直接 `npm start`；或 `bash start.sh` |
| `-bash: ./start.sh: /usr/bin/env: bad interpreter` | 文件被转成了 CRLF 换行。`sed -i 's/\r$//' start.sh`，或直接用 `npm start` |
| 启动即退、日志里有 EADDRINUSE / 端口占用 | 已有采集进程在跑，先 `./stop.sh`（或 `pgrep -fl "node src/index.js"` 手动 kill） |
| 改了代码但行为没变 | 采集进程内存里还是旧模块，**必须重启**：`./stop.sh && ./start.sh`（本仓库已踩过两次） |
| 页面时间差 8 小时 | MySQL 会话时区没设。本项目已在连接池和 `xdp.php` 里固定 `+00:00`，若自建库请照抄 |
| 看不到启动日志 | `./start.sh` 是后台启动，日志在 `logs/index.log`：`tail -f logs/index.log`（或 `npm run logs`） |

## 维护提示

- `.env` 含 OKX API 密钥与数据库密码，已被 `.gitignore` 忽略，切勿提交或外发。
- `web/xdp.php` 顶部同样含数据库明文密码，部署时注意目录权限与访问控制。
- 若密钥曾以明文出现在聊天记录、日志或截图中，建议尽快到 OKX 与数据库处轮换。
- 换代币/换链：改 `.env` 的 `CHAIN_INDEX` / `TOKEN_ADDRESS` / `VALID_QUOTE_SYMBOLS` / `CHAIN_RPC_URL`，
  清掉对应库的数据后重启采集；`xdp.php` 顶部配置区同步修改。
