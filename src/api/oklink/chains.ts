export interface ChainInfo {
  /** OKLink 的 chainShortName */
  key: string;
  /** 网页端接口路径中的链 slug（小写） */
  apiSlug: string;
  /** OKLink 站点页面 URL 中的链路径（SSR 实体标签抓取用） */
  siteSlug: string;
  /** 链家族：evm 走 EVM 端点族，tron 走波场专用端点族 */
  kind: 'evm' | 'tron';
  name: string;
  nativeSymbol: string;
  /** OKLink 网页端前缀，用于跳转 */
  explorerBase: string;
  /** 地址正则（用于搜索框识别输入类型） */
  addressPattern: RegExp;
}

export const CHAINS: ChainInfo[] = [
  {
    key: 'ETH',
    apiSlug: 'eth',
    siteSlug: 'ethereum',
    kind: 'evm',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    explorerBase: 'https://www.oklink.com/eth',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  {
    key: 'BSC',
    apiSlug: 'bsc',
    siteSlug: 'bsc',
    kind: 'evm',
    name: 'BNB Chain',
    nativeSymbol: 'BNB',
    explorerBase: 'https://www.oklink.com/bsc',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  {
    key: 'POLYGON',
    apiSlug: 'polygon',
    siteSlug: 'polygon',
    kind: 'evm',
    name: 'Polygon',
    nativeSymbol: 'POL',
    explorerBase: 'https://www.oklink.com/polygon',
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
  },
  {
    key: 'TRON',
    apiSlug: 'tron',
    siteSlug: 'tron',
    kind: 'tron',
    name: 'Tron',
    nativeSymbol: 'TRX',
    explorerBase: 'https://www.oklink.com/trx',
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  },
];

export function getChain(key: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.key === key);
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
  for (const chain of CHAINS) {
    if (chain.addressPattern.test(input)) {
      return { kind: 'address', chain: chain.key, address: input };
    }
  }
  // 输入不匹配任何已知格式时，按当前选中链的 EVM 地址处理，让后端返回明确错误
  if (selectedChain === 'TRON') {
    return { kind: 'address', chain: 'TRON', address: input };
  }
  return { kind: 'address', chain: selectedChain, address: input };
}
