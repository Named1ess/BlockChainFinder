import { z } from 'zod';
import { OklinkApiError, rateLimiter } from './oklink/client';
import type { AddressAsset, TokenHolding, TxItem } from './oklink/schemas';
import type { TokenBalanceResult, TxListResult, TxProtocolType } from './oklink/endpoints';

/** Public per-instance API; availability and authorization remain controlled by Blockscout. */
const NATIVE_SYMBOLS: Record<string, string> = { ETH: 'ETH', POLYGON: 'POL' };
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_QUERIES = 24;
const MAX_CACHED_ROWS = 5_000;

class BlockscoutError extends OklinkApiError {
  constructor(message: string, readonly status?: number, kind: 'network' | 'response' = 'response') {
    super(status ?? (kind === 'network' ? 'NETWORK' : 'RESPONSE'), message, {
      source: 'Blockscout',
      kind: status !== undefined ? 'http' : kind,
    });
    this.name = 'BlockscoutError';
  }
}

const integer = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String);
const rawAmount = z.string().regex(/^\d+$/);
const decimals = integer.refine(value => Number(value) <= 255);
const addressRef = z.object({ hash: z.string().min(1) });
// Public metadata is separate from contract names, ENS and user-specific private tags.
const publicAddressSchema = addressRef.extend({
  metadata: z.object({ tags: z.array(z.object({ name: z.string(), tagType: z.string().min(1) })) }).nullish(),
  public_tags: z.array(z.object({ address_hash: z.string().min(1), display_name: z.string(), label: z.string() })).nullish(),
});
const addressDetailSchema = publicAddressSchema.extend({
  coin_balance: rawAmount.nullable(),
  has_token_transfers: z.boolean().optional(),
});
const labeledTransferSchema = z.object({ from: publicAddressSchema, to: publicAddressSchema.nullable() });
const tokenSchema = z.object({
  address_hash: z.string().min(1),
  type: z.literal('ERC-20'),
  symbol: z.string().nullish(),
  name: z.string().nullish(),
  decimals: decimals.nullish(),
  exchange_rate: z.string().nullish(),
});
const txFields = {
  from: addressRef,
  to: addressRef.nullable(),
  created_contract: addressRef.nullish(),
  block_number: integer.nullish(),
  timestamp: z.string().refine(value => Number.isFinite(Date.parse(value))).nullish(),
};
const normalTxSchema = z.object({
  ...txFields,
  hash: z.string().min(1),
  value: rawAmount,
  status: z.string().nullish(),
  fee: z.object({ value: rawAmount.nullish() }).nullish(),
  decoded_input: z.object({ method_id: z.string().nullish() }).nullish(),
});
const tokenTxSchema = z.object({
  ...txFields,
  transaction_hash: z.string().min(1),
  log_index: integer,
  total: z.object({ value: rawAmount, decimals: decimals.nullish() }).nullable(),
  token: tokenSchema,
});
const internalTxSchema = z.object({
  ...txFields,
  transaction_hash: z.string().min(1),
  index: integer,
  value: rawAmount,
  success: z.boolean().nullish(),
});
const holdingSchema = z.object({ value: rawAmount, token: tokenSchema });
const cursorSchema = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]));
const listSchema = z.object({ items: z.array(z.unknown()), next_page_params: cursorSchema.nullable() });
type Cursor = z.infer<typeof cursorSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BlockscoutError('上游响应格式无效，无法读取查询结果。');
  return result.data;
}

