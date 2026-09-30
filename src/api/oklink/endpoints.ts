import { pageApiFetch, tronscanFetch } from './client';
import {
  assetHitSchema,
  classfyTxSchema,
  hitsEnvelopeSchema,
  internalHitSchema,
  transferHitSchema,
  tronAccountInfoSchema,
  tronHolderSchema,
  tronscanTrc20ListSchema,
  tronscanTrc20Schema,
  tronscanTxListSchema,
  tronscanTxSchema,
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

/**
 * 该链在当前数据源下是否支持指定交易类型。
 * TRON 的普通/代币转账列表来自 TronScan（波场官方浏览器页面端接口，无需 Key），
 * 因为 OKLink 网页端已对未登录流量关闭这两类列表（官方页面同样显示为空）。
 */
export function txListSupported(chain: string, _protocolType: TxProtocolType): boolean {
  const info = getChain(chain);
  if (!info) return false;
  return true;
}

export interface TxListResult {
  transactions: TxItem[];
  totalPage: number;
}

const SUN_PER_TRX = 1e6;

/** TronScan 分页总页数：优先 rangeTotal（真实总数），total 可能被截断为 10000 */
function tronscanTotalPage(rangeTotal: string | number | undefined, total: string | number | undefined, limit: number, page: number, hits: number): number {
  for (const candidate of [rangeTotal, total]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0 && n !== 10000) return Math.max(1, Math.ceil(n / limit));
  }
  return hits >= limit ? page + 1 : Math.max(1, page);
}

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

  // ---- TRON：普通/代币转账走 TronScan，内部调用走 OKLink ----
  if (info.kind === 'tron') {
    if (protocolType === 'transaction') {
      const res = tronscanTxListSchema.parse(
        await tronscanFetch<unknown>('/api/transaction', {
          sort: '-timestamp',
          count: 'true',
          start: offset,
          limit,
          address,
        }),
      );
      const hits = (res.data ?? []).map((raw) => tronscanTxSchema.parse(raw));
      const transactions = hits
        .filter((h) => !h.contractData?.asset_name) // TRC10 资产转账不并入普通转账
        .map((h) => {
          const failed = h.revert === true || h.confirmed === false;
          return {
            txId: h.hash ?? '',
            height: h.block,
            transactionTime: h.timestamp ? String(Math.floor(Number(h.timestamp) / 1000)) : undefined,
            from: h.ownerAddress ?? '',
            to: h.toAddress ?? '',
            amount: h.contractData?.amount ? String(Number(h.contractData.amount) / SUN_PER_TRX) : '0',
            transactionSymbol: info.nativeSymbol,
            state: failed ? 'fail' : 'success',
          } satisfies TxItem;
        });
      return {
        transactions,
        totalPage: tronscanTotalPage(res.rangeTotal, res.total, limit, page, hits.length),
      };
    }

    if (protocolType === 'token_20') {
      const res = tronscanTrc20ListSchema.parse(
        await tronscanFetch<unknown>('/api/token_trc20/transfers', {
          sort: '-timestamp',
          count: 'true',
          start: offset,
          limit,
          relatedAddress: address,
          direction: 2,
        }),
      );
      const hits = (res.token_transfers ?? []).map((raw) => tronscanTrc20Schema.parse(raw));
      const transactions = hits.map((h) => {
        const decimals = h.tokenInfo?.tokenDecimal ?? 0;
        const raw = Number(h.quant);
        const amount = Number.isFinite(raw) ? raw / 10 ** decimals : 0;
        const failed = !!h.contractRet && h.contractRet !== 'SUCCESS';
        return {
          txId: h.transaction_id ?? '',
          eventIndex: h.event_index ?? h.log_index,
          height: h.block,
          transactionTime: h.block_ts ? String(Math.floor(Number(h.block_ts) / 1000)) : undefined,
          from: h.from_address ?? '',
          to: h.to_address ?? '',
          amount: String(amount),
          transactionSymbol: h.tokenInfo?.tokenAbbr ?? 'TRC20',
          tokenContractAddress: h.contract_address,
          state: failed ? 'fail' : 'success',
        } satisfies TxItem;
      });
      return {
        transactions,
        totalPage: tronscanTotalPage(res.rangeTotal, res.total, limit, page, hits.length),
      };
    }

    // internal：OKLink 波场内部交易接口
    const res = hitsEnvelopeSchema.parse(
      await pageApiFetch<unknown>(`v1/${info.apiSlug}/internalTransactions`, { address, offset, limit }),
    );
    return {
      transactions: (res.hits ?? []).map(toInternalTx(info.nativeSymbol)),
      totalPage: ceilTotal(res.total, (res.hits ?? []).length, limit, page),
    };
  }

  // ---- EVM：全部走 OKLink 页面端接口 ----
  if (protocolType === 'internal') {
    const res = hitsEnvelopeSchema.parse(
      await pageApiFetch<unknown>(`v2/${info.apiSlug}/addresses/${address}/internalTx/condition`, { offset, limit }),
    );
    return {
      transactions: (res.hits ?? []).map(toInternalTx(info.nativeSymbol)),
      totalPage: ceilTotal(res.total, (res.hits ?? []).length, limit, page),
    };
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
        eventIndex: h.logIndex ?? h.eventIndex,
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
