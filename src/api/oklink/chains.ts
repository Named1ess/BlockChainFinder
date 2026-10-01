export interface ChainInfo {
  /** 应用内部链标识 */
  key: string;
  /** 链家族：evm 走 EVM 端点族，tron 走波场专用端点族 */
  kind: 'evm' | 'tron';
  name: string;
  nativeSymbol: string;
  dataSource: 'Blockscout' | 'TronScan' | null;
  explorerName: string;
  /** 对应区块浏览器的页面前缀 */
  explorerBase: string;
  /** 地址正则（用于搜索框识别输入类型） */
  addressPattern: RegExp;
  /** 该链常见币种符号（盒武器搜索的币种过滤建议项） */
  commonTokens: string[];
}

export const CHAINS: ChainInfo[] = [
  {
    key: 'ETH',
    kind: 'evm',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    dataSource: 'Blockscout',
    explorerName: 'Blockscout',
    explorerBase: 'https://eth.blockscout.com',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    commonTokens: ['ETH', 'USDT', 'USDC', 'WBTC', 'DAI'],
  },
  {
    key: 'BSC',
    kind: 'evm',
    name: 'BNB Chain',
    nativeSymbol: 'BNB',
    dataSource: null,
    explorerName: 'BscScan',
    explorerBase: 'https://bscscan.com',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    commonTokens: ['BNB', 'USDT', 'USDC', 'CAKE'],
  },
  {
    key: 'POLYGON',
    kind: 'evm',
    name: 'Polygon',
    nativeSymbol: 'POL',
    dataSource: 'Blockscout',
    explorerName: 'Blockscout',
    explorerBase: 'https://polygon.blockscout.com',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    commonTokens: ['POL', 'MATIC', 'USDT', 'USDC'],
  },
  {
    key: 'TRON',
    kind: 'tron',
    name: 'Tron',
    nativeSymbol: 'TRX',
    dataSource: 'TronScan',
    explorerName: 'TronScan',
    explorerBase: 'https://tronscan.org/#',
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    commonTokens: ['TRX', 'USDT', 'USDC'],
  },
];

export function getChain(key: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.key === key);
}

export function getExplorerUrl(chain: string, kind: 'address' | 'tx', value: string): string | undefined {
  const info = getChain(chain);
  if (!info) return undefined;
  const path = info.kind === 'tron' && kind === 'tx' ? 'transaction' : kind;
  return `${info.explorerBase}/${path}/${encodeURIComponent(value)}`;
}

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export type ParsedSearch =
  | { kind: 'address'; chain: string; address: string }
  | { kind: 'tx'; chain: string; txid: string };

/** 解析搜索框输入：自动识别 EVM 地址 / TRON 地址 / 交易哈希 */
export function parseSearchInput(raw: string, selectedChain: string): ParsedSearch | null {
  const input = raw.trim();
  if (!input) return null;

  if (TX_HASH_PATTERN.test(input)) {
    return { kind: 'tx', chain: selectedChain, txid: input };
  }
  const tronChain = CHAINS.find((chain) => chain.kind === 'tron');
  if (tronChain?.addressPattern.test(input)) {
    return { kind: 'address', chain: tronChain.key, address: input };
  }
  const evmChain = CHAINS.find((chain) => chain.kind === 'evm' && chain.addressPattern.test(input));
  if (evmChain) {
    const selected = getChain(selectedChain);
    return {
      kind: 'address',
      chain: selected?.kind === 'evm' ? selected.key : evmChain.key,
      address: input,
    };
  }
  // 输入不匹配任何已知格式时，按当前选中链的 EVM 地址处理，让后端返回明确错误
  if (selectedChain === 'TRON') {
    return { kind: 'address', chain: 'TRON', address: input };
  }
  return { kind: 'address', chain: selectedChain, address: input };
}
