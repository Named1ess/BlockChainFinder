import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, preview } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OklinkBrowser, OklinkWebError, oklinkWebPlugin } from '../server/oklinkWeb';

const localFetch = globalThis.fetch;
const address = '0xFBb1b73C4f0BDa4f67dcA266ce6Ef42f520fBB98';
const noLabelAddress = '0x0000000000000000000000000000000000000001';
const deniedAddress = '0x0000000000000000000000000000000000000002';
const label = 'Exchange: Bittrex Global';

function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe.each(['dev', 'preview'] as const)('OKLink website HTTP middleware in Vite %s', mode => {
  let origin: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    if (mode === 'dev') {
      const vite = await createServer({
        configFile: false,
        plugins: [oklinkWebPlugin()],
        server: { middlewareMode: true, hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      const server = createHttpServer(vite.middlewares);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = async () => {
        try { await closeHttp(server); }
        finally { await vite.close(); }
      };
    } else {
      const server = await preview({
        configFile: false,
        plugins: [oklinkWebPlugin()],
        // An existing directory is sufficient: the API runs before static serving.
        build: { outDir: 'mock' },
        preview: { host: '127.0.0.1', port: 0 },
      });
      origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
      close = () => server.close();
    }
  });

  beforeEach(() => {
    // Replace only the external website lookup; requests still cross real HTTP and Vite.
    vi.spyOn(OklinkBrowser.prototype, 'search').mockResolvedValue(label);
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await close?.(); });

  function get(path: string, init?: RequestInit) {
    return localFetch(`${origin}${path}`, init);
  }

  it('returns the requested address, chain, source, and website label', async () => {
    const response = await get(`/oklink-web/entity?chain=ETH&address=${address}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ chain: 'ETH', address, source: 'OKLink', label });
    expect(OklinkBrowser.prototype.search).toHaveBeenCalledExactlyOnceWith({ chain: 'ETH', address });
  });

  it('returns an explicit null only when the website lookup succeeds without a label', async () => {
    vi.mocked(OklinkBrowser.prototype.search).mockResolvedValue(null);
    const response = await get(`/oklink-web/entity?chain=ETH&address=${noLabelAddress}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ chain: 'ETH', address: noLabelAddress, source: 'OKLink', label: null });
  });

  it.each([
    '',
    `chain=BTC&address=${address}`,
    `chain=__proto__&address=${address}`,
    'chain=ETH&address=not-an-address',
    'chain=ETH&address=https%3A%2F%2Fexample.com',
    `chain=TRON&address=${address}`,
  ])('rejects invalid lookup parameters without opening the website: %s', async query => {
    const response = await get(`/oklink-web/entity?${query}`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 400, message: expect.any(String) } });
    expect(OklinkBrowser.prototype.search).not.toHaveBeenCalled();
  });

  it('rejects POST before performing a website lookup', async () => {
    const response = await get(`/oklink-web/entity?chain=ETH&address=${address}`, { method: 'POST' });
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 405 } });
    expect(OklinkBrowser.prototype.search).not.toHaveBeenCalled();
  });

  it('returns a JSON 404 for an unknown helper endpoint', async () => {
    const response = await get('/oklink-web/unknown');
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 404 } });
    expect(OklinkBrowser.prototype.search).not.toHaveBeenCalled();
  });

  it('rejects cross-site callers without performing a website lookup', async () => {
    const response = await get(`/oklink-web/entity?chain=ETH&address=${address}`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 403 } });
    expect(OklinkBrowser.prototype.search).not.toHaveBeenCalled();
  });

  it('preserves upstream 403 as an error and allows a later successful lookup', async () => {
    vi.mocked(OklinkBrowser.prototype.search)
      .mockRejectedValueOnce(new OklinkWebError(403, 'OKLink refused the website lookup'))
      .mockResolvedValueOnce(label);
    const path = `/oklink-web/entity?chain=ETH&address=${deniedAddress}`;
    const rejected = await get(path);
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({ error: { code: 403, message: 'OKLink refused the website lookup' } });
    const recovered = await get(path);
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ chain: 'ETH', address: deniedAddress, source: 'OKLink', label });
    expect(OklinkBrowser.prototype.search).toHaveBeenCalledTimes(2);
  });
});
