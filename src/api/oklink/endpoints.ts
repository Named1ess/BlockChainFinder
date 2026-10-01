import type { AddressAsset, TokenHolding, TxItem } from './schemas';
import { getChain } from './chains';
import { ChainApiError, UnsupportedEndpointError } from './client';
import { fetchBlockscoutAsset, fetchBlockscoutTokenBalances, fetchBlockscoutTransactions } from '../blockscout';
import { fetchTronscanAsset, fetchTronscanTokenBalances, fetchTronscanTransactions } from '../tronscan';
import { fetchTrongridAsset, fetchTrongridTokenBalances } from '../trongrid';

export type TxProtocolType = 'transaction' | 'token_20' | 'internal';
export type DataSource = 'Blockscout' | 'TronScan' | 'TronGrid';
export interface TokenBalanceResult { dataSource?: DataSource; warnings?: string[]; list: TokenHolding[]; totalPage: number }
export interface TxListResult { dataSource?: DataSource; transactions: TxItem[]; totalPage: number }

function providerFor(chain: string): DataSource {
  const provider = getChain(chain)?.dataSource;
  if (!provider) throw new UnsupportedEndpointError(`${chain} 暂未接入可用的数据源，请选择 Ethereum、Polygon 或 TRON。`);
  return provider;
}

export function txListSupported(chain: string, _protocolType: TxProtocolType): boolean {
  return !!getChain(chain)?.dataSource;
}

async function withTronAuthorizationFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!(error instanceof ChainApiError) || error.source !== 'TronScan' ||
        !['http', 'business'].includes(error.kind) || ![401, 403].includes(Number(error.code))) throw error;
    return fallback();
  }
}

export async function fetchAddressAsset(chain: string, address: string): Promise<AddressAsset | null> {
  return providerFor(chain) === 'Blockscout'
    ? fetchBlockscoutAsset(chain, address)
    : withTronAuthorizationFallback(() => fetchTronscanAsset(address), () => fetchTrongridAsset(address));
}

export async function fetchTokenBalances(chain: string, address: string, page: number, limit: number): Promise<TokenBalanceResult> {
  return providerFor(chain) === 'Blockscout'
    ? fetchBlockscoutTokenBalances(chain, address, page, limit)
    : withTronAuthorizationFallback(() => fetchTronscanTokenBalances(address, page, limit), () => fetchTrongridTokenBalances(address, page, limit));
}

export async function fetchAddressTransactions(chain: string, address: string, page: number, limit: number, protocolType: TxProtocolType = 'transaction'): Promise<TxListResult> {
  return providerFor(chain) === 'Blockscout'
    ? fetchBlockscoutTransactions(chain, address, page, limit, protocolType)
    : fetchTronscanTransactions(address, page, limit, protocolType);
}
