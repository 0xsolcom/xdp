# okx-trade

OKX Web3（web3.okx.com）纯 Node 批量交易脚本，**不用开浏览器、不用点鼠标**：

- **交易 / 刷量**：DEX 批量交易 —— 每个钱包「**一买一卖**」（USDT → XDP → USDT）才算完成，含原子来回、自动授权、扫残留、批量报告。

> 报名相关的代码已从本仓库移除（改用手动报名）。

只需抓**一次**浏览器 HAR 拿到长期会话，之后整条链路自己走完。

> ⚠️ **涉及真钱**。先用极小金额干跑，再小额真跑，确认报告和链上都对得上再放量。
> 建议用**专门的交易钱包**，不要用主钱包。

---

## 目录

1. 功能总览
2. 环境要求
3. 安装
4. 目录结构
5. 会话：抓一次 HAR
6. 交易工具（bin/trade.js）
7. 配置（.env）总表
8. 工作原理
9. 报告说明
10. 安全注意
11. 常见问题
12. 文件说明

---

## 1. 功能总览

### 交易（trade.js）

| 能力 | 说明 |
|---|---|
| 一买一卖 | 每个钱包买完（USDT→XDP）必须卖回（XDP→USDT）才算完成 |
| 原子来回 | --fast：买卖两份 calldata 备好，nonce=N / N+1 背靠背广播，敞口压到约 1 个区块 |
| 自动授权 | 交易时按报价里的真实 spender 检查链上额度，不足先补授权并等确认，再交易 |
| 链上模拟 | 广播前先 eth_call 模拟，过不了就不发 |
| 报价闸门 | 滑点 / 价差超限就重新报价，避开坏价 |
| 买腿重试 | revert 不建仓，重新报价再试 |
| 卖腿补卖 | 买了就必须卖出去，滑点逐级放宽，绝不留下裸仓位 |
| 扫残留 | 把钱包里残余的交易币全部卖回，清零 |
| 只授权 / 只清残留 | --approve-only / --sweep-only 独立模式 |
| 多钱包 | 逐钱包串行、失败隔离、前置闸门跳过没 gas / 没币的 |
| 批量报告 | CSV + JSON + 单文件 HTML（投入 / 回收 / 磨损 / 成本 bps / gas / 残留） |

---

## 2. 环境要求

| 需要 | 说明 |
|---|---|
| Node.js >= 18 | 脚本用了全局 fetch；建议 20 / 22 LTS |
| npm | 装依赖 |
| 一个或多个 Base 钱包 | 里面有 USDT 和一点 ETH（gas）|
| Chrome + 已登录 web3.okx.com | 只为导出一次 HAR（拿会话），导完就不需要了 |

依赖只有一个：ethers（见 package.json）。

---

## 3. 安装

    cd okx-register
    npm install

配置：

    cp .env.example .env        # 然后按需修改
    printf '0x第一把私钥\n0x第二把私钥\n' > key.env   # 每行一个私钥

.env、key.env、creds/、reports/ 都已在 .gitignore 里，不会入库。

---

## 4. 目录结构

    okx-trade
    ├── bin/
    │   └── trade.js             交易 CLI（一买一卖，入口）
    ├── src/
    │   ├── session.js           从 HAR 抽 web3.okx.com 会话
    │   ├── sign.js              Ok-Verify-* 请求签名（现场重算）
    │   ├── client.js            带签名 + 重试 + 请求头随机化的客户端
    │   ├── wallets.js           私钥文件解析 + 钱包选择
    │   ├── solana.js            Solana 私钥解析（wallets.js 依赖；本工具不用）
    │   ├── chains.js            各链基础信息（原生币 / 浏览器 / RPC 池）
    │   ├── dex.js               DEX 底层：报价 / 签名 / 广播 / 回执 / 链上读取
    │   ├── swap.js              一买一卖原语：准备 / 广播 / 等回执 / 原子来回 / 授权 / 扫残留
    │   └── trade-report.js      交易报告：CSV + JSON + 单文件 HTML
    ├── creds/                   会话文件（不入库）
    ├── reports/                 报告输出（不入库）
    ├── key.env                  私钥（不入库）
    ├── .env / .env.example      配置
    └── package.json

