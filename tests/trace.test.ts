import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAddressTransactions, fetchTokenBalances } from '../src/api/oklink/endpoints';
import type { TxItem } from '../src/api/oklink/schemas';
import { aggregateCounterparties, DEFAULT_TRACE_OPTIONS, fetchTokenMetaMap, TraceEngine } from '../src/trace/engine';

vi.mock('../src/api/oklink/endpoints', () => ({
  fetchAddressTransactions: vi.fn(), fetchTokenBalances: vi.fn(), txListSupported: () => true,
}));
const transactions = vi.mocked(fetchAddressTransactions);
const balances = vi.mocked(fetchTokenBalances);
const opts = { ...DEFAULT_TRACE_OPTIONS, direction: 'both' as const, maxDepth: 2 };
const tx = (overrides: Partial<TxItem> = {}): TxItem => ({
  txId: 'hash', from: 'A', to: 'B', amount: '10', transactionSymbol: 'USDT', tokenContractAddress: 'C1', ...overrides,
});
const meta = new Map([['C1', { symbol: 'USDT', priceUsd: 1 }], ['C2', { symbol: 'USDT', priceUsd: 2 }]]);
const result = (items: TxItem[] = [], totalPage = 1) => ({ transactions: items, totalPage });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  balances.mockResolvedValue({ list: [{ tokenContractAddress: 'C1', symbol: 'USDT', priceUsd: '1' }], totalPage: 1 });
  transactions.mockImplementation(async (_chain, _address, _page, _limit, protocol) => result(protocol === 'token_20' ? [tx()] : []));
});

describe('transfer aggregation', () => {
  it('adds every USD estimate along with amount and count', () => {
    const values = [...aggregateCounterparties([tx(), tx({ amount: '20' })], 'A', 'out', meta).get('B')!.out.values()];
    expect(values).toMatchObject([{ amount: 30, count: 2, usdValue: 30 }]);
  });
  it('keeps equal symbols from different contracts separate', () => {
    const values = [...aggregateCounterparties([tx(), tx({ tokenContractAddress: 'C2' })], 'A', 'out', meta).get('B')!.out.values()];
    expect(values).toMatchObject([{ contract: 'C1', amount: 10, usdValue: 10 }, { contract: 'C2', amount: 10, usdValue: 20 }]);
  });
  it('keeps Base58 contract identity case sensitive', () => {
    const values = [...aggregateCounterparties([
      tx({ tokenContractAddress: 'TAbc' }), tx({ tokenContractAddress: 'Tabc' }),
    ], 'A', 'out', new Map()).get('B')!.out.values()];
    expect(values).toHaveLength(2);
  });
  it('aggregates mixed-case EVM counterparties as one neighbor', () => {
    const grouped = aggregateCounterparties([
      tx({ txId: 'first', from: '0xAa', to: '0xBb' }),
      tx({ txId: 'second', from: '0xaa', to: '0xbb', amount: '20' }),
    ], '0xAA', 'out', meta);
    expect([...grouped.keys()]).toEqual(['0xbb']);
    expect([...grouped.get('0xbb')!.out.values()]).toMatchObject([{ count: 2, amount: 30, usdValue: 30 }]);
  });
  it('keeps Base58 counterparties distinct', () => {
    const grouped = aggregateCounterparties([
      tx({ to: 'TAbc' }), tx({ to: 'Tabc' }),
    ], 'A', 'out', meta);
    expect([...grouped.keys()]).toEqual(['TAbc', 'Tabc']);
  });
  it('keeps missing and blank holding prices unknown', async () => {
    balances.mockResolvedValue({ list: [{ tokenContractAddress: 'C1', priceUsd: '' }, { tokenContractAddress: 'C2' }], totalPage: 1 });
    const prices = await fetchTokenMetaMap('ETH', 'A');
    expect([...prices.values()].map(v => v.priceUsd)).toEqual([null, null]);
  });
});

