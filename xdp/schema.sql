-- ============================================================================
-- XDP (Doppler Finance, Base) 交易量采集 + 排行榜 —— 数据库结构
--   MySQL 5.7+ / 8.0，字符集 utf8mb4
--   用法：mysql -u <user> -p <dbname> < schema.sql
--   或：  npm run initdb   （会先建库再导入本文件）
--
-- 口径说明（排行榜）：
--   统计窗口    : trades.trade_time ∈ [CAMPAIGN_START_UTC, CAMPAIGN_END_UTC)（留空 = 不限制）
--   有效币对    : trades.quote_symbol ∈ VALID_QUOTE_SYMBOLS（留空 = 全算）
--   排除合约    : trades.wallet_is_contract = 0（EIP-7702 委托 EOA 不算合约）
--   路由（可选）: REQUIRE_OKX_ROUTE=0 时忽略；=1 时要求 trades.is_okx = 1
-- ============================================================================

SET NAMES utf8mb4;

-- ============================================================================
-- 交易明细表（每个成交一条，trade_id 唯一实现幂等去重）
-- ============================================================================
CREATE TABLE IF NOT EXISTS trades (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_id           VARCHAR(128)    NOT NULL COMMENT 'OKX 交易 ID',
  chain_index        VARCHAR(32)     NOT NULL COMMENT '链 ID（Base = 8453）',
  token_address      VARCHAR(64)     NOT NULL COMMENT '代币合约地址（小写）',
  wallet_address     VARCHAR(64)     NOT NULL COMMENT '钱包地址（小写）',
  tx_hash            VARCHAR(255)    DEFAULT NULL,
  type               ENUM('buy','sell') NOT NULL DEFAULT 'buy',
  volume_usd         DECIMAL(30,10)  NOT NULL DEFAULT 0 COMMENT '成交额（计价币数量 ≈ USD）',
  price              DECIMAL(40,20)  DEFAULT NULL,
  quote_symbol       VARCHAR(32)     DEFAULT NULL COMMENT '计价币符号（USDC/ETH/…）',
  dex_name           VARCHAR(64)     DEFAULT NULL,
  trade_time         DATETIME        DEFAULT NULL,
  raw_json           JSON            DEFAULT NULL COMMENT 'OKX 原始返回',
  -- 反范式标记（由采集写入 / scripts/scan-contracts.js / scripts/scan-routers.js 维护）
  is_okx             TINYINT(1)      NULL DEFAULT NULL COMMENT '1=经OKX路由 0=非 NULL=未判定',
  wallet_is_contract TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=该钱包是合约地址',
  -- 数据来源：onchain = 链上直采（快，出块就入库）；okx = OKX 接口（准，随后覆盖同一条）
  -- 数据来源：onchain=链上直采 / ws=OKX DEX WebSocket 实时推送 / okx=REST 接口（口径最准）
  -- 三条路的 trade_id 格式互不相同，跨源去重要认 (tx_hash, wallet_address, type)，不能认 trade_id
  source             ENUM('okx','onchain','ws') NOT NULL DEFAULT 'okx',
  created_at         TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uk_trade_id (trade_id),
  KEY idx_token_wallet (chain_index, token_address, wallet_address),
  -- 链上直采与接口双写时靠它去重（同一 tx + 钱包 + 方向只算一次）
  KEY idx_tx_wallet_type (tx_hash, wallet_address, type),
  KEY idx_token_time (chain_index, token_address, trade_time),
  KEY idx_token_quote (chain_index, token_address, quote_symbol),
  KEY idx_tx_hash (tx_hash),
  KEY idx_okx (chain_index, token_address, is_okx)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='OKX DEX 交易明细（XDP/Base）';

-- ============================================================================
-- 排行榜物化表（scripts/refresh-rank.js 每 10 秒刷新）
--   页面直接读这两张表，避免每次请求都扫 trades 做 GROUP BY
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_rank (
  chain_index    VARCHAR(32)   NOT NULL,
  token_address  VARCHAR(64)   NOT NULL,
  win_start      DATETIME      NOT NULL,
  win_end        DATETIME      NOT NULL,
  wallet_address VARCHAR(64)   NOT NULL,
  volume_usd     DECIMAL(30,10) NOT NULL DEFAULT 0,
  buy_volume     DECIMAL(30,10) NOT NULL DEFAULT 0,
  sell_volume    DECIMAL(30,10) NOT NULL DEFAULT 0,
  tx_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  buy_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sell_count     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rank_no        INT UNSIGNED  NOT NULL DEFAULT 0,
  first_trade_at DATETIME      DEFAULT NULL,
  last_trade_at  DATETIME      DEFAULT NULL,
  PRIMARY KEY (chain_index, token_address, win_start, win_end, wallet_address),
  KEY idx_rank (chain_index, token_address, win_start, win_end, rank_no),
  KEY idx_vol  (chain_index, token_address, win_start, win_end, volume_usd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='钱包排行榜物化表';

CREATE TABLE IF NOT EXISTS rank_meta (
  chain_index   VARCHAR(32) NOT NULL,
  token_address VARCHAR(64) NOT NULL,
  win_start     DATETIME    NOT NULL,
  win_end       DATETIME    NOT NULL,
  wallet_count  INT UNSIGNED NOT NULL DEFAULT 0,
  tx_count      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  volume_usd    DECIMAL(30,10) NOT NULL DEFAULT 0,
  buy_volume    DECIMAL(30,10) NOT NULL DEFAULT 0,
  sell_volume   DECIMAL(30,10) NOT NULL DEFAULT 0,
  first_trade_at DATETIME DEFAULT NULL,
  last_trade_at DATETIME DEFAULT NULL,
  -- 采集器版本（由 refresh-rank.js 写入）—— 看板从它读采集器版本，避免任何文件依赖
  collector_version VARCHAR(16) DEFAULT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chain_index, token_address, win_start, win_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='排行榜元信息（汇总 + 刷新时间）';

-- ============================================================================
-- 历史回溯游标（每个 链 + 代币 一行）
-- ============================================================================
CREATE TABLE IF NOT EXISTS crawl_cursor (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chain_index      VARCHAR(32)     NOT NULL,
  token_address    VARCHAR(64)     NOT NULL,
  last_after       VARCHAR(128)    DEFAULT NULL COMMENT 'OKX 分页游标',
  is_initialized   TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=回溯已完成',
  total_backfilled BIGINT UNSIGNED NOT NULL DEFAULT 0,
  empty_streak     INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '连续空页数（连续 N 次才认定翻到头，防空结果误判）',
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cursor (chain_index, token_address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='历史回溯游标';

-- ============================================================================
-- 合约地址检测结果（eth_getCode）
--   ⚠️ EIP-7702：EOA 委托后的代码是 0xef0100 + 20 字节地址（23 字节），
--   这类地址不是合约，scan-contracts.js 会显式排除，否则真实用户会被误排除。
-- ============================================================================
CREATE TABLE IF NOT EXISTS contract_check (
  address     VARCHAR(64)  NOT NULL COMMENT '钱包/合约地址（小写）',
  is_contract TINYINT(1)   NOT NULL DEFAULT 0,
  code_len    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '字节码长度',
  checked_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (address),
  KEY idx_is_contract (is_contract)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='地址是否为合约';

-- ============================================================================
-- OKX DEX 路由判定结果（scripts/scan-routers.js 维护）—— 可选口径
--   REQUIRE_OKX_ROUTE=1 时，只有 is_okx=1 的成交才计入排行
--   未出现在本表的 tx 视为「尚未判定」，统计时不计入
-- ============================================================================
CREATE TABLE IF NOT EXISTS okx_route (
  tx_hash    VARCHAR(255) NOT NULL COMMENT '链上交易哈希',
  router     VARCHAR(64)  DEFAULT NULL COMMENT '交易直接调用的合约地址',
  method_id  VARCHAR(16)  DEFAULT NULL COMMENT '链上方法 ID（OKX dagSwapTo = 0x0c307f76）',
  is_okx     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1=经 OKX DEX 路由',
  checked_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tx_hash),
  KEY idx_is_okx (is_okx),
  KEY idx_router (router)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='OKX DEX 路由判定';

-- ============================================================================
-- 官方榜「已报名钱包」名单（由 scripts/poll-launchpool.js 每次采样时 upsert）
--   官方榜 = 已报名 ∩ 有交易量。没报名的做市/搬砖地址交易量再大也不在榜上，
--   所以本地排行要跟官方对齐，就得把名单之外的钱包排除掉。
--   实测证据：官方榜尾部有 $0.00 的钱包 → 官方没有交易量门槛，
--   差异完全来自「是否报名」。
-- ============================================================================
CREATE TABLE IF NOT EXISTS official_wallet (
  launchpool_id  INT            NOT NULL,
  wallet_address VARCHAR(64)    NOT NULL COMMENT '钱包地址（小写）',
  rank_no        INT            NOT NULL DEFAULT 0 COMMENT '官方名次',
  boost_volume   DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '官方 Boost 交易量',
  updated_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (launchpool_id, wallet_address),
  KEY idx_rank (launchpool_id, rank_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='官方榜已报名钱包名单';

-- ============================================================================
-- 官方 Launchpool 榜单采样（可选，由 scripts/poll-launchpool.js 维护）
--   用途：监测「报名人数 / 反推获奖钱包数」，盯女巫刷单
--   captured_at 由采集器显式写 UTC（读的时候按 UTC 处理，别当本地时间）
-- ============================================================================
CREATE TABLE IF NOT EXISTS okx_launchpool_snap (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  launchpool_id  INT             NOT NULL,
  captured_at    DATETIME        NOT NULL COMMENT 'UTC（采集器显式写入）',
  participants   INT             DEFAULT NULL COMMENT '官方报名人数',
  total_volume   DECIMAL(30,10)  DEFAULT NULL,
  top1_volume    DECIMAL(30,10)  DEFAULT NULL,
  top10_volume   DECIMAL(30,10)  DEFAULT NULL,
  top50_volume   DECIMAL(30,10)  DEFAULT NULL,
  top100_volume  DECIMAL(30,10)  DEFAULT NULL,
  equal_share    DECIMAL(20,10)  DEFAULT NULL COMMENT '均分池每人（反推）',
  winners        INT             DEFAULT NULL COMMENT '获奖钱包数（反推）',
  fit_k          DECIMAL(20,12)  DEFAULT NULL COMMENT '拟合斜率',
  fit_k_theory   DECIMAL(20,12)  DEFAULT NULL COMMENT '理论斜率 = 交易量奖池/总量',
  local_wallets  INT             DEFAULT NULL COMMENT '本地实时有效钱包数',
  local_volume   DECIMAL(30,10)  DEFAULT NULL COMMENT '本地实时总量',
  PRIMARY KEY (id),
  UNIQUE KEY uk_snap (launchpool_id, captured_at),
  KEY idx_time (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='OKX 官方榜单采样';

-- ============================================================================
-- 磨损（真实成本）—— 由交易端 bin/trade.js 跑完 POST 上报，PHP 写入
--   与 trades / wallet_rank 的口径差异：
--     trades.volume_usd  = **官方口径**的交易量（OKX 接口 / 链上采集）
--     wallet_cost.*      = **我们自己真实花掉的钱**（买入花的 USDC − 卖出收回的 USDC）
--   两者不要求一致，磨损就该按真实支出算。
--
--   明细表是事实来源（一轮一钱包一行），汇总表由明细重算，页面只读汇总表。
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_cost_detail (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id         VARCHAR(64)   NOT NULL COMMENT '一次交易的唯一 ID（交易端生成，幂等键）',
  batch_id       VARCHAR(64)   DEFAULT NULL COMMENT '批次 ID（同一次命令里的所有钱包共享）',
  wallet_address VARCHAR(64)   NOT NULL COMMENT '钱包地址（小写）',
  chain_index    VARCHAR(32)   NOT NULL DEFAULT '8453',
  spent_usd      DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '本轮投入（计价币数量≈USD）',
  received_usd   DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '本轮回收（含扫残留卖回的）',
  cost_usd       DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '本轮磨损 = 投入 − 回收（不含 gas）',
  volume_usd     DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '本轮成交额（买+卖，计价币口径）',
  gas_native     DECIMAL(40,20) NOT NULL DEFAULT 0 COMMENT '本轮 gas（原生币，Base = ETH）',
  rounds         INT UNSIGNED   NOT NULL DEFAULT 0 COMMENT '本轮来回次数',
  ok             TINYINT(1)     NOT NULL DEFAULT 1 COMMENT '交易端判定是否成功',
  buy_tx         VARCHAR(255)   DEFAULT NULL,
  sell_tx        VARCHAR(255)   DEFAULT NULL,
  sweep_tx       VARCHAR(255)   DEFAULT NULL,
  seconds        DECIMAL(10,1)  DEFAULT NULL COMMENT '该钱包耗时',
  traded_at      DATETIME       DEFAULT NULL COMMENT 'UTC（交易端显式写入）',
  created_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- ★ 幂等命门：同一份报告重复推送只算一次，磨损不会翻倍
  UNIQUE KEY uk_run_wallet (run_id, wallet_address),
  KEY idx_wallet (wallet_address),
  KEY idx_run (run_id),
  KEY idx_time (traded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='磨损明细（交易端上报，一轮一钱包一行）';

CREATE TABLE IF NOT EXISTS wallet_cost (
  wallet_address VARCHAR(64)   NOT NULL COMMENT '钱包地址（小写）',
  chain_index    VARCHAR(32)   NOT NULL DEFAULT '8453',
  spent_usd      DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '累计投入',
  received_usd   DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '累计回收',
  cost_usd       DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '★ 累计磨损（只增不减）',
  volume_usd     DECIMAL(30,10) NOT NULL DEFAULT 0 COMMENT '累计成交额',
  gas_native     DECIMAL(40,20) NOT NULL DEFAULT 0 COMMENT '累计 gas（ETH）',
  rounds         INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '累计来回轮数',
  runs           INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '累计上报批次/报告数',
  first_at       DATETIME      DEFAULT NULL COMMENT '第一次交易（UTC）',
  last_at        DATETIME      DEFAULT NULL COMMENT '最后一次交易（UTC）',
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (wallet_address),
  KEY idx_cost (cost_usd),
  KEY idx_last (last_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='钱包累计磨损（页面直接读，由 wallet_cost_detail 重算）';