---

## 5. 会话：抓一次 HAR

脚本要的接口凭据（设备号 devid / 设备指纹令牌 x-fptoken / UA 等）只存在于浏览器里，所以抓**一次**存下来即可：

1. Chrome 打开 OKX Web3 钱包页面（已登录）。
2. F12 → Network → 随便刷新页面或做一次查询。
3. 右键任意请求 → Save all as HAR with content → 存成 web3.har。
4. 放到**当前目录、项目根目录或 ~/Downloads**，然后跑 `node bin/trade.js` 时会**自动发现并抽取**。

会话保存在 creds/web3-session.json（已存在就直接复用；想换就删掉它再放一个新 HAR）。

> x-fptoken 等价于「这台设备已登录的凭据」——**泄露 = 别人能拿你的会话调接口**，绝不外传、不提交。

---

## 6. 交易工具（bin/trade.js）

### 核心流程

每个钱包独立执行（默认严格串行，`--concurrency N` 可并发）；一个失败不影响后面的：

    [1/N] 地址
      ① 买  QUOTE(USDT) → TRADE(XDP)
           报价闸门 → calldata 校验(收款人/输出币/deadline) → 余额检查
           → 授权检查(真实 spender，不足自动补 approve) → eth_call 链上模拟
           → gas 估算(estimateGas x 1.2) → 签名 → 广播 → 等回执
      ② 卖  TRADE → QUOTE
           按链上真实到账全部卖回；失败按滑点阶梯逐级放宽补卖
      ③ 扫  残留 TRADE 清零（最多 2 轮并复核，可 --no-sweep 关）
      只有 ①+② 都成功才算「完成」

--fast 时：先备好买卖两份 calldata，nonce=N / N+1 **背靠背广播**，敞口从「等买单确认的 6~10 秒」压到「约 1 个区块」；卖单数量用买单的 minReturn（合约保证实际到账 >= 它，卖单必定能成交），差额由扫残留补掉。

### 快速开始

推荐的 Base 跑法（授权单独跑一次，交易时不用再等授权）：

    # 1) 先一次性授权（幂等：已经是无限额度的钱包直接跳过，不发交易）
    node bin/trade.js --approve-only --execute --yes

    # 2) 再交易（即使授权单独跑过，交易前仍会复查；真缺了会先补授权再交易）
    node bin/trade.js --fast --amount 10 --concurrency 8 --sleep auto --execute --yes

    # 3) 清残留
    node bin/trade.js --sweep-only --execute --yes

其它常用：

    node bin/trade.js                                  # 干跑：只报价
    node bin/trade.js --fast --loop 3 --execute --yes  # 原子来回 x3
    node bin/trade.js --approve-only --wallets 31-100 --execute --yes   # 只授权指定钱包

对应 npm 脚本：trade / trade:execute / trade:fast[:exec] / trade:approve[:exec] / trade:sweep[:exec] / trade:report。

### 多钱包并发（快速）

默认严格串行；加 `--concurrency N` 后同时跑 N 个钱包（上限 8）：

    node bin/trade.js --concurrency 5 --sleep auto --fast --execute --yes

- **并发单位是钱包**：不同地址 nonce 天然独立，互不冲突；一个失败不影响其他。
- **请求速率是全局的**，不随并发数放大：所有走 OKX 接口的请求都过一道进程级闸门
  （`--api-gate`，默认 350ms 一次）。加并发提升的是「同时在等回执」的位数，不是请求速率 ——
  这是躲 429 / 风控的关键。
- **启动间隔**：`--sleep` 在并发时表示两次「启动」之间至少隔多少秒；填 `auto` 会按
  历史单钱包耗时 ÷ 并发数自动推算，把并发位跑满而不是白等。
- **日志**每行带 `[n/N #序号]` 前缀，交错也分得清归属。
- 结束打印墙钟、钱包耗时合计与平均并发占用；没跑满会提示瓶颈是 `--sleep` 还是闸门。

建议先用 `--concurrency 2 --sleep auto` 试一批，确认没有限流再往上加。
`--concurrency 1` 时行为与旧版完全一致（每个钱包结束后等 `--interval`，不启用闸门）。

