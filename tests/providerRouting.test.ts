import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let api: typeof import('../src/api/oklink/endpoints');
const fetchStub = vi.fn<typeof fetch>();
const address = '0x52908400098527886E0F7030069857D2E4169EE7';

beforeEach(async () => {
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  const { rateLimiter } = await import('../src/api/oklink/client');
  vi.spyOn(rateLimiter, 'acquire').mockResolvedValue();
  api = await import('../src/api/oklink/endpoints');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['ETH', 'POLYGON'])('queries %s assets directly without contacting the retired provider', async chain => {
  fetchStub.mockImplementation(async url => String(url).startsWith('/blockscout/')
    ? Response.json({ hash: address, coin_balance: '100000000000000' })
    : new Response('Forbidden', { status: 403 }));
  expect(await api.fetchAddressAsset(chain, address)).toMatchObject({ balance: '0.0001', dataSource: 'Blockscout' });
  expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([`/blockscout/${chain}/api/v2/addresses/${address}`]);
});

it('propagates a provider outage instead of returning an empty address', async () => {
  fetchStub.mockResolvedValue(new Response('Forbidden', { status: 403 }));
  await expect(api.fetchAddressAsset('ETH', address)).rejects.toMatchObject({ source: 'Blockscout', code: 403 });
  expect(fetchStub).toHaveBeenCalledTimes(1);
});

it('does not offer unsupported BSC queries or make any upstream call for them', async () => {
  expect(api.txListSupported('BSC', 'transaction')).toBe(false);
  await expect(api.fetchAddressAsset('BSC', address)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(api.fetchTokenBalances('BSC', address, 1, 20)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  await expect(api.fetchAddressTransactions('BSC', address, 1, 20)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(fetchStub).not.toHaveBeenCalled();
});
