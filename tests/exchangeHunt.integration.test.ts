import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAddressTransactions, fetchTokenBalances } from '../src/api/oklink/endpoints';
import { fetchAddressEntityLabel } from '../src/api/oklink/entity';
import { getHuntWallet, listHuntHitPage, listHuntRuns } from '../src/api/db/huntStore';
import type { TxItem } from '../src/api/oklink/schemas';
import { DEFAULT_HUNT_OPTIONS, ExchangeHuntEngine } from '../src/trace/exchangeHunt';

vi.mock('../src/api/oklink/endpoints', () => ({
  fetchAddressTransactions: vi.fn(),
  fetchTokenBalances: vi.fn(),
}));
vi.mock('../src/api/oklink/entity', () => ({ fetchAddressEntityLabel: vi.fn() }));

function transfer(txId: string, from: string, to: string, amount: string): TxItem {
  return { txId, from, to, amount, transactionSymbol: 'USDT', tokenContractAddress: 'token', state: 'success' };
}

function serveTransfers(transfers: TxItem[], exchange: string): void {
  vi.mocked(fetchAddressTransactions).mockImplementation(async (_chain, address, _page, _limit, protocol) => ({
    transactions: protocol === 'token_20' ? transfers.filter((tx) => tx.from === address || tx.to === address) : [],
    totalPage: 1,
  }));
  vi.mocked(fetchAddressEntityLabel).mockImplementation(async (_chain, address) =>
    address === exchange ? 'Binance. Hot wallet' : null,
  );
}

beforeEach(() => {
  vi.mocked(fetchTokenBalances).mockResolvedValue({
    list: [{ tokenContractAddress: 'token', symbol: 'USDT', priceUsd: '1' }],
    totalPage: 1,
  });
});

describe('exchange search with real aggregation and IndexedDB persistence', () => {
  it('stores one canonical EVM seed and does not rediscover it from a peer', async () => {
    const seed = '0x52908400098527886E0F7030069857D2E4169EE7';
    const peer = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
    const canonicalSeed = seed.toLowerCase();
    const canonicalPeer = peer.toLowerCase();
    vi.mocked(fetchAddressTransactions).mockImplementation(async (_chain, address, _page, _limit, protocol) => ({
      transactions: protocol === 'token_20' && [canonicalSeed, canonicalPeer].includes(address.toLowerCase())
        ? [transfer('first', seed, peer, '10')] : [],
      totalPage: 1,
    }));
    vi.mocked(fetchAddressEntityLabel).mockImplementation(async (_chain, address) =>
      address.toLowerCase() === canonicalPeer ? 'Binance. Hot wallet' : null,
    );
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', seed, { ...DEFAULT_HUNT_OPTIONS, hitLimit: 10 });
    const snapshot = engine.getSnapshot();
    expect(snapshot).toMatchObject({ seed: canonicalSeed, scanned: 2, tagChecked: 2, depth: 2 });
    expect(await getHuntWallet(snapshot.runId!, seed)).toBeUndefined();
    expect(await getHuntWallet(snapshot.runId!, canonicalSeed)).toMatchObject({ address: canonicalSeed, depth: 0, parent: null, expanded: 1 });
    expect(await getHuntWallet(snapshot.runId!, canonicalPeer)).toMatchObject({
      address: canonicalPeer, depth: 1, parent: canonicalSeed, path: [canonicalSeed, canonicalPeer], expanded: 1,
    });
    expect((await listHuntRuns()).find(run => run.id === snapshot.runId)?.seed).toBe(canonicalSeed);
  });

  it('preserves Base58 seed and path casing through persistence', async () => {
    const seed = 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8';
    const peer = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
    serveTransfers([transfer('first', seed, peer, '10')], peer);
    const engine = new ExchangeHuntEngine();
    await engine.start('TRON', seed, { ...DEFAULT_HUNT_OPTIONS, hitLimit: 10 });
    const snapshot = engine.getSnapshot();
    expect(snapshot).toMatchObject({ seed, scanned: 2, tagChecked: 2 });
    expect(await getHuntWallet(snapshot.runId!, seed)).toMatchObject({ address: seed, depth: 0, parent: null });
    expect(await getHuntWallet(snapshot.runId!, peer)).toMatchObject({ parent: seed, path: [seed, peer] });
  });

  it('keeps a new exchange branch when two parents share an already discovered neighbor', async () => {
    serveTransfers([
      transfer('sa', 'seed', 'A', '10'),
      transfer('sb', 'seed', 'B', '9'),
      transfer('ac', 'A', 'C', '8'),
      transfer('bc', 'B', 'C', '7'),
      transfer('bd', 'B', 'D', '6'),
    ], 'D');
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, hitLimit: 1 });
    const snapshot = engine.getSnapshot();
    const hits = await listHuntHitPage(snapshot.runId!, 0, 10);

    expect(hits.rows.map((row) => ({ address: row.address, path: row.path, depth: row.depth })))
      .toEqual([{ address: 'D', path: ['seed', 'B', 'D'], depth: 2 }]);
    expect(snapshot.hitCount).toBe(1);
    expect((await getHuntWallet(snapshot.runId!, 'C'))?.parent).toBe('A');
  });

  it('ranks neighbors by all transfers so a larger cumulative exchange flow survives pruning', async () => {
    serveTransfers([
      transfer('first', 'seed', 'exchange', '10'),
      transfer('second', 'seed', 'exchange', '20'),
      transfer('other', 'seed', 'decoy', '25'),
    ], 'exchange');
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, maxNeighbors: 1, hitLimit: 1 });
    const hits = await listHuntHitPage(engine.getSnapshot().runId!, 0, 10);

    expect(hits.rows.map((row) => row.path)).toEqual([['seed', 'exchange']]);
  });
});