### 断点续跑

每个钱包的结果按**地址**记进 `creds/trade-state.json`（原子写），重跑自动跳过上次
「真跑且成功」的；干跑的成功**不算数**（行情会变），不会被跳过。

    node bin/trade.js --status                     # 看进度（不需要私钥）
    node bin/trade.js --execute --yes              # 接着跑，成功的自动跳过
    node bin/trade.js --retry-ok --execute --yes   # 连上次成功的也重跑
    node bin/trade.js --no-resume --execute --yes  # 完全不用进度文件
    node bin/trade.js --reset                      # 清空进度

### 参数总表

**交易对象**

| 参数 | 默认 | 说明 |
|---|---|---|
| --quote TOKEN | USDT | 计价币（钱） |
| --trade TOKEN | XDP | 交易币（来回买卖） |
| --amount N | 1 | 每钱包每轮投入多少计价币；all = 全余额 |

**模式**

| 参数 | 说明 |
|---|---|
| --fast | 原子来回：买/卖 calldata 备好，nonce N / N+1 背靠背广播 |
| --loop n | 同一钱包来回 n 轮（默认 1） |
| --approve-only | 只做一次性无限授权 |
| --sweep-only | 只清残留 |
| --token LIST | --approve-only 的币，逗号分隔（默认 quote,trade） |

**钱包**

| 参数 | 说明 |
|---|---|
| --keys FILE | 私钥文件（默认 当前目录/key.env） |
| --wallets 31-100 | 只交易这些钱包：**序号区间 31-100** / 单个 7 / 地址 0xa,0xb（地址没有私钥，只能查状态） |
| --from / --to | 第几把到第几把（1 起含两端；--to 0 = 到最后） |
| --limit n | 最多处理 n 把 |

**并发 / 断点续跑**

| 参数 | 默认 | 说明 |
|---|---|---|
| --concurrency n | 1 | 同时跑几个钱包（1 = 严格串行；上限 8） |
| --sleep 秒\|auto | 跟随 --interval | 并发时两次「启动」的间隔；auto = 按历史耗时 ÷ 并发数算 |
| --api-gate ms | 350 | 全局接口闸门：整进程发往 OKX 的请求间隔下限（仅并发时生效） |
| --status | 关 | 只看进度，不交易（不需要私钥） |
| --reset | 关 | 清空进度文件后退出 |
| --retry-ok | 关 | 连上次成功的也重跑 |
| --no-resume | 关 | 不用进度文件，全部重跑 |
| --state FILE | creds/trade-state.json | 进度文件路径 |

**行为 / 闸门**

| 参数 | 默认 | 说明 |
|---|---|---|
| --slippage R | 自动 | 买腿固定滑点（0.01 = 1%）；同时作为卖腿阶梯起点 |
| --slippage-exit R | 跟随 --slippage | 卖腿滑点阶梯起点 |
| --max-slippage R | 0.03 | 报价滑点闸门：超过就重新报价；0 = 不限制 |
| --max-value-diff R | 0.003 | 报价价差闸门（abs(diffPercent)） |
| --slippage-retries n | 3 | 闸门连续超限前的重新报价次数 |
| --api-retries n | 3 | 接口瞬时错误（100010/10104/超时）重试次数 |
| --buy-retries n | 3 | 买腿失败重试次数 |
| --sell-retries n | 3 | 卖腿补卖次数 |
| --no-approve | 关 | 授权不足也不补授权（直接失败） |
| --min-gas N | 0.0002 | 前置闸门：原生币（Base=ETH）低于此值就跳过钱包（不算失败） |
| --no-precheck | 关 | 关掉前置闸门 |
| --no-sweep | 关 | 不做残留清扫 |
| --sweep-min n | 0 | 残留低于此数量（交易币单位）就不扫；0 = 全扫 |

**网络 / 执行**

