import { z } from 'zod';
import { ChainApiError, trongridFetch } from './oklink/client';
import type { AddressAsset, TokenHolding } from './oklink/schemas';
import type { TokenBalanceResult } from './oklink/endpoints';

// Official V1 contracts: developers.tron.network/reference/get-account-info-by-address,
// get-trc20-token-balances-by-address and get-trc-20-token-information (2026-10-02).
const addressSchema = z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
const integer = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()]).transform(String);
const envelopeSchema = z.object({
  success: z.literal(true), data: z.array(z.unknown()),
  meta: z.object({ fingerprint: z.string().min(1).nullish() }).optional(),
});
const accountSchema = z.object({ address: z.string(), balance: integer.optional() });
const holdingSchema = z.record(addressSchema, integer).refine(row => Object.keys(row).length === 1);
const tokenSchema = z.object({
  contract_address: addressSchema, symbol: z.string().nullish(), name: z.string().nullish(),
  decimals: integer.refine(value => Number(value) <= 255).nullish(), type: z.string(),
});

function responseError(message = '上游响应格式无效，无法读取查询结果。'): ChainApiError {
  return new ChainApiError('INVALID_RESPONSE', message, { source: 'TronGrid', kind: 'response' });
}

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw responseError();
  return result.data;
}

async function request(path: string, params: Record<string, string | number | undefined> = {}) {
  const raw = await trongridFetch<unknown>(path, params);
  if (raw && typeof raw === 'object' && 'success' in raw && raw.success === false) {
    throw new ChainApiError('BUSINESS', '上游未成功处理查询，请检查服务可用性及授权。', { source: 'TronGrid', kind: 'business' });
  }
  return parse(envelopeSchema, raw);
}

function units(raw: string, scale: number): string {
  const digits = raw.replace(/^0+(?=\d)/, '').padStart(scale + 1, '0');
  if (!scale) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return `${digits.slice(0, -scale)}${fraction ? `.${fraction}` : ''}`;
}

/** Match V1's hex account address to the requested Base58 payload; the API validates its checksum. */
function addressHex(address: string): string {
  parse(addressSchema, address);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  const hex = value.toString(16);
  if (hex.length !== 50 || !hex.startsWith('41')) throw responseError('TRON 地址格式无效。');
  return hex.slice(0, 42);
}

export async function fetchTrongridAsset(address: string): Promise<AddressAsset> {
  const expectedHex = addressHex(address);
  const result = await request(`v1/accounts/${encodeURIComponent(address)}`, { only_confirmed: 'true' });
  if (result.data.length > 1) throw responseError();
  const account = result.data.length ? parse(accountSchema, result.data[0]) : undefined;
  if (account && account.address !== address && account.address.toLowerCase() !== expectedHex) {
    throw responseError('上游返回的账户与查询地址不一致。');
  }
  const warnings = ['TronScan 账户查询未获授权，已使用 TronGrid。总估值、交易笔数及最近交易时间暂未提供。'];
  if (account?.balance === undefined) warnings.push('TronGrid 未返回余额，账户可能尚未激活或尚未被索引；不将缺失信息当作零余额。');
  return { address, chainShortName: 'TRON', dataSource: 'TronGrid', balanceSymbol: 'TRX',
    balance: account?.balance === undefined ? undefined : units(account.balance, 6), warnings };
}

interface Holding { contract: string; raw: string }
interface Snapshot {
  createdAt: number;
  rows: Holding[];
  next?: string | null;
  seen: Set<string>;
  truncated?: boolean;
  pending?: Promise<void>;
}
const snapshots = new Map<string, Snapshot>();
const MAX_ROWS = 5000;
const MAX_BATCHES = 250;

function atReadLimit(snapshot: Snapshot): boolean {
  return snapshot.rows.length >= MAX_ROWS || snapshot.seen.size >= MAX_BATCHES;
}

function snapshotFor(address: string, limit: number): Snapshot {
  const key = `${address}:${limit}`;
  for (const [cachedKey, snapshot] of snapshots) {
    if (Date.now() - snapshot.createdAt >= 30_000) snapshots.delete(cachedKey);
  }
  const existing = snapshots.get(key);
  if (existing) return existing;
  if (snapshots.size >= 24) snapshots.delete(snapshots.keys().next().value!);
  const snapshot: Snapshot = { createdAt: Date.now(), rows: [], seen: new Set() };
  snapshots.set(key, snapshot);
  return snapshot;
}

