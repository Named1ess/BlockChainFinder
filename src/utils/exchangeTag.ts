/** 已知交易所关键词（小写匹配）。用于区分「交易所钱包」与 KOL / ENS / 项目方等其他实体标签 */
const EXCHANGE_KEYWORDS = [
  'binance',
  'bnb', // BNB Vault 等币安系命名
  'okx',
  'okex',
  'gate.io',
  'gateio',
  'bybit',
  'bitget',
  'kucoin',
  'mexc',
  'huobi',
  'htx',
  'upbit',
  'bithumb',
  'coinbase',
  'kraken',
  'bitfinex',
  'gemini',
  'okcoin',
  'crypto.com',
  'ascendex',
  'lbank',
  'xt.com',
  'bingx',
  'bitmart',
  'poloniex',
  'whitebit',
];

/** 判断标签是否为交易所标签（如「Binance. DepositAndWithdraw_10」） */
export function isExchangeTag(label: string | null | undefined): boolean {
  if (!label) return false;
  const l = label.toLowerCase();
  return EXCHANGE_KEYWORDS.some((k) => l.includes(k));
}

/** 按交易所名称给标签配色，便于一眼区分 Gate / OKX / Binance 等 */
export function exchangeTagColor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('binance') || l.includes('bnb')) return 'gold';
  if (l.includes('okx') || l.includes('okb')) return 'black';
  if (l.includes('gate')) return 'volcano';
  if (l.includes('bybit')) return 'purple';
  if (l.includes('bitget')) return 'cyan';
  if (l.includes('upbit')) return 'blue';
  if (l.includes('bithumb')) return 'red';
  if (l.includes('kucoin')) return 'green';
  if (l.includes('mexc')) return 'magenta';
  if (l.includes('huobi') || l.includes('htx')) return 'orange';
  return 'geekblue';
}
