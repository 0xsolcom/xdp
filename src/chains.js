/**
 * 各链的基础信息：原生币符号 / 区块浏览器 / RPC 池。
 *
 * 这些原本散落在 swap.js（BSC RPC 池）、trade.js（gas 显示 BNB）、trade-report.js（bscscan 链接）里，
 * 换链就得改三处。集中到这里，按 chainId 取。
 */
export const CHAINS = {
  1:    { name: 'Ethereum',     native: 'ETH', explorer: 'https://etherscan.io/tx/',        rpc: ['https://eth.llamarpc.com', 'https://ethereum-rpc.publicnode.com', 'https://rpc.ankr.com/eth'] },
  10:   { name: 'OP Mainnet',   native: 'ETH', explorer: 'https://optimistic.etherscan.io/tx/', rpc: ['https://mainnet.optimism.io'] },
  56:   { name: 'BSC',          native: 'BNB', explorer: 'https://bscscan.com/tx/',           rpc: ['https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc-dataseed1.binance.org', 'https://bsc-dataseed.binance.org'] },
  137:  { name: 'Polygon',      native: 'POL', explorer: 'https://polygonscan.com/tx/',       rpc: ['https://polygon-rpc.com', 'https://polygon-bor-rpc.publicnode.com'] },
  // Base：下面这些节点都实测过「能取回执」。已剔除 base-rpc.publicnode.com（eth_getTransactionReceipt
  // 直接报 "Archive requests require a personal token"）和 base.llamarpc.com（返回 HTML，整个节点不可用）。
  // 顺序只是兜底参考；启动时会先测延迟 + 探测回执能力，再按结果排序（见 swap.js resolveRpc）。
  8453: { name: 'Base',         native: 'ETH', explorer: 'https://basescan.org/tx/',          rpc: [
    'https://base.drpc.org',
    'https://mainnet.base.org',
    'https://base.gateway.tenderly.co',
    'https://developer-access-mainnet.base.org',
    'https://base-mainnet.public.blastapi.io',
    'https://base-pokt.nodies.app',
    // 已剔除：base.meowrpc.com（间歇性返回 HTML）、1rpc.io/base（频繁 Rate limit）
  ] },
  42161:{ name: 'Arbitrum One', native: 'ETH', explorer: 'https://arbiscan.io/tx/',           rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  196:  { name: 'X Layer',      native: 'OKB', explorer: 'https://www.oklink.com/xlayer/tx/', rpc: ['https://rpc.xlayer.tech'] },
};

const FALLBACK = { name: 'chain', native: 'ETH', explorer: '', rpc: [] };

/** 取某条链的信息；未知链给一份安全默认（原生币按 ETH、无浏览器、无 RPC 池） */
export const chainInfo = (id) => CHAINS[Number(id)] || Object.assign({}, FALLBACK, { name: 'chain ' + id });
export const nativeSymbol = (id) => chainInfo(id).native;
export const explorerTx = (id, hash) => (hash ? chainInfo(id).explorer + hash : '');