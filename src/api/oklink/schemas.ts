import { z } from 'zod';

/**
 * OKLink 网页端接口响应的容错 schema 与映射层。
 * 页面端返回数值多为 number（个别为字符串），这里统一做数字兼容；
 * 未知字段通过 passthrough 保留，映射结果与旧版应用内类型保持一致，
 * 因此外部组件（TxTable / TokenHoldingsTable / trace engine）无需改动。
 */

const numLike = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .optional()
  .catch(undefined);

const strField = z
  .string()
  .optional()
  .catch(undefined);

/** { total, hits: [...] } 分页信封 */
export const hitsEnvelopeSchema = z
  .object({
    total: numLike,
    hits: z.array(z.record(z.unknown())).nullish().catch(undefined),
  })
  .passthrough();

export type HitsEnvelope = z.infer<typeof hitsEnvelopeSchema>;

/** 普通/合约交易（transactionsByClassfy/condition） */
export const classfyTxSchema = z
  .object({
    hash: strField,
    blockHeight: numLike,
    blocktime: numLike,
    methodId: strField,
    method: strField,
    from: strField,
    to: strField,
    value: numLike,
    fee: numLike,
    isError: z.boolean().nullish().catch(undefined),
    status: strField,
  })
  .passthrough();

/** 代币/NFT 转账（transfers/condition/token 等） */
export const transferHitSchema = z
  .object({
    txhash: strField,
    blockHeight: numLike,
    blocktime: numLike,
    from: strField,
    to: strField,
    tokenContractAddress: strField,
    symbol: strField,
    coinName: strField,
    tokenType: strField,
    value: numLike,
    realValue: numLike,
    methodId: strField,
    method: strField,
    tokenPrice: numLike,
    tokenValueUsd: numLike,
  })
  .passthrough();

/** 内部调用（internalTx/condition、tron/internalTransactions） */
export const internalHitSchema = z
  .object({
    txhash: strField,
    blocktime: numLike,
    from: strField,
    to: strField,
    value: numLike,
    callValue: numLike,
    gasUsed: numLike,
    isError: z.boolean().nullish().catch(undefined),
    status: strField,
  })
  .passthrough();

/** 地址资产条目（holders/token：首行为原生币） */
export const assetHitSchema = z
  .object({
    tokenContractAddress: strField,
    symbol: strField,
    coinName: strField,
    value: numLike,
    price: numLike,
    usdValue: numLike,
  })
  .passthrough();

/** TRON TRC20 持仓条目（holders/tokens/{addr}/TRC20/statistic） */
export const tronHolderSchema = z
  .object({
    tokenContractAddress: strField,
    symbol: strField,
    coinName: strField,
    value: numLike,
    holdNum: numLike,
    price: numLike,
    usdValue: numLike,
  })
  .passthrough();

/** TRON 账户信息（v1/tron/addresses/info/{addr}） */
export const tronAccountInfoSchema = z
  .object({
    address: strField,
    balance: numLike,
    balanceUsd: numLike,
    totalUsdValue: numLike,
    firstTransactionTime: numLike,
    lastTransactionTime: numLike,
    tokenCountData: z
      .object({
        total: numLike,
      })
      .passthrough()
      .nullish()
      .catch(undefined),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* 应用内部类型（与旧版保持一致，供 UI / trace engine 直接消费）        */
/* ------------------------------------------------------------------ */

export interface TxItem {
  txId: string;
  height?: string;
  /** 秒级或毫秒级时间戳字符串，formatTime 会自适应 */
  transactionTime?: string;
  from: string;
  to: string;
  amount?: string;
  transactionSymbol?: string;
  state?: string;
  txFee?: string;
  methodId?: string;
  tokenContractAddress?: string;
}

/** 代币转账的代币符号：优先交易自带符号，否则用合约地址缩写 */
export function txTokenSymbol(tx: TxItem): string {
  if (tx.transactionSymbol) return tx.transactionSymbol;
  if (tx.tokenContractAddress) return shortContract(tx.tokenContractAddress);
  return 'UNKNOWN';
}

function shortContract(contract: string): string {
  return `${contract.slice(0, 6)}…${contract.slice(-4)}`;
}

export interface TokenHolding {
  symbol?: string;
  token?: string;
  tokenContractAddress?: string;
  holdingAmount?: string;
  priceUsd?: string;
  valueUsd?: string;
}

export interface AddressAsset {
  address?: string;
  chainShortName?: string;
  balance?: string;
  balanceSymbol?: string;
  totalTokenValue?: string;
  transactionCount?: string;
  tokenAmount?: string;
  firstTransactionTime?: string;
  lastTransactionTime?: string;
}
