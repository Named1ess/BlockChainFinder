import { pageApiFetch, UnsupportedEndpointError } from './client';
import {
  assetHitSchema,
  classfyTxSchema,
  hitsEnvelopeSchema,
  internalHitSchema,
  transferHitSchema,
  tronAccountInfoSchema,
  tronHolderSchema,
  type AddressAsset,
  type TokenHolding,
  type TxItem,
} from './schemas';
import { getChain } from './chains';

/** 地址总览：原生币余额、总价值、交易笔数、最近交易时间 */
export async function fetchAddressAsset(chain: string, address: string): Promise<AddressAsset | null> {
  const info = getChain(chain);
  if (!info) return null;

  const asset: AddressAsset = { address, chainShortName: chain };

  if (info.kind === 'tron') {
    // 波场：单个账户信息接口即可覆盖
    const raw = await pageApiFetch<unknown>(`v1/${info.apiSlug}/addresses/info/${address}`);
    const acc = tronAccountInfoSchema.parse(raw);
    return {
      ...asset,
      balance: acc.balance,
      balanceSymbol: info.nativeSymbol,
      totalTokenValue: acc.totalUsdValue ?? acc.balanceUsd,
      tokenAmount: acc.tokenCountData?.total,
      firstTransactionTime: acc.firstTransactionTime,
      lastTransactionTime: acc.lastTransactionTime,
    };
  }

  // EVM：总价值 + 资产列表（含原生币行）+ 最新一笔交易，三者并行、互不阻塞
  const safe = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
  const [totalValue, assetsRes, recentRes] = await Promise.all([
    safe(pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/totalvalue`)),
    safe(
      pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/holders/token`, {
        type: 'statistic',
        offset: 0,
        limit: 50,
      }).then((r) => hitsEnvelopeSchema.parse(r)),
    ),
    safe(
      pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/transactionsByClassfy/condition`, {
        offset: 0,
        limit: 1,
      }).then((r) => hitsEnvelopeSchema.parse(r)),
    ),
  ]);

  const hasAny = totalValue !== undefined || assetsRes !== undefined || recentRes !== undefined;
  if (!hasAny) return null;

  if (totalValue !== undefined) {
    asset.totalTokenValue = String(totalValue);
  }

  if (assetsRes) {
    asset.tokenAmount = assetsRes.total;
    const nativeHits = (assetsRes.hits ?? []).map((h) => assetHitSchema.parse(h));
    const native = nativeHits.find(
      (h) => !h.tokenContractAddress || h.symbol?.toUpperCase() === info.nativeSymbol.toUpperCase(),
    );
    if (native) {
      asset.balance = native.value;
      asset.balanceSymbol = native.symbol ?? info.nativeSymbol;
    }
  }

  if (recentRes) {
    asset.transactionCount = recentRes.total;
    const latest = (recentRes.hits ?? []).map((h) => classfyTxSchema.parse(h))[0];
    if (latest?.blocktime) asset.lastTransactionTime = latest.blocktime;
  }

  return asset;
}

export interface TokenBalanceResult {
  list: TokenHolding[];
  totalPage: number;
}

function ceilTotal(total: string | number | undefined, hits: number, limit: number, page: number): number {
  const n = Number(total);
  if (Number.isFinite(n) && n > 0) return Math.max(1, Math.ceil(n / limit));
  // total 不可靠时按「还有下一页」估算
  return hits >= limit ? page + 1 : Math.max(1, page);
}

function isNativeRow(contract: string | undefined, symbol: string | undefined, nativeSymbol: string): boolean {
  if (!contract) return true;
  return !!symbol && symbol.toUpperCase() === nativeSymbol.toUpperCase();
}

/** 地址代币持仓（分页）。EVM 与 TRON 各有端点 */
export async function fetchTokenBalances(
  chain: string,
  address: string,
  page: number,
  limit: number,
): Promise<TokenBalanceResult> {
  const info = getChain(chain);
  if (!info) return { list: [], totalPage: 1 };
  const offset = (page - 1) * limit;

  if (info.kind === 'tron') {
    const res = hitsEnvelopeSchema.parse(
      await pageApiFetch<unknown>(`v2/${info.apiSlug}/holders/tokens/${address}/TRC20/statistic`, { offset, limit }),
    );
    const list = (res.hits ?? []).map((raw) => {
      const h = tronHolderSchema.parse(raw);
      return {
        symbol: h.symbol,
        token: h.coinName,
        tokenContractAddress: h.tokenContractAddress,
        holdingAmount: h.holdNum ?? h.value,
        priceUsd: h.price,
        valueUsd: h.usdValue ?? (h.holdNum !== undefined && h.price !== undefined ? String(Number(h.holdNum) * Number(h.price)) : undefined),
      } satisfies TokenHolding;
    });
    return { list, totalPage: ceilTotal(res.total, list.length, limit, page) };
  }

  const res = hitsEnvelopeSchema.parse(
    await pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/holders/token`, {
      type: 'statistic',
      offset,
      limit,
    }),
  );
  const list = (res.hits ?? [])
    .map((raw) => assetHitSchema.parse(raw))
    .filter((h) => !isNativeRow(h.tokenContractAddress, h.symbol, info.nativeSymbol))
    .map(
      (h): TokenHolding => ({
        symbol: h.symbol,
        token: h.coinName,
        tokenContractAddress: h.tokenContractAddress,
        holdingAmount: h.value,
        priceUsd: h.price,
        valueUsd: h.usdValue,
      }),
    );
  return { list, totalPage: ceilTotal(res.total, list.length, limit, page) };
}