describe('trace snapshots', () => {
  it('uses one canonical pair for asymmetric EVM histories and their back-edge', async () => {
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => result(protocol === 'token_20'
      ? (address.toLowerCase() === '0xaa'
        ? [tx({ txId: 'h1', from: '0xAa', to: '0xBb' })]
        : [tx({ txId: 'h1', from: '0xaa', to: '0xbb' }), tx({ txId: 'h2', from: '0xbb', to: '0xaa', amount: '20' })])
      : []));
    const engine = new TraceEngine();
    await engine.start('ETH', '0xAa', opts);
    expect(engine.getSnapshot().seed).toBe('0xaa');
    expect(engine.getSnapshot().nodes.map(n => n.address)).toEqual(['0xaa', '0xbb']);
    expect(engine.getSnapshot().edges.map(e => ({ from: e.from, to: e.to, count: e.txCount, usd: e.totalUsd }))).toEqual([
      { from: '0xbb', to: '0xaa', count: 1, usd: 20 },
      { from: '0xaa', to: '0xbb', count: 1, usd: 10 },
    ]);
  });
  it('normalizes mixed-case manual expansion lookups', async () => {
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => result(protocol === 'token_20'
      ? [address.toLowerCase() === '0xaa'
        ? tx({ txId: 'first', from: '0xAa', to: '0xBb' })
        : tx({ txId: 'second', from: '0xbb', to: '0xcc' })]
      : []));
    const engine = new TraceEngine();
    await engine.start('ETH', '0xAa', { ...opts, maxDepth: 1 });
    await engine.expandNode('0xBB', opts);
    expect(engine.getSnapshot().nodes.map(n => n.address)).toEqual(['0xaa', '0xbb', '0xcc']);
    expect(engine.getSnapshot().nodes[1].expanded).toBe(true);
  });
  it('ranks combined mixed-case neighbor flows before applying maxNeighbors', async () => {
    transactions.mockImplementation(async (_c, _a, _p, _l, protocol) => result(protocol === 'token_20' ? [
      tx({ txId: 'first', from: '0xAa', to: '0xBb', amount: '10' }),
      tx({ txId: 'second', from: '0xaa', to: '0xbb', amount: '20' }),
      tx({ txId: 'third', from: '0xAA', to: '0xcc', amount: '25' }),
    ] : []));
    const engine = new TraceEngine();
    await engine.start('ETH', '0xAa', { ...opts, maxDepth: 1, maxNeighbors: 1 });
    expect(engine.getSnapshot().edges).toMatchObject([{ from: '0xaa', to: '0xbb', txCount: 2, totalUsd: 30 }]);
    expect(engine.getSnapshot().edges).toHaveLength(1);
  });
  it('counts an event once when both endpoint histories are expanded', async () => {
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 1, totalUsd: 10, transfers: [{ amount: 10, usdValue: 10 }] }]);
  });
  it('deduplicates checksum variants and optional metadata for the same hashed event', async () => {
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => result(protocol === 'token_20' ? [
      tx(address.toLowerCase() === '0xab' ? { txId: '0xFF', from: '0xAb', to: '0xCd', height: '1', transactionTime: '100' }
        : { txId: '0xff', from: '0xab', to: '0xcd' }),
    ] : []));
    const engine = new TraceEngine();
    await engine.start('ETH', '0xAb', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 1, totalUsd: 10 }]);
    expect(engine.getSnapshot().edges).toHaveLength(1);
  });
  it('does not double count after manually expanding the other endpoint', async () => {
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, maxDepth: 1 });
    await engine.expandNode('B', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 1, totalUsd: 10 }]);
  });
  it('preserves two identical events in one hash without an event index', async () => {
    transactions.mockImplementation(async (_c, _a, _p, _l, protocol) => result(protocol === 'token_20' ? [tx(), tx()] : []));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 2, totalUsd: 20 }]);
  });
  it('merges overlapping indexed pages but preserves distinct log indices', async () => {
    transactions.mockImplementation(async (_c, _a, page, _l, protocol) => result(protocol === 'token_20' ?
      [tx({ eventIndex: '1' }), tx({ eventIndex: String(page + 1) })] : [], 2));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, pagesPerNode: 2 });
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 3, totalUsd: 30 }]);
  });
  it('preserves identical unindexed token events split across stable pages', async () => {
    transactions.mockImplementation(async (_c, _a, _page, _l, protocol) => result(protocol === 'token_20' ? [tx()] : [], 2));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, pagesPerNode: 2 });
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 2, totalUsd: 20 }]);
  });
  it('deduplicates native transactions by hash across overlapping pages', async () => {
    transactions.mockImplementation(async (_c, _a, _page, _l, protocol) => result(protocol === 'transaction'
      ? [tx({ tokenContractAddress: undefined, transactionSymbol: 'ETH' })] : [], 2));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, pagesPerNode: 2 });
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 1, transfers: [{ amount: 10 }] }]);
  });
  it('retains distinct amounts and extra identical events seen only at the second endpoint', async () => {
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => result(protocol === 'token_20'
      ? (address === 'A' ? [tx()] : [tx(), tx(), tx({ amount: '20' })]) : []));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 3, totalUsd: 40, transfers: [{ amount: 40 }] }]);
  });
  it('keeps native value and token logs from the same transaction', async () => {
    transactions.mockImplementation(async (_c, _a, _p, _l, protocol) => result([protocol === 'token_20'
      ? tx() : tx({ tokenContractAddress: undefined, transactionSymbol: 'ETH' })]));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', opts);
    expect(engine.getSnapshot().edges).toMatchObject([{ txCount: 2, totalUsd: 10 }]);
    expect(engine.getSnapshot().edges[0].transfers).toHaveLength(2);
  });
  it('retains unknown native transfers with a positive USD threshold and excludes known low counterparties', async () => {
    transactions.mockImplementation(async (_c, _a, _p, _l, protocol) => result(protocol === 'token_20'
      ? [tx({ to: 'LOW', amount: '0.1' })]
      : [tx({ to: 'NATIVE', tokenContractAddress: undefined, transactionSymbol: 'ETH' })]));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, maxDepth: 1, minUsd: 1 });
    expect(engine.getSnapshot().edges).toMatchObject([{ to: 'NATIVE', transfers: [{ usdValue: null }] }]);
    expect(engine.getSnapshot().edges).toHaveLength(1);
  });
  it('preserves null estimates while merging unknown transfers', async () => {
    balances.mockResolvedValue({ list: [], totalPage: 1 });
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => result(protocol === 'token_20' ? [tx({ txId: address })] : []));
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', opts);
    expect(engine.getSnapshot().edges[0].transfers).toMatchObject([{ amount: 20, usdValue: null }]);
  });
});

