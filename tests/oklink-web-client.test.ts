import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let entity: typeof import('../src/api/oklink/entity');
let client: typeof import('../src/api/oklink/client');
const fetchStub = vi.fn<typeof fetch>();
const address = '0x52908400098527886E0F7030069857D2E4169EE7';
const tronAddress = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_ENTITY_LABEL_SOURCE', 'oklink');
  vi.stubGlobal('__APP_MOCK__', false);
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockReset();
  client = await import('../src/api/oklink/client');
  vi.spyOn(client.rateLimiter, 'acquire').mockResolvedValue();
  entity = await import('../src/api/oklink/entity');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function reply(overrides: Record<string, unknown> = {}) {
  return { chain: 'ETH', address, label: 'Binance. Hot wallet', source: 'OKLink', ...overrides };
}

describe('explicit OKLink website label source', () => {
  it('reads a matching label through the local website service', async () => {
    fetchStub.mockResolvedValue(Response.json(reply()));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).resolves.toBe('Binance. Hot wallet');
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
      `/oklink-web/entity?chain=ETH&address=${address}`,
    ]);
  });

  it.each(['ETH', 'BSC', 'POLYGON', 'TRON'])('accepts explicit null for a matching %s response', async chain => {
    const account = chain === 'TRON' ? tronAddress : address;
    fetchStub.mockResolvedValue(Response.json(reply({ chain, address: account, label: null })));
    await expect(entity.fetchAddressEntityLabel(chain, account)).resolves.toBeNull();
  });

  it('matches EVM address casing without weakening TRON address identity', async () => {
    fetchStub.mockResolvedValue(Response.json(reply({ address: address.toLowerCase() })));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).resolves.toBe('Binance. Hot wallet');
    fetchStub.mockResolvedValue(Response.json(reply({ chain: 'TRON', address: tronAddress.toLowerCase() })));
    await expect(entity.fetchAddressEntityLabel('TRON', tronAddress)).rejects.toMatchObject({ source: 'OKLink', kind: 'response' });
  });

  it.each([
    {}, null, [],
    reply({ chain: 'BSC' }),
    reply({ address: '0x0000000000000000000000000000000000000000' }),
    reply({ source: 'Blockscout' }),
    reply({ label: undefined }),
    reply({ label: 123 }),
    reply({ label: '' }),
    reply({ label: '   ' }),
    reply({ error: { code: 'DENIED', message: 'Website lookup rejected' } }),
  ])('rejects incomplete, conflicting, or mismatched responses: %j', async body => {
    fetchStub.mockResolvedValue(Response.json(body));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).rejects.toMatchObject({ source: 'OKLink' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each(['<!doctype html><h1>Verification required</h1>', '{broken json'])('does not interpret unreadable success content as absent labels', async body => {
    fetchStub.mockResolvedValue(new Response(body, { status: 200 }));
    const error = await entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    expect(error).toBeInstanceOf(client.ChainApiError);
    expect(error).toMatchObject({ source: 'OKLink', code: 'INVALID_RESPONSE', kind: 'response' });
    expect(client.shouldRetryQuery(0, error)).toBe(false);
  });

  it.each([401, 403])('surfaces HTTP %s once without a provider fallback', async status => {
    fetchStub.mockResolvedValue(new Response('<html>private diagnostic</html>', { status }));
    const error = await entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    expect(error).toBeInstanceOf(client.ChainApiError);
    expect(error).toMatchObject({ source: 'OKLink', code: status, kind: 'http' });
    expect(error.message).not.toContain('private diagnostic');
    expect(client.shouldRetryQuery(0, error)).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('keeps a service business error as an error instead of a null label', async () => {
    fetchStub.mockResolvedValue(Response.json({ error: { code: 'BROWSER_UNAVAILABLE', message: '浏览器不可用' } }));
    const error = await entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    expect(error).toMatchObject({ source: 'OKLink', code: 'BROWSER_UNAVAILABLE', kind: 'business' });
    expect(error.message).toContain('浏览器不可用');
    expect(client.shouldRetryQuery(0, error)).toBe(false);
  });

  it('preserves structured service diagnostics on a non-success status', async () => {
    fetchStub.mockResolvedValue(Response.json({ error: { code: 'BROWSER_UNAVAILABLE', message: '请安装 Chrome 后重试' } }, { status: 503 }));
    const error = await entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    expect(error).toMatchObject({ source: 'OKLink', code: 503, kind: 'http' });
    expect(error.message).toContain('请安装 Chrome 后重试');
  });

  it('does not cache a failed request as a confirmed absent label', async () => {
    fetchStub.mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(Response.json(reply()));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).rejects.toMatchObject({ code: 403 });
    await expect(entity.fetchAddressEntityLabel('ETH', address)).resolves.toBe('Binance. Hot wallet');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('reports connection failures as retryable network errors', async () => {
    fetchStub.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    expect(error).toMatchObject({ source: 'OKLink', code: 'NETWORK', kind: 'network' });
    expect(client.shouldRetryQuery(0, error)).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled website lookup after 60 seconds', async () => {
    vi.useFakeTimers();
    fetchStub.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')));
    }));
    const result = entity.fetchAddressEntityLabel('ETH', address).catch(error => error);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ source: 'OKLink', code: 'TIMEOUT', kind: 'network' });
  });

  it.each([['UNKNOWN', address], ['ETH', 'not-an-address'], ['TRON', address]])('rejects invalid lookup arguments (%s, %s) before fetching', async (chain, account) => {
    await expect(entity.fetchAddressEntityLabel(chain, account)).rejects.toBeInstanceOf(client.ChainApiError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('label source selection', () => {
  it.each(['', 'other'])('retains the existing default provider when opt-in is %j', async source => {
    vi.stubEnv('VITE_ENTITY_LABEL_SOURCE', source);
    fetchStub.mockResolvedValue(Response.json({ hash: address, coin_balance: '0', public_tags: [{ address_hash: address, display_name: 'Bittrex: Hot Wallet', label: 'Bittrex' }] }));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).resolves.toBe('Bittrex: Hot Wallet');
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`/blockscout/ETH/api/v2/addresses/${address}`]);
  });

  it('uses TronScan labels by default without querying OKLink', async () => {
    vi.stubEnv('VITE_ENTITY_LABEL_SOURCE', '');
    fetchStub.mockResolvedValue(Response.json({ data: [], contractInfo: { [tronAddress]: { publicTag: 'Binance' } } }));
    await expect(entity.fetchAddressEntityLabel('TRON', tronAddress)).resolves.toBe('Binance');
    expect(String(fetchStub.mock.calls[0][0])).toMatch(/^\/tronscan\/api\/transaction\?/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('keeps mock mode on the existing provider despite an OKLink opt-in', async () => {
    vi.stubGlobal('__APP_MOCK__', true);
    fetchStub.mockResolvedValue(Response.json({ hash: address, coin_balance: '0', has_token_transfers: false }));
    await expect(entity.fetchAddressEntityLabel('ETH', address)).resolves.toBeNull();
    expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`/blockscout/ETH/api/v2/addresses/${address}`]);
  });

  it('reports the source actually selected for the UI', () => {
    expect(entity.getEntityLabelSource('ETH')).toBe('OKLink');
    expect(entity.getEntityLabelSource('BSC')).toBe('OKLink');
    expect(entity.getEntityLabelSource('UNKNOWN')).toBeNull();
    vi.stubGlobal('__APP_MOCK__', true);
    expect(entity.getEntityLabelSource('ETH')).toBe('Blockscout');
    expect(entity.getEntityLabelSource('TRON')).toBe('TronScan');
    expect(entity.getEntityLabelSource('BSC')).toBeNull();
  });
});