| 参数 | 默认 | 说明 |
|---|---|---|
| --rpc URL | 该链内置池 | 可逗号分隔多个，启动时测速选最快 |
| --broadcast-rpc URL | 同 rpc | 广播兜底；**优先用报价里的 BlockRazor 私有中继** |
| --interval SEC | 1.2 | 两个钱包 / 两轮开始之间的最小间隔 |
| --chain ID | 56 | 链 id |
| --account-id UUID | 随机 | 报价用 accountId |
| --refcode CODE | 11OKB | referralCode |
| --execute / --yes | 关 | 真签真发 + 二次确认 |
| --no-report | 关 | 不写报告 |
| --report-dir DIR | reports | 报告目录 |
| --session FILE | creds/web3-session.json | 会话文件 |

### 报价闸门与滑点

- **闸门只作用于进场（买腿）**：滑点 > --max-slippage 或价差超限 → 不发这笔，重新报价；连续超限跳过该钱包。手动 --slippage 时不判滑点闸门。
- **出场腿（卖 / 扫残留）不做闸门**：币已经在手里，卖出去比拿到好价格重要。
- **滑点是「失败线」不是成交价**：minReceive = 预计到账 x (1 - 滑点)，实际少于它就 revert。设小只是更容易 revert，不会让你卖得更贵。
- **卖腿滑点阶梯**：先按你设的紧滑点，失败才逐级放宽（你的值 → 0.5% → 2% → 接口自动），兜底一定卖出去。

### 授权

- 授权额度固定 MaxUint256（无限），**每个币只做一次**；已经是无限就跳过。
- spender 以报价返回的 approveTxInfo.dexContractAddress 为准（平台 11 = 0x2c34A2Fb...）。
- 判断是否已授权用**链上 allowance**（用阈值，不跟 MaxUint256 比等号），比接口查询权威。
- 交易时发现不足会**自动补一笔，并等确认后再发 swap**（--no-approve 可关掉）。
- `--approve-only` 里同一把钱包的多个代币是**背靠背广播**的（nonce N / N+1），
  最后一起等回执 —— Base 出块 ~2s，一笔一笔「发完等确认」会把等待时间线性叠加。
- 回执超时不等于失败：会回查链上 allowance，真的授权上了就当成功（Base 拥堵时回执常晚到）。
- 报价里的 `approveTxInfo.nonce` **不用**，一律取链上 pending nonce（报价里的可能已过期）。

### 残留清理

残留就是裸敞口。三层兜底：

1. 一买一卖后立刻扫（读链上真实余额，全部卖回）；
2. 扫完复核，没清零再扫一轮（最多 2 轮）；
3. 随时可跑 --sweep-only 单独清。

残留小到不值当 gas 时（--sweep-min）可放过；要绝对清零就 --sweep-min 0。

### gas 与 RPC

- gasLimit = max(接口值, eth_estimateGas x 1.2)，下限 300000。⚠️ 接口给的 gas **会偏低**，直接用会 OutOfGas 空 revert。
- 原子来回的卖单此时手里还没币，estimateGas 必失败，用「接口值 x 1.5」兜底。
- 启动时对 RPC 池做**两项**探测：延迟（eth_blockNumber）+ **回执能力**（eth_getTransactionReceipt
  一个不存在的 hash，正常节点返回 null）。
- 只测延迟会被坑：`base-rpc.publicnode.com` 最快（~200ms），但 `eth_getTransactionReceipt`
  直接报 `Archive requests require a personal token` —— 选它当主节点，每笔授权都要空等一整个
  回执预算（默认 60s）才超时。现在这类节点会被**自动排除**并打印原因。
- 主节点某个方法报错时，`rpc()` 会**自动轮换**到池里其它可用节点（`RECEIPT_TRIES` 轮里每轮换一个）。
- Base 出块 ~2s，回执轮询按 2s 一轮（默认 30 轮 = 60s），比原来的 3s 一轮少白等约 1s/次。
- 可调：`RPC_TIMEOUT_MS`（默认 20000）/ `RPC_RETRIES`（默认 3）/
  `RECEIPT_TRIES`（默认 30）/ `RECEIPT_INTERVAL_MS`（默认 2000）。

---

## 7. 配置（.env）总表

