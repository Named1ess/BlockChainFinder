import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, preview, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerMockPlugin } from '../mock/providerMock';
import { DEMO_A, DEMO_B, DEMO_C, DEMO_E } from '../src/demo';

const localFetch = globalThis.fetch;
let vite: ViteDevServer;
let http: Server;
let origin: string;
let api: typeof import('../src/api/blockscout');

beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    plugins: [providerMockPlugin()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  http = createHttpServer(vite.middlewares);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.resetModules();
  // Only local HTTP is allowed: the production parser still consumes real middleware responses.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (!path.startsWith('/blockscout/') && !path.startsWith('/tronscan/')) {
      throw new Error(`Demo attempted an unexpected request: ${path}`);
    }
    return localFetch(`${origin}${path}`, init);
  });
  const { rateLimiter } = await import('../src/api/oklink/client');
  vi.spyOn(rateLimiter, 'acquire').mockResolvedValue();
  api = await import('../src/api/blockscout');
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  await vite.close();
});

describe('offline provider demo', () => {
  it.each([['ETH', 'ETH'], ['POLYGON', 'POL']])('parses %s demo transfers through the real provider adapter', async (chain, symbol) => {
    const sent = await api.fetchBlockscoutTransactions(chain, DEMO_A, 1, 20, 'transaction');
    const received = await api.fetchBlockscoutTransactions(chain, DEMO_B, 1, 20, 'transaction');

    expect(sent.transactions).toContainEqual(expect.objectContaining({ from: DEMO_A, to: DEMO_B, amount: '2.5', transactionSymbol: symbol }));
    expect(received.transactions).toContainEqual(expect.objectContaining({
      txId: sent.transactions.find(tx => tx.to === DEMO_B)!.txId,
      from: DEMO_A, to: DEMO_B, amount: '2.5', transactionSymbol: symbol,
    }));
    expect(sent).toMatchObject({ dataSource: 'Blockscout', totalPage: 1 });
  });

  it('parses demo assets, token transfers, holdings and public labels without an upstream server', async () => {
    const asset = await api.fetchBlockscoutAsset('ETH', DEMO_A);
    const tokens = await api.fetchBlockscoutTransactions('ETH', DEMO_A, 1, 20, 'token_20');
    const holdings = await api.fetchBlockscoutTokenBalances('ETH', DEMO_A, 1, 20);
    const label = await api.fetchBlockscoutEntityLabel('ETH', DEMO_E);
    const unlabeled = await api.fetchBlockscoutEntityLabel('ETH', DEMO_A);

    expect(asset).toMatchObject({ address: DEMO_A, balance: '12.5', balanceSymbol: 'ETH' });
    expect(tokens.transactions).toContainEqual(expect.objectContaining({ from: DEMO_A, to: DEMO_C, amount: '12000', transactionSymbol: 'USDT' }));
    expect(holdings.list).toContainEqual(expect.objectContaining({ symbol: 'USDT', holdingAmount: '25000', priceUsd: '1' }));
    expect(label).toBe('演示交易所 Binance（模拟标签）');
    expect(unlabeled).toBeNull();
  });

  it('keeps demo pagination and internal transfers usable by the production parser', async () => {
    const first = await api.fetchBlockscoutTransactions('ETH', DEMO_A, 1, 1);
    const second = await api.fetchBlockscoutTransactions('ETH', DEMO_A, 2, 1);
    const internal = await api.fetchBlockscoutTransactions('ETH', DEMO_A, 1, 20, 'internal');

    expect(first).toMatchObject({ totalPage: 2, transactions: [{ from: DEMO_A, to: DEMO_B }] });
    expect(second).toMatchObject({ totalPage: 2, transactions: [{ from: DEMO_C, to: DEMO_A }] });
    expect(internal.transactions).toContainEqual(expect.objectContaining({ from: DEMO_A, to: DEMO_B, amount: '0.25', state: 'success' }));
  });

  it('also serves offline provider data in Vite preview', async () => {
    const previewServer = await preview({
      configFile: false,
      plugins: [providerMockPlugin()],
      // The provider middleware must run before static serving; no bundle is needed for this request.
      build: { outDir: 'mock' },
      preview: { host: '127.0.0.1', port: 0 },
    });
    const devOrigin = origin;
    origin = `http://127.0.0.1:${(previewServer.httpServer.address() as AddressInfo).port}`;
    try {
      const result = await api.fetchBlockscoutTransactions('ETH', DEMO_A, 1, 20);
      expect(result.transactions).toContainEqual(expect.objectContaining({ from: DEMO_A, to: DEMO_B, amount: '2.5' }));
      for (const path of ['/tronscan/api/account', '/trongrid/v1/accounts/TExample', '/oklink-web/entity?chain=ETH&address=0x123']) {
        const unsupported = await localFetch(`${origin}${path}`);
        expect(unsupported.status).toBe(501);
      }
    } finally {
      origin = devOrigin;
      await previewServer.close();
    }
  });

  it.each(['/tronscan/api/account?address=TExample', '/trongrid/v1/accounts/TExample', '/blockscout/BSC/api/v2/addresses/0x123', '/blockscout/ETH/api/v2/unknown', '/oklink-web/entity?chain=ETH&address=0x123'])('rejects unsupported demo requests at %s locally', async path => {
    const response = await localFetch(`${origin}${path}`);
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/演示.*不支持/) });
  });
});
