import { z } from 'zod';
import { OklinkApiError, tronscanFetch } from './oklink/client';
import type { AddressAsset, TokenHolding, TxItem } from './oklink/schemas';
import type { TokenBalanceResult, TxListResult, TxProtocolType } from './oklink/endpoints';

/** Official contracts: https://docs.tronscan.org/en/api (verified 2026-10-01).
 * Account and holdings endpoints require an API key; the same-origin proxy may supply it.
 * Transaction endpoints currently allow anonymous reads, subject to upstream policy.
 */
const integer = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String);
const count = z.union([z.string().regex(/^-?\d+$/), z.number().int().safe()]).transform(String);
const decimals = integer.refine(value => Number(value) <= 255);
const text = z.string().nullish();
const decimal = z.union([z.string().regex(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/), z.number().finite().nonnegative()]).transform(String);
const pageFields = { total: count.optional(), rangeTotal: count.optional() };
const dataPage = z.object({ ...pageFields, data: z.array(z.unknown()) });
const tokenPage = z.object({ ...pageFields, token_transfers: z.array(z.unknown()) });
const statusFields = {
  confirmed: z.boolean().optional(), revert: z.boolean().optional(), rejected: z.boolean().optional(),
  contractRet: text, result: text, finalResult: text,
};
const normalSchema = z.object({
  hash: z.string().min(1), ownerAddress: z.string().min(1), toAddress: z.string(),
  block: integer.optional(), timestamp: integer.optional(), contractType: integer.optional(),
  amount: integer.optional(), fee: z.union([integer, z.literal('')]).optional(),
  cost: z.object({ fee: integer.optional() }).nullish(),
  contractData: z.object({ amount: z.unknown().optional(), call_value: integer.optional(), asset_name: text }).nullish(),
  trigger_info: z.object({ call_value: integer.optional() }).nullish(),
  ...statusFields,
});
const tokenSchema = z.object({
  transaction_id: z.string().min(1), from_address: z.string().min(1), to_address: z.string().min(1),
  contract_address: z.string().min(1), quant: integer,
  event_index: integer.nullish(), log_index: integer.nullish(), block: integer.optional(), block_ts: integer.optional(),
  event_type: text, contract_type: text, tokenType2: text,
  tokenInfo: z.object({ tokenAbbr: text, tokenDecimal: decimals.nullish(), tokenType: text }).nullish(),
  ...statusFields,
});
const internalSchema = z.object({
  hash: z.string().min(1), internal_hash: z.string().min(1), from: z.string().min(1), to: z.string(),
  block: integer.optional(), timestamp: integer.optional(), call_value: integer, token_id: z.string(),
  ...statusFields,
});
const holdingSchema = z.object({
  tokenId: z.string().min(1), tokenName: text, tokenAbbr: text, tokenType: z.string(),
  tokenDecimal: decimals.nullish(), balance: integer, tokenPriceInUsd: decimal.nullish(), amountInUsd: decimal.nullish(),
});

function responseError(message = '上游响应格式无效，无法读取查询结果。'): OklinkApiError {
  return new OklinkApiError('INVALID_RESPONSE', message, { source: 'TronScan', kind: 'response' });
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw responseError();
  return result.data;
}

async function request(path: string, params: Record<string, string | number>): Promise<unknown> {
  const raw = await tronscanFetch<unknown>(path, params);
  if (raw !== null && typeof raw === 'object') {
    const body = raw as Record<string, unknown>;
    if ((body.code !== undefined && !['0', '200'].includes(String(body.code))) || body.status === '0') {
      const code = typeof body.code === 'number' || typeof body.code === 'string' ? body.code : 'BUSINESS';
      throw new OklinkApiError(code, '上游未成功处理查询，请检查服务可用性和访问授权。', { source: 'TronScan', kind: 'business' });
    }
  }
  return raw;
}