/** Decimal placement uses strings throughout, including values larger than Number.MAX_SAFE_INTEGER. */
function units(value: string, precision: string | number | null | undefined): string | undefined {
  if (precision === null || precision === undefined) return undefined;
  const scale = Number(precision);
  const digits = value.replace(/^0+(?=\d)/, '').padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`;
}

function addressPath(chain: string, address: string): string {
  if (!Object.prototype.hasOwnProperty.call(NATIVE_SYMBOLS, chain)) throw new BlockscoutError(`不支持 ${chain} 链。`);
  return `/blockscout/${chain}/api/v2/addresses/${encodeURIComponent(address)}`;
}

function queryString(params: Cursor): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
    if (value !== null) query.set(key, String(value));
  }
  return query.toString();
}

async function request(url: string): Promise<unknown> {
  await rateLimiter.acquire();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } catch {
      throw new BlockscoutError(controller.signal.aborted ? '请求超时，请稍后重试。' : '网络请求失败，请稍后重试。', undefined, 'network');
    }
    if (!response.ok) {
      throw new BlockscoutError(`上游请求失败（HTTP ${response.status}），请检查服务可用性及访问授权。`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new BlockscoutError(controller.signal.aborted ? '请求超时，请稍后重试。' : '上游响应不是有效的 JSON。', undefined, controller.signal.aborted ? 'network' : 'response');
    }
  } finally {
    clearTimeout(timeout);
  }
}

interface Snapshot {
  createdAt: number;
  rows: unknown[];
  firstBatchLength?: number;
  next?: Cursor | null;
  seenCursors: Set<string>;
  pending?: Promise<void>;
}

const snapshots = new Map<string, Snapshot>();

function snapshotFor(key: string): Snapshot {
  for (const [cachedKey, cached] of snapshots) {
    if (Date.now() - cached.createdAt >= CACHE_TTL_MS) snapshots.delete(cachedKey);
  }
  const existing = snapshots.get(key);
  if (existing) return existing;
  if (snapshots.size >= MAX_CACHED_QUERIES) snapshots.delete(snapshots.keys().next().value!);
  const snapshot = { createdAt: Date.now(), rows: [], seenCursors: new Set<string>() };
  snapshots.set(key, snapshot);
  return snapshot;
}

async function loadNext(key: string, path: string, params: Cursor, snapshot: Snapshot): Promise<void> {
  if (snapshot.pending) return snapshot.pending;
  snapshot.pending = (async () => {
    const query = queryString({ ...snapshot.next, ...params });
    const result = parse(listSchema, await request(`${path}${query ? `?${query}` : ''}`));
    if (result.next_page_params !== null) {
      const signature = queryString(result.next_page_params);
      if (!signature || snapshot.seenCursors.has(signature)) throw new BlockscoutError('上游分页游标重复，无法继续读取。');
      snapshot.seenCursors.add(signature);
    }
    snapshot.firstBatchLength ??= result.items.length;
    snapshot.rows.push(...result.items);
    snapshot.next = result.next_page_params;
    // Large scans may continue, but their growing snapshot must not stay in the global cache.
    if (snapshot.rows.length > MAX_CACHED_ROWS && snapshots.get(key) === snapshot) snapshots.delete(key);
  })().catch(error => {
    if (snapshots.get(key) === snapshot) snapshots.delete(key);
    throw error;
  }).finally(() => { snapshot.pending = undefined; });
  return snapshot.pending;
}

/** Blockscout has cursor batches, not numbered pages. Walk batches then slice the requested UI page. */
async function listPage<T>(path: string, params: Cursor, page: number, limit: number, mapper: (row: unknown) => T) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(page * limit)) {
    throw new BlockscoutError('分页参数无效。');
  }
  const key = `${path}?${queryString(params)}`;
  const snapshot = snapshotFor(key);
  const end = page * limit;
  while (snapshot.next !== null && snapshot.rows.length < end) await loadNext(key, path, params, snapshot);
  const list = snapshot.rows.slice((page - 1) * limit, end).map(mapper);
  // Without an upstream count this is a lower bound until the final cursor is reached.
  const totalPage = Math.max(1, Math.ceil((snapshot.rows.length + (snapshot.next !== null ? 1 : 0)) / limit));
  return { list, totalPage };
}

function txCommon(row: z.infer<typeof normalTxSchema> | z.infer<typeof tokenTxSchema> | z.infer<typeof internalTxSchema>) {
  return {
    from: row.from.hash,
    to: row.to?.hash ?? row.created_contract?.hash ?? '',
    height: row.block_number ?? undefined,
    transactionTime: row.timestamp ? String(Math.floor(Date.parse(row.timestamp) / 1000)) : undefined,
  };
}

interface Cached<T> {
  createdAt: number;
  value: Promise<T>;
}

const addressCache = new Map<string, Cached<z.infer<typeof addressDetailSchema>>>();
const labelCache = new Map<string, Cached<string | null>>();

/** Coalesce in-flight calls, retain only successful results, and bound memory for long scans. */
function cached<T>(cache: Map<string, Cached<T>>, key: string, loader: () => Promise<T>): Promise<T> {
  for (const [cachedKey, entry] of cache) {
    if (Date.now() - entry.createdAt >= CACHE_TTL_MS) cache.delete(cachedKey);
  }
  const existing = cache.get(key);
  if (existing) return existing.value;
  if (cache.size >= MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
  const entry: Cached<T> = {
    createdAt: Date.now(),
    value: Promise.resolve().then(loader).catch(error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    }),
  };
  cache.set(key, entry);
  return entry.value;
}

function addressDetails(chain: string, address: string) {
  const path = addressPath(chain, address);
  return cached(addressCache, `${chain}:${address.toLowerCase()}`, async () => {
    const row = parse(addressDetailSchema, await request(path));
    if (row.hash.toLowerCase() !== address.toLowerCase()) throw new BlockscoutError('上游响应地址不匹配，无法读取查询结果。');
    return row;
  });
}

function publicLabels(row: z.infer<typeof publicAddressSchema>, address: string): string[] {
  if (row.hash.toLowerCase() !== address.toLowerCase()) return [];
  return [
    // Generic tags describe categories (e.g. Exchange), not the address's entity.
    ...(row.metadata?.tags ?? []).filter(tag => tag.tagType === 'name' || tag.tagType === 'protocol').map(tag => tag.name),
    ...(row.public_tags ?? []).filter(tag => tag.address_hash.toLowerCase() === address.toLowerCase()).map(tag => tag.display_name.trim() || tag.label),
  ].map(label => label.trim()).filter(Boolean);
}

/**
 * Read published Blockscout labels, never nicknames or counterparty ownership.
 * Some instances omit metadata from address details but enrich transfer address refs.
 * Inspect only the first ERC-20 batch; null means no public label in these responses,
 * not proof that the address is a personal wallet. Failures remain errors.
 */
export async function fetchBlockscoutEntityLabel(chain: string, address: string): Promise<string | null> {
  const path = addressPath(chain, address);
  return cached(labelCache, `${chain}:${address.toLowerCase()}`, async () => {
    const row = await addressDetails(chain, address);
    const direct = publicLabels(row, address);
    if (direct.length) return [...new Set(direct)].join('; ');
    if (row.has_token_transfers === false) return null;

    const transferPath = `${path}/token-transfers`;
    const params = { type: 'ERC-20' };
    const key = `${transferPath}?${queryString(params)}`;
    const snapshot = snapshotFor(key);
    try {
      if (snapshot.firstBatchLength === undefined) await loadNext(key, transferPath, params, snapshot);
      const transfers = snapshot.rows.slice(0, snapshot.firstBatchLength).map(raw => parse(labeledTransferSchema, raw));
      const labels = transfers.flatMap(transfer => [
        ...publicLabels(transfer.from, address),
        ...(transfer.to ? publicLabels(transfer.to, address) : []),
      ]);
      return labels.length ? [...new Set(labels)].join('; ') : null;
    } catch (error) {
      if (snapshots.get(key) === snapshot) snapshots.delete(key);
      throw error;
    }
  });
}

export async function fetchBlockscoutAsset(chain: string, address: string): Promise<AddressAsset> {
  const row = await addressDetails(chain, address);
  return {
    address: row.hash,
    chainShortName: chain,
    dataSource: 'Blockscout',
    balance: row.coin_balance === null ? undefined : units(row.coin_balance, 18),
    balanceSymbol: NATIVE_SYMBOLS[chain],
    warnings: ['Blockscout 地址接口未汇总完整持仓，总估值暂未提供。', ...(row.coin_balance === null ? ['原生币余额尚未提供。'] : [])],
  };
}

export async function fetchBlockscoutTokenBalances(chain: string, address: string, page: number, limit: number): Promise<TokenBalanceResult> {
  const result = await listPage(`${addressPath(chain, address)}/tokens`, { type: 'ERC-20' }, page, limit, (raw): TokenHolding => {
    const row = parse(holdingSchema, raw);
    return {
      symbol: row.token.symbol ?? undefined,
      token: row.token.name ?? undefined,
      tokenContractAddress: row.token.address_hash,
      holdingAmount: units(row.value, row.token.decimals),
      priceUsd: row.token.exchange_rate ?? undefined,
    };
  });
  return { ...result, dataSource: 'Blockscout' };
}

export async function fetchBlockscoutTransactions(chain: string, address: string, page: number, limit: number, protocol: TxProtocolType = 'transaction'): Promise<TxListResult> {
  const path = addressPath(chain, address);
  const nativeSymbol = NATIVE_SYMBOLS[chain];
  let endpoint: string;
  let params: Cursor = {};
  let mapper: (raw: unknown) => TxItem;
  if (protocol === 'token_20') {
    endpoint = 'token-transfers';
    params = { type: 'ERC-20' };
    mapper = raw => {
      const row = parse(tokenTxSchema, raw);
      return {
        ...txCommon(row), txId: row.transaction_hash, eventIndex: row.log_index,
        amount: row.total ? units(row.total.value, row.total.decimals ?? row.token.decimals) : undefined,
        transactionSymbol: row.token.symbol ?? undefined, tokenContractAddress: row.token.address_hash,
      };
    };
  } else if (protocol === 'internal') {
    endpoint = 'internal-transactions';
    mapper = raw => {
      const row = parse(internalTxSchema, raw);
      return {
        ...txCommon(row), txId: row.transaction_hash, eventIndex: row.index,
        amount: units(row.value, 18), transactionSymbol: nativeSymbol,
        state: row.success === true ? 'success' : row.success === false ? 'fail' : undefined,
      };
    };
  } else {
    endpoint = 'transactions';
    mapper = raw => {
      const row = parse(normalTxSchema, raw);
      return {
        ...txCommon(row), txId: row.hash, amount: units(row.value, 18), transactionSymbol: nativeSymbol,
        txFee: row.fee?.value ? units(row.fee.value, 18) : undefined,
        methodId: row.decoded_input?.method_id ?? undefined,
        state: row.status === 'ok' ? 'success' : row.status === 'error' ? 'fail' : 'pending',
      };
    };
  }
  const result = await listPage(`${path}/${endpoint}`, params, page, limit, mapper);
  return { transactions: result.list, totalPage: result.totalPage, dataSource: 'Blockscout' };
}