/** 交易类型（对应 UI 的三个标签页） */
export type TxProtocolType = 'transaction' | 'token_20' | 'internal';

/** 该链在网页端接口下是否支持指定交易类型（TRON 的普通/代币转账列表受签名网关保护） */
export function txListSupported(chain: string, protocolType: TxProtocolType): boolean {
  const info = getChain(chain);
  if (!info) return false;
  if (info.kind === 'evm') return true;
  return protocolType === 'internal';
}

export interface TxListResult {
  transactions: TxItem[];
  totalPage: number;
}

const tronUnsupportedMessage =
  'OKLink 网页端对 Tron 的转账列表启用了额外签名校验，暂时无法直接抓取。可切换「内部调用」查看，或改用 Ethereum / BNB Chain / Polygon 地址。';

/** 地址交易列表（分页）。protocolType 区分普通转账 / 代币转账 / 内部调用 */
export async function fetchAddressTransactions(
  chain: string,
  address: string,
  page: number,
  limit: number,
  protocolType: TxProtocolType = 'transaction',
): Promise<TxListResult> {
  const info = getChain(chain);
  if (!info) return { transactions: [], totalPage: 1 };
  const offset = (page - 1) * limit;

  // ---- 内部调用：EVM 与 TRON 均可用 ----
  if (protocolType === 'internal') {
    if (info.kind === 'tron') {
      const res = hitsEnvelopeSchema.parse(
        await pageApiFetch<unknown>(`v1/${info.apiSlug}/internalTransactions`, { address, offset, limit }),
      );
      return {
        transactions: (res.hits ?? []).map(toInternalTx(info.nativeSymbol)),
        totalPage: ceilTotal(res.total, (res.hits ?? []).length, limit, page),
      };
    }
    const res = hitsEnvelopeSchema.parse(
      await pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/internalTx/condition`, { offset, limit }),
    );
    return {
      transactions: (res.hits ?? []).map(toInternalTx(info.nativeSymbol)),
      totalPage: ceilTotal(res.total, (res.hits ?? []).length, limit, page),
    };
  }

  // ---- 普通转账 / 代币转账：仅 EVM 可用 ----
  if (info.kind === 'tron') {
    throw new UnsupportedEndpointError(tronUnsupportedMessage);
  }

  if (protocolType === 'transaction') {
    const res = hitsEnvelopeSchema.parse(
      await pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/transactionsByClassfy/condition`, {
        offset,
        limit,
      }),
    );
    const transactions = (res.hits ?? []).map((raw) => {
      const h = classfyTxSchema.parse(raw);
      const failed = h.isError === true || (!!h.status && h.status !== '0x1' && h.status !== 'success');
      return {
        txId: h.hash ?? '',
        height: h.blockHeight,
        transactionTime: h.blocktime,
        from: h.from ?? '',
        to: h.to ?? '',
        amount: h.value,
        transactionSymbol: info.nativeSymbol,
        txFee: h.fee,
        methodId: h.methodId,
        state: failed ? 'fail' : 'success',
      } satisfies TxItem;
    });
    return { transactions, totalPage: ceilTotal(res.total, transactions.length, limit, page) };
  }

  // token_20
  const res = hitsEnvelopeSchema.parse(
    await pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/transfers/condition/token`, { offset, limit }),
  );
  const transactions = (res.hits ?? [])
    .map((raw) => transferHitSchema.parse(raw))
    // 列表里可能混入 NFT（ERC721/1155）转账，「代币转账」标签只保留同质化代币
    .filter((h) => !h.tokenType || h.tokenType === 'ERC20')
    .map(
      (h): TxItem => ({
        txId: h.txhash ?? '',
        height: h.blockHeight,
        transactionTime: h.blocktime,
        from: h.from ?? '',
        to: h.to ?? '',
        amount: h.value,
        transactionSymbol: h.symbol,
        methodId: h.methodId,
        tokenContractAddress: h.tokenContractAddress,
        state: 'success',
      }),
    );
  return { transactions, totalPage: ceilTotal(res.total, transactions.length, limit, page) };
}

function toInternalTx(nativeSymbol: string) {
  return (raw: unknown): TxItem => {
    const h = internalHitSchema.parse(raw);
    const failed = h.isError === true || (!!h.status && h.status !== '0x1');
    return {
      txId: h.txhash ?? '',
      transactionTime: h.blocktime,
      from: h.from ?? '',
      to: h.to ?? '',
      amount: h.callValue ?? h.value ?? '0',
      transactionSymbol: nativeSymbol,
      state: failed ? 'fail' : 'success',
    };
  };
}
