import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('../src/api/oklink/endpoints');
const fetchStub = vi.fn<typeof fetch>();
const address = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';
const hex = '41e28b3cfd4e0e909077821478e9fcb86b84be786e';
const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const beeple = 'TSPigbpXYgt8JdgRmKew2SmJx41zymepb1';
const trust = 'TYB4VnbKJpbTXbubag4F9LpbTLKyDCm4z1';
const metadata = [
  { contract_address: usdt, symbol: 'USDT', name: 'Tether USD', decimals: '6', type: 'trc20' },
  { contract_address: beeple, symbol: 'B20', name: 'Beeple 20', decimals: '8', type: 'trc20' },
  { contract_address: trust, symbol: 'TST', name: 'TRUST', decimals: '18', type: 'trc20' },
];
const envelope = (data: unknown[], meta = {}) => ({ success: true, data, meta: { at: 1704067200000, page_size: data.length, ...meta } });

beforeEach(async () => {
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  const { rateLimiter, trongridRateLimiter } = await import('../src/api/oklink/client');
  vi.spyOn(rateLimiter, 'acquire').mockResolvedValue();
  vi.spyOn(trongridRateLimiter, 'acquire').mockResolvedValue();
  api = await import('../src/api/oklink/endpoints');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function upstream(account: unknown = envelope([{ address: hex, balance: 2101293388317688 }]),
  holdings: (url: URL) => unknown = () => envelope([{ [beeple]: '100000000000' }, { [usdt]: '9007199254740993000001' }]),
  tokenInfo: unknown = envelope(metadata)) {
  fetchStub.mockImplementation(async input => {
    const url = new URL(String(input), 'http://local');
    if (url.pathname.startsWith('/tronscan/')) return new Response('', { status: 401 });
    if (url.pathname === `/trongrid/v1/accounts/${address}`) {
      expect(url.searchParams.get('only_confirmed')).toBe('true');
      return Response.json(account);
    }
    if (url.pathname === `/trongrid/v1/accounts/${address}/trc20/balance`) return Response.json(holdings(url));
    if (url.pathname === '/trongrid/v1/trc20/info') {
      expect(url.searchParams.get('contract_list')?.split(',').length).toBeLessThanOrEqual(20);
      return Response.json(tokenInfo);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
}

describe('TRON authorization fallback', () => {
  it('recovers native balance after TronScan 401 using a matching confirmed TronGrid account', async () => {
    upstream();
    const asset = await api.fetchAddressAsset('TRON', address);
    expect(asset).toMatchObject({ dataSource: 'TronGrid', address, balance: '2101293388.317688', balanceSymbol: 'TRX' });
    expect(asset?.totalTokenValue).toBeUndefined();
    expect(asset?.transactionCount).toBeUndefined();
    expect(asset?.warnings?.length).toBeGreaterThan(0);
  });

  it.each([
    envelope([{ address: '410000000000000000000000000000000000000000', balance: 123 }]),
    envelope([{ address: hex, balance: 9007199254740992 }]),
    { success: false, data: [], error: 'denied' },
    { data: [] },
  ])('does not mask malformed accounts as zero balances: %j', async body => {
    upstream(body);
    await expect(api.fetchAddressAsset('TRON', address)).rejects.toMatchObject({ source: 'TronGrid' });
  });

  it.each([envelope([]), envelope([{ address: hex }])])('leaves unavailable native balance unknown: %j', async body => {
    upstream(body);
    const asset = await api.fetchAddressAsset('TRON', address);
    expect(asset?.balance).toBeUndefined();
    expect(asset?.warnings?.length).toBeGreaterThan(0);
  });

  it('retains exact string native amounts and explicit zero', async () => {
    upstream(envelope([{ address: hex, balance: '9007199254740993000001' }]));
    expect((await api.fetchAddressAsset('TRON', address))?.balance).toBe('9007199254740993.000001');
    upstream(envelope([{ address: hex, balance: 0 }]));
    expect((await api.fetchAddressAsset('TRON', address))?.balance).toBe('0');
  });

  it('joins token precision by contract rather than metadata order and never invents USD value', async () => {
    upstream();
    const result = await api.fetchTokenBalances('TRON', address, 1, 20);
    expect(result.dataSource).toBe('TronGrid');
    expect(result.list).toEqual([
      expect.objectContaining({ tokenContractAddress: beeple, symbol: 'B20', holdingAmount: '1000' }),
      expect.objectContaining({ tokenContractAddress: usdt, symbol: 'USDT', holdingAmount: '9007199254740993.000001' }),
    ]);
    expect(result.list.every(row => row.priceUsd === undefined && row.valueUsd === undefined)).toBe(true);
  });

  it('walks opaque cursors for later pages and ignores upstream next URLs', async () => {
    upstream(undefined, url => url.searchParams.get('fingerprint') === 'next+/=' ? envelope([{ [trust]: '50000000000000000000000' }])
      : envelope([{ [beeple]: '100000000000' }, { [usdt]: '1' }], { fingerprint: 'next+/=', links: { next: 'https://untrusted.invalid/steal' } }));
    const page2 = await api.fetchTokenBalances('TRON', address, 2, 2);
    expect(page2).toMatchObject({ totalPage: 2, list: [{ symbol: 'TST', holdingAmount: '50000' }] });
    const calls = fetchStub.mock.calls.map(([url]) => new URL(String(url), 'http://local'));
    expect(calls.filter(url => url.pathname.endsWith('/trc20/balance')).map(url => url.searchParams.get('fingerprint'))).toEqual([null, 'next+/=']);
    expect(calls.every(url => url.origin === 'http://local')).toBe(true);
  });

  it('rejects a repeated cursor instead of repeatedly scanning or silently truncating holdings', async () => {
    upstream(undefined, () => envelope([{ [usdt]: '1' }], { fingerprint: 'same' }));
    await expect(api.fetchTokenBalances('TRON', address, 3, 1)).rejects.toMatchObject({ source: 'TronGrid', kind: 'response' });
  });

  it('keeps contracts with missing metadata visible with unknown amounts', async () => {
    upstream(undefined, undefined, envelope([metadata[0]]));
    const result = await api.fetchTokenBalances('TRON', address, 1, 20);
    expect(result.list[0]).toMatchObject({ tokenContractAddress: beeple });
    expect(result.list[0].holdingAmount).toBeUndefined();
    expect(result.warnings?.join(' ')).toMatch(/精度/);
  });

  it.each([{ success: false, data: [] }, envelope([{}]), envelope([{ [usdt]: 'not-a-number' }])])('rejects invalid holding pages: %j', async body => {
    upstream(undefined, () => body);
    await expect(api.fetchTokenBalances('TRON', address, 1, 20)).rejects.toMatchObject({ source: 'TronGrid' });
  });

  it('keeps real empty holdings empty without fetching metadata', async () => {
    upstream(undefined, () => envelope([]));
    expect(await api.fetchTokenBalances('TRON', address, 1, 20)).toMatchObject({ dataSource: 'TronGrid', totalPage: 1, list: [] });
    expect(fetchStub.mock.calls.some(([url]) => String(url).includes('/trc20/info'))).toBe(false);
  });

  it('surfaces a denied fallback with the correct provider key instructions', async () => {
    fetchStub.mockImplementation(async () => new Response('', { status: 401 }));
    await expect(api.fetchAddressAsset('TRON', address)).rejects.toMatchObject({ source: 'TronGrid', code: 401, message: expect.stringContaining('TRONGRID_API_KEY') });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not hide malformed TronScan data behind a fallback', async () => {
    fetchStub.mockResolvedValue(Response.json({ address, balance: 'wrong' }));
    await expect(api.fetchAddressAsset('TRON', address)).rejects.toMatchObject({ source: 'TronScan', kind: 'response' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('preserves an authorized TronScan result without querying a second provider', async () => {
    fetchStub.mockResolvedValue(Response.json({ address, balanceStr: '1234567', totalTransactionCount: 10 }));
    expect(await api.fetchAddressAsset('TRON', address)).toMatchObject({ dataSource: 'TronScan', balance: '1.234567', transactionCount: '10' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'business'])('also falls back for a TronScan 403 %s rejection', async kind => {
    upstream();
    fetchStub.mockResolvedValueOnce(kind === 'http' ? new Response('', { status: 403 }) : Response.json({ code: 403, status: '0' }));
    expect((await api.fetchAddressAsset('TRON', address))?.dataSource).toBe('TronGrid');
  });

  it.each([true, false])('allows the final partial page at the row cap and warns about truncation (upstream has next: %s)', async hasNext => {
    let batch = 0;
    upstream(undefined, () => {
      batch++;
      return envelope(Array.from({ length: 199 }, () => ({ [usdt]: '1' })), hasNext || batch < 26 ? { fingerprint: `cursor-${batch}` } : {});
    });
    const result = await api.fetchTokenBalances('TRON', address, 26, 199);
    expect(result.list).toHaveLength(25);
    expect(result.totalPage).toBe(26);
    expect(result.warnings?.join(' ')).toMatch(/上限/);
    await expect(api.fetchTokenBalances('TRON', address, 27, 199)).rejects.toMatchObject({ source: 'TronGrid' });
  });

  it('stops advertising further pages once the batch budget is reached', async () => {
    let batch = 0;
    upstream(undefined, () => envelope([{ [usdt]: '1' }], { fingerprint: `cursor-${++batch}` }));
    const result = await api.fetchTokenBalances('TRON', address, 250, 1);
    expect(result.totalPage).toBe(250);
    expect(result.warnings?.join(' ')).toMatch(/上限/);
  });
});