/** Place the decimal point without converting raw monetary amounts through Number. */
function units(raw: string, precision: string | number | null | undefined): string | undefined {
  if (precision === undefined || precision === null) return undefined;
  const scale = Number(precision);
  const digits = raw.replace(/^0+(?=\d)/, '').padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`;
}

function seconds(timestamp: string | undefined): string | undefined {
  return timestamp === undefined ? undefined : String(BigInt(timestamp) / 1000n);
}

function state(row: z.infer<typeof normalSchema> | z.infer<typeof tokenSchema> | z.infer<typeof internalSchema>): string | undefined {
  const results = [row.contractRet, row.result, row.finalResult].filter(Boolean);
  if (row.revert || row.rejected || results.some(result => result !== 'SUCCESS')) return 'fail';
  if (row.confirmed === false) return 'pending';
  return row.confirmed === true || results.length > 0 ? 'success' : undefined;
}

function offset(page: number, limit: number, maxLimit: number, maxRecords?: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit ||
      !Number.isSafeInteger(page * limit) || (maxRecords !== undefined && (page - 1) * limit >= maxRecords)) {
    throw new OklinkApiError('INVALID_PAGE', `分页参数超出 TronScan 支持范围（每页最多 ${maxLimit} 条${maxRecords ? `，最多 ${maxRecords} 条记录` : ''}）。`, { source: 'TronScan' });
  }
  return (page - 1) * limit;
}

function totalPages(row: { total?: string; rangeTotal?: string }, hits: number, page: number, limit: number, maxRecords?: number): number {
  for (const candidate of [row.rangeTotal, row.total]) {
    if (candidate !== undefined && BigInt(candidate) > 0n) {
      const records = maxRecords === undefined ? Number(candidate) : Number(BigInt(candidate) > BigInt(maxRecords) ? maxRecords : candidate);
      if (Number.isSafeInteger(records)) return Math.max(1, Math.ceil(records / limit));
    }
  }
  const estimate = hits >= limit ? page + 1 : Math.max(1, page);
  return maxRecords === undefined ? estimate : Math.min(estimate, Math.ceil(maxRecords / limit));
}

export async function fetchTronscanAsset(address: string): Promise<AddressAsset> {
  const row = parse(z.object({ address: z.string(), balanceStr: integer.optional(), balance: z.unknown().optional(),
    totalTransactionCount: integer.optional(), transactions: integer.optional(),
    date_created: integer.optional(), latest_operation_time: integer.optional(),
  }), await request('api/accountv2', { address }));
  if (row.address !== address) throw responseError('上游返回的账户与查询地址不一致。');
  const balance = row.balanceStr ?? parse(integer, row.balance);
  return {
    address, chainShortName: 'TRON', dataSource: 'TronScan', balance: units(balance, 6), balanceSymbol: 'TRX',
    transactionCount: row.totalTransactionCount ?? row.transactions,
    firstTransactionTime: seconds(row.date_created), lastTransactionTime: seconds(row.latest_operation_time),
    warnings: ['TronScan 账户接口未汇总完整持仓，总估值暂未提供。'],
  };
}

export async function fetchTronscanTokenBalances(address: string, page: number, limit: number): Promise<TokenBalanceResult> {
  const start = offset(page, limit, 200);
  const row = parse(dataPage, await request('api/account/tokens', { address, start, limit, show: 1, hidden: 1 }));
  const list = row.data.map(raw => parse(holdingSchema, raw)).filter(token => token.tokenType === 'trc20').map((token): TokenHolding => ({
    symbol: token.tokenAbbr ?? undefined, token: token.tokenName ?? undefined, tokenContractAddress: token.tokenId,
    holdingAmount: units(token.balance, token.tokenDecimal), priceUsd: token.tokenPriceInUsd ?? undefined,
    valueUsd: token.amountInUsd ?? undefined,
  }));
  return { dataSource: 'TronScan', list, totalPage: totalPages(row, row.data.length, page, limit) };
}

export async function fetchTronscanTransactions(address: string, page: number, limit: number, protocol: TxProtocolType = 'transaction'): Promise<TxListResult> {
  const start = offset(page, limit, 50, 10_000);
  const requestLimit = Math.min(limit, 10_000 - start);
  if (protocol === 'token_20') {
    const row = parse(tokenPage, await request('api/token_trc20/transfers', { relatedAddress: address, start, limit: requestLimit, direction: 'all' }));
    const transactions = row.token_transfers.map(raw => parse(tokenSchema, raw))
      .filter(token => (!token.event_type || token.event_type === 'Transfer') &&
        [token.contract_type, token.tokenType2, token.tokenInfo?.tokenType].every(type => !type || type === 'trc20'))
      .map((token): TxItem => ({
        txId: token.transaction_id, eventIndex: token.event_index ?? token.log_index ?? undefined,
        height: token.block, transactionTime: seconds(token.block_ts), from: token.from_address, to: token.to_address,
        amount: units(token.quant, token.tokenInfo?.tokenDecimal), transactionSymbol: token.tokenInfo?.tokenAbbr ?? undefined,
        tokenContractAddress: token.contract_address, state: state(token),
      }));
    return { dataSource: 'TronScan', transactions, totalPage: totalPages(row, row.token_transfers.length, page, limit, 10_000) };
  }
  if (protocol === 'internal') {
    // The documented tokens=_ option returned 404 in the public API contract check.
    // Request the address page and select native calls using the explicit token_id below.
    const row = parse(dataPage, await request('api/internal-transaction', { address, start, limit: requestLimit }));
    const transactions = row.data.map(raw => parse(internalSchema, raw)).filter(tx => tx.token_id === '_').map((tx): TxItem => ({
      txId: tx.hash, eventIndex: tx.internal_hash, height: tx.block, transactionTime: seconds(tx.timestamp),
      from: tx.from, to: tx.to, amount: units(tx.call_value, 6), transactionSymbol: 'TRX', state: state(tx),
    }));
    return { dataSource: 'TronScan', transactions, totalPage: totalPages(row, row.data.length, page, limit, 10_000) };
  }
  const row = parse(dataPage, await request('api/transaction', { address, start, limit: requestLimit, sort: '-timestamp', count: 'true' }));
  const transactions = row.data.map(raw => parse(normalSchema, raw))
    .filter(tx => tx.contractType !== '2' && !tx.contractData?.asset_name)
    .map((tx): TxItem => {
      // A smart-contract token amount is not a native transfer. Only native TransferContract
      // amounts or an explicit TriggerSmartContract call_value are safe to label as TRX.
      const amount = tx.contractType === '1'
        ? tx.amount ?? (tx.contractData?.amount === undefined ? undefined : parse(integer, tx.contractData.amount))
        : tx.contractType === '31' ? tx.contractData?.call_value ?? tx.trigger_info?.call_value : undefined;
      const fee = tx.cost?.fee ?? (tx.fee || undefined);
      return { txId: tx.hash, height: tx.block, transactionTime: seconds(tx.timestamp), from: tx.ownerAddress, to: tx.toAddress,
        amount: amount === undefined ? undefined : units(amount, 6), txFee: fee === undefined ? undefined : units(fee, 6),
        transactionSymbol: 'TRX', state: state(tx) };
    });
  return { dataSource: 'TronScan', transactions, totalPage: totalPages(row, row.data.length, page, limit, 10_000) };
}

/** Labels are exact-address public tags reported by TronScan, not inferred account ownership.
 * Reading a recent transaction also works for anonymous users; a missing tag means no evidence
 * in this response, not proof that the address does not belong to an exchange.
 */
export async function fetchTronscanEntityLabel(address: string): Promise<string | null> {
  const row = parse(z.object({
    data: z.array(z.object({ ownerAddress: z.string(), toAddress: z.string(), ownerAddressTag: text, toAddressTag: text })),
    contractInfo: z.record(z.object({ publicTag: text })).optional(),
  }), await request('api/transaction', { address, start: 0, limit: 1, sort: '-timestamp' }));
  const publicTag = row.contractInfo?.[address]?.publicTag?.trim();
  if (publicTag) return publicTag;
  for (const tx of row.data) {
    const tags = [tx.ownerAddress === address ? tx.ownerAddressTag : null, tx.toAddress === address ? tx.toAddressTag : null];
    for (const tag of tags) if (tag?.trim()) return tag.trim();
  }
  return null;
}