优先级：**命令行参数 > 真实环境变量 > .env（当前目录优先，其次项目根）> 内置默认值**。

    # 交易对象
    QUOTE_TOKEN=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2   # 计价币 USDT（Base）
    TRADE_TOKEN=0x07b3d902783c3c12b077508c3b5c00113d1291d0   # 交易币 XDP（Base）
    AMOUNT=1
    LOOP=1
    FAST=false

    # 行为 / 闸门
    CHAIN_ID=56
    SLIPPAGE=                    # 买腿固定滑点；空 = 接口自动
    SLIPPAGE_EXIT=               # 卖腿阶梯起点；空 = 跟随 SLIPPAGE
    MAX_SLIPPAGE=0.03
    MAX_VALUE_DIFF=0.003
    GATE_RETRIES=3
    API_TRIES=3
    BUY_RETRIES=3
    SELL_RETRIES=3
    NO_APPROVE=false
    NO_SWEEP=false
    SWEEP_MIN_TOKEN=0
    MIN_GAS_BNB=0.0002
    NO_PRECHECK=false

    # 模式开关
    APPROVE_ONLY=false
    SWEEP_ONLY=false
    APPROVE_TOKEN=

    # 钱包
    KEYS_FILE=key.env
    WALLETS=
    FROM_INDEX=1
    TO_INDEX=0
    LIMIT=0

    # 网络
    RPC_URL=                       # 可逗号分隔多个；启动时测延迟 + 回执能力后排序
    BROADCAST_RPC_URL=             # 广播兜底
    RECEIPT_TRIES=30               # 回执轮询次数（30 x 2s = 60s）
    RECEIPT_INTERVAL_MS=2000       # 回执轮询间隔（Base 出块 ~2s）
    RPC_TIMEOUT_MS=20000
    RPC_RETRIES=3

    # 其他
    ACCOUNT_ID=
    COMPETITION_REFERRAL=11OKB
    INTERVAL=1.2
    REPORT_DIR=reports
    SESSION_FILE=

    # 执行开关
    EXECUTE=false
    YES=false
    NO_REPORT=false


布尔开关只认 1 / true / yes / on 为开。

---

## 8. 工作原理

### 请求签名（src/sign.js）

web3.okx.com 私有接口要三个头，每次请求现场重算：

    Ok-Verify-Token = 随机 UUID v4
    Ok-Timestamp    = Date.now()（毫秒）
    Ok-Verify-Sign  = base64( HMAC-SHA256(key, msg) )
      key: m = sha256hex(token)
           p = floor(Ok-Timestamp / 1000)
           g = floor(p / 600  % 32)
           S = floor(p / 3600 % 32)
           key = concat( m[(g + (S+E)*E) % 32] for E in 0..31 )
      msg: POST → pathname + body；GET → (pathname + search) 去掉第一个 ?

时间只影响 key 的取字符位置，所以签名与时间戳是一对，换时间戳必须重签。

### 交易链路（src/dex.js + src/swap.js）

    ① 报价   POST /priapi/v6/dx/trade/multi/marketQuoteAndCalldata
    ② 校验   calldata 是 dagSwapTo(0x0c307f76)：orderId / 收款人 / 输入输出币 / minReturn / deadline
    ③ 模拟   eth_call
    ④ 签名   本地私钥签 EIP-1559（type 2），私钥不出本机
    ⑤ 广播   优先发到报价里的 BlockRazor 私有中继，失败退回 --broadcast-rpc / 普通 RPC
    ⑥ 回报   POST /priapi/v6/dx/trade/multi/broadcast（OKX 侧记账，失败不影响链上）
    ⑦ 等回执 eth_getTransactionReceipt；成败只看 receipt.status
    ⑧ 记账   从回执 Transfer 日志读链上真实进出，gas = gasUsed x effectiveGasPrice

> OKX 的 broadcast 接口只是它那边的记账/知会：它的 code=0 只代表「收下了」，
> **不代表交易成功**；链上成败只看 RPC 的 receipt.status。

---

## 9. 报告说明

每次跑完（交易）都会写报告。

**交易**（src/trade-report.js）：

    reports/trade-<时间戳>.csv    表格，丢 Excel
    reports/trade-<时间戳>.json   原始数据
    reports/trade-<时间戳>.html   单文件报告，双击就能看
    reports/trade-latest.html     永远指向最近一次

口径（一个钱包一轮来回）：