async function loadNext(address: string, limit: number, snapshot: Snapshot): Promise<void> {
  if (snapshot.pending) return snapshot.pending;
  snapshot.pending = (async () => {
    if (atReadLimit(snapshot)) {
      throw responseError('持仓查询超过单次读取上限，请缩小查询范围或前往区块浏览器查看。');
    }
    const result = await request(`v1/accounts/${encodeURIComponent(address)}/trc20/balance`, { limit, fingerprint: snapshot.next ?? undefined });
    const rows = result.data.map(raw => {
      const [entry] = Object.entries(parse(holdingSchema, raw));
      return { contract: entry[0], raw: entry[1] };
    });
    const next = result.meta?.fingerprint ?? null;
    if (rows.length > limit || (next && (!rows.length || snapshot.seen.has(next)))) {
      throw responseError('上游持仓分页无效或游标重复，无法继续读取。');
    }
    if (next) snapshot.seen.add(next);
    // Preserve the cursor's original limit, but only retain the allowed window.
    snapshot.truncated = snapshot.rows.length + rows.length > MAX_ROWS;
    snapshot.rows.push(...rows.slice(0, MAX_ROWS - snapshot.rows.length));
    snapshot.next = next;
  })().catch(error => {
    const key = `${address}:${limit}`;
    if (snapshots.get(key) === snapshot) snapshots.delete(key);
    throw error;
  }).finally(() => { snapshot.pending = undefined; });
  return snapshot.pending;
}

export async function fetchTrongridTokenBalances(address: string, page: number, limit: number): Promise<TokenBalanceResult> {
  addressHex(address);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (page - 1) * limit >= MAX_ROWS) {
    throw new ChainApiError('INVALID_PAGE', '持仓分页参数无效（每页最多 200 条，单次最多 5000 条）。', { source: 'TronGrid' });
  }
  const snapshot = snapshotFor(address, limit);
  const end = page * limit;
  while (snapshot.next !== null && snapshot.rows.length < end && !atReadLimit(snapshot)) await loadNext(address, limit, snapshot);
  const limited = snapshot.truncated || (snapshot.next !== null && atReadLimit(snapshot));
  if (limited && (page - 1) * limit >= snapshot.rows.length) throw responseError('持仓查询已达到读取上限，请前往区块浏览器查看其余持仓。');
  const rows = snapshot.rows.slice((page - 1) * limit, end);
  const contracts = [...new Set(rows.map(row => row.contract))];
  const info = new Map<string, z.infer<typeof tokenSchema>>();
  // The official metadata endpoint accepts at most 20 contracts per request.
  for (let i = 0; i < contracts.length; i += 20) {
    const batch = contracts.slice(i, i + 20);
    const result = await request('v1/trc20/info', { contract_list: batch.join(',') });
    for (const raw of result.data) {
      const token = parse(tokenSchema, raw);
      if (batch.includes(token.contract_address) && token.type === 'trc20') info.set(token.contract_address, token);
    }
  }
  const list: TokenHolding[] = rows.map(row => {
    const token = info.get(row.contract);
    return { tokenContractAddress: row.contract, symbol: token?.symbol ?? undefined, token: token?.name ?? undefined,
      holdingAmount: token?.decimals == null ? undefined : units(row.raw, Number(token.decimals)) };
  });
  const warnings = ['TronScan 持仓查询未获授权，已使用 TronGrid 索引持仓；美元价格和估值暂未提供，页数随读取更新。'];
  if (list.some(row => row.holdingAmount === undefined)) warnings.push('部分代币缺少精度信息，保留合约地址并将数量显示为未知。');
  if (limited) warnings.push(`已达到读取上限，仅显示本次读取的前 ${snapshot.rows.length} 条持仓；其余持仓请前往区块浏览器查看。`);
  return { dataSource: 'TronGrid', warnings, list,
    totalPage: Math.max(1, Math.ceil((snapshot.rows.length + (snapshot.next !== null && !limited ? 1 : 0)) / limit)) };
}