describe('run isolation', () => {
  it.each(['success', 'error'] as const)('ignores stale transaction %s after reset and a new run', async (outcome) => {
    const old = deferred<ReturnType<typeof result>>();
    const current = deferred<ReturnType<typeof result>>();
    transactions.mockImplementation(async (_c, address) => address === 'A' ? old.promise : current.promise);
    const engine = new TraceEngine();
    const priorRun = engine.start('ETH', 'A', { ...opts, maxDepth: 1 });
    engine.reset();
    const newRun = engine.start('ETH', 'NEW', opts);
    if (outcome === 'success') old.resolve(result([tx()]));
    else old.reject(new Error('stale failure'));
    await priorRun;
    expect(engine.getSnapshot()).toMatchObject({ seed: 'NEW', running: true, done: 0, error: null, edges: [], nodes: [{ address: 'NEW' }] });
    current.resolve(result());
    await newRun;
  });
  it('ignores stale metadata completion after reset', async () => {
    const pending = deferred<Awaited<ReturnType<typeof fetchTokenBalances>>>();
    const entered = deferred<void>();
    balances.mockImplementation(() => { entered.resolve(); return pending.promise; });
    const engine = new TraceEngine();
    const run = engine.start('ETH', 'A', opts);
    await entered.promise;
    engine.reset();
    pending.resolve({ list: [], totalPage: 1 });
    await run;
    expect(engine.getSnapshot()).toMatchObject({ seed: null, running: false, done: 0, nodes: [], edges: [], error: null, queued: 0 });
  });
  it('does not let stale manual expansion finish a newer run', async () => {
    const engine = new TraceEngine();
    await engine.start('ETH', 'A', { ...opts, maxDepth: 1 });
    const old = deferred<ReturnType<typeof result>>();
    const current = deferred<ReturnType<typeof result>>();
    transactions.mockImplementation(async (_c, address) => address === 'B' ? old.promise : current.promise);
    const expansion = engine.expandNode('B', opts);
    engine.reset();
    const run = engine.start('ETH', 'NEW', opts);
    old.resolve(result([tx()]));
    await expansion;
    expect(engine.getSnapshot()).toMatchObject({ seed: 'NEW', running: true, error: null, nodes: [{ address: 'NEW' }], edges: [] });
    current.resolve(result());
    await run;
  });
  it('allows manual expansion after stopping a run', async () => {
    const pending = deferred<ReturnType<typeof result>>();
    transactions.mockImplementation(async (_c, address, _p, _l, protocol) => address === 'A' ? pending.promise : result(protocol === 'token_20' ? [tx({ from: 'B', to: 'C', txId: 'second' })] : []));
    const engine = new TraceEngine();
    const run = engine.start('ETH', 'A', opts);
    engine.stop();
    pending.resolve(result([tx()]));
    await run;
    await engine.expandNode('A', { ...opts, maxDepth: 1 });
    expect(engine.getSnapshot().nodes.map(n => n.address)).toContain('B');
    expect(engine.getSnapshot().running).toBe(false);
  });
});