| 字段 | 怎么算 |
|---|---|
| **投入** | 买腿链上真实流出多少计价币（从回执 Transfer 日志读，不是报价） |
| **回收** | 卖腿 + 扫残留链上真实流入多少计价币 |
| **磨损** | 投入 − 回收 |
| **成本 bps** | 磨损 / 投入 x 10000 |
| gas | 各腿 gasUsed x effectiveGasPrice 之和（原生币：Base=ETH / BSC=BNB） |
| 残留 | 没卖掉、还挂在交易币上的数量（残留 = 裸敞口） |

HTML 里有汇总卡片（钱包数 / 成功率 / 总投入 / 总回收 / 总磨损 / 单钱包 bps / 总 gas / 未清残留 / 总耗时）+ 可搜索筛选的明细表 + BscScan 链接。

npm run trade:report 打开最近一次（macOS 的 open）。


---

## 10. 安全注意

- **私钥**：key.env 里是哪把私钥就在哪把地址交易；签名只在本机完成，私钥不上传。
- **会话**：creds/ 里的 x-fptoken 等价于「已登录设备凭据」，泄露 = 别人能用你的会话调接口。
- **不要提交** .env / key.env / creds/ / reports/（都已在 .gitignore）。私钥一旦进过 git 历史，即使删除也还在 —— 只能立刻转移资产并重写历史。
- 建议用**专门的交易钱包**，不要用主钱包。
- **先小额**：干跑 → 小额真跑 → 确认无误 → 再放量。
- 每个钱包留够 **原生币**（Base 是 ETH，建议 >= 0.0005），否则中途发不出交易，可能出现「买了卖不成」的半截仓位。

---

## 11. 常见问题

| 现象 | 原因 / 怎么办 |
|---|---|
| 没有会话文件 | 第 5 步没做；在已登录 web3.okx.com 的浏览器里导出 HAR，再 --har |
| Invalid Verify Sign | 会话过期 / 签名算法变了（OKX 前端升级） |
| code=10104 请求已过期 | 正常，quoteId 秒级过期，脚本会自动重新报价 |
| 交易一直 revert（空 revert、gasUsed 固定） | **gas 不够**（OutOfGas）。脚本已用 estimateGas x 1.2 修好；若还遇到，把接口 gas 再放大 |
| 买腿一直失败 | 看日志的 ❗ 行；可能是余额不足 / 滑点过紧 / 行情剧烈（脚本会重试） |
| 报告「未清残留」不为 0 | 有钱包还挂着币 → npm run trade:sweep:exec |
| 被前置闸门跳过 | 该钱包原生币 < MIN_GAS_BNB 或计价币 < AMOUNT；充值或调小阈值 |
| nonce too low | 有别的交易在途 → 等几秒重跑 |
| 所有钱包都失败 | 检查 --rpc / 网络 / 会话是否有效 |

调试技巧：日志里每个买/卖腿都有 开始 -> ① 报价 -> ② calldata -> 收款人/最小得到 -> 余额 -> 授权 -> ③ 模拟 -> ④ gas -> ⛓ 广播 -> ✅/❌ 回执，逐步定位。

---

## 12. 文件说明

| 文件 | 作用 |
|---|---|
| bin/trade.js | 交易 CLI（模式分派：正常 / --fast / --approve-only / --sweep-only） |
| src/session.js | 从 HAR 抽会话 |
| src/sign.js | Ok-Verify-* 签名 |
| src/client.js | 请求客户端（签名 / 重试 / 头随机化） |
| src/wallets.js | 私钥解析 / 钱包选择 |
| src/solana.js | Solana 私钥解析（wallets.js 依赖；本工具不用） |
| src/dex.js | DEX 底层：报价 / 签名 / 广播 / 回执 / 链上读取 / calldata 解码 |
| src/swap.js | 一买一卖原语：prepare / broadcast / await / 原子来回 / 授权 / 扫残留 / 闸门 |
| src/trade-report.js | 交易报告（CSV + JSON + HTML） |
| .env.example | 配置模板（可入库） |
| key.env | 私钥（不入库） |
| creds/ | 会话（不入库） |
| reports/ | 报告输出（不入库） |
