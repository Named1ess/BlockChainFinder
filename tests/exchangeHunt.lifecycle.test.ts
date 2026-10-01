import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAddressTransactions, fetchTokenBalances } from '../src/api/oklink/endpoints';
import { fetchAddressEntityLabel } from '../src/api/oklink/entity';
import { OklinkApiError } from '../src/api/oklink/client';
import * as store from '../src/api/db/huntStore';
import type { TxItem } from '../src/api/oklink/schemas';
import { DEFAULT_HUNT_OPTIONS, ExchangeHuntEngine } from '../src/trace/exchangeHunt';

vi.mock('../src/api/oklink/endpoints', () => ({
  fetchAddressTransactions: vi.fn(),
  fetchTokenBalances: vi.fn(),
}));
vi.mock('../src/api/oklink/entity', () => ({ fetchAddressEntityLabel: vi.fn() }));

const transfer: TxItem = {
  txId: 'seed-to-peer', from: 'seed', to: 'peer', amount: '10',
  transactionSymbol: 'USDT', tokenContractAddress: 'token', state: 'success',
};

function servePeer(label: string | null = null): void {
  vi.mocked(fetchAddressTransactions).mockImplementation(async (_chain, address, _page, _limit, protocol) => ({
    transactions: protocol === 'token_20' && ['seed', 'peer'].includes(address) ? [transfer] : [],
    totalPage: 1,
  }));
  vi.mocked(fetchAddressEntityLabel).mockImplementation(async (_chain, address) => address === 'peer' ? label : null);
}

beforeEach(() => {
  vi.mocked(fetchAddressTransactions).mockReset().mockResolvedValue({ transactions: [], totalPage: 1 });
  vi.mocked(fetchAddressEntityLabel).mockReset().mockResolvedValue(null);
  vi.mocked(fetchTokenBalances).mockReset().mockResolvedValue({ list: [], totalPage: 1 });
});

describe('search terminal state persistence', () => {
  it.each([
    { label: null, hitLimit: 10, maxWallets: 10, want: 'exhausted' },
    { label: 'Binance. Hot wallet', hitLimit: 10, maxWallets: 10, want: 'exhausted' },
    { label: null, hitLimit: 10, maxWallets: 1, want: 'wallet-cap' },
    { label: 'Binance. Hot wallet', hitLimit: 1, maxWallets: 10, want: 'hit-target' },
  ])('keeps $want after final cleanup (label=$label)', async ({ label, hitLimit, maxWallets, want }) => {
    servePeer(label);
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, hitLimit, maxWallets });
    const snapshot = engine.getSnapshot();
    const row = await store.getHuntRun(snapshot.runId!);
    expect(row).toMatchObject({ status: want, finishedAt: expect.any(Number) });
    expect(snapshot).toMatchObject({ running: false, pending: 0, status: want });
  });

  it('preserves the seed-is-exchange reason', async () => {
    vi.mocked(fetchAddressEntityLabel).mockResolvedValue('Binance. Hot wallet');
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    expect(await store.getHuntRun(engine.getSnapshot().runId!)).toMatchObject({ status: 'seed-is-exchange', hitCount: 1 });
  });

  it('reports wallet-cap when the limit leaves a sibling unexpanded and the earlier sibling has no new peers', async () => {
    const seedTransfers = [transfer, { ...transfer, txId: 'seed-to-unsearched', to: 'unsearched' }];
    vi.mocked(fetchAddressTransactions).mockImplementation(async (_chain, address, _page, _limit, protocol) => ({
      transactions: protocol === 'token_20'
        ? seedTransfers.filter((tx) => tx.from === address || tx.to === address) : [],
      totalPage: 1,
    }));
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, maxWallets: 2 });
    const snapshot = engine.getSnapshot();
    expect(await store.getHuntRun(snapshot.runId!)).toMatchObject({ status: 'wallet-cap', scanned: 2 });
    expect(await store.getHuntWallet(snapshot.runId!, 'unsearched')).toMatchObject({ expanded: 0 });
  });

  it('clears running and exposes initial storage errors so another search can start', async () => {
    vi.spyOn(store, 'saveHuntRun').mockRejectedValueOnce(new Error('storage unavailable'));
    const engine = new ExchangeHuntEngine();
    await expect(engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS)).resolves.toBeUndefined();
    const failed = engine.getSnapshot();
    expect(failed).toMatchObject({ running: false, status: 'failed', error: expect.stringContaining('storage unavailable') });
    expect(await store.getHuntRun(failed.runId!)).toMatchObject({ status: 'failed', finishedAt: expect.any(Number) });
    await engine.start('ETH', 'other', DEFAULT_HUNT_OPTIONS);
    expect(engine.getSnapshot()).toMatchObject({ seed: 'other', running: false, status: 'exhausted' });
    expect(engine.getSnapshot().runId).not.toBe(failed.runId);
  });

  it('records fatal wallet storage errors as failed instead of running', async () => {
    vi.spyOn(store, 'putHuntWallet').mockRejectedValueOnce(new Error('wallet write failed'));
    const engine = new ExchangeHuntEngine();
    await expect(engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS)).resolves.toBeUndefined();
    expect(await store.getHuntRun(engine.getSnapshot().runId!)).toMatchObject({
      status: 'failed', error: expect.stringContaining('wallet write failed'), finishedAt: expect.any(Number),
    });
    expect(engine.getSnapshot()).toMatchObject({ running: false, pending: 0 });
  });

  it('surfaces a final persistence failure without leaving the engine running', async () => {
    const realSave = store.saveHuntRun;
    vi.spyOn(store, 'saveHuntRun').mockImplementation(async (row) => {
      if (row.status !== 'running') throw new Error('disk full');
      await realSave(row);
    });
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    expect(engine.getSnapshot()).toMatchObject({ running: false, status: 'failed', error: expect.stringContaining('disk full') });
  });

  it('keeps a manual stop made while the seed label is loading', async () => {
    let release!: (value: string | null) => void;
    const labelReady = new Promise<string | null>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredRequest = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(fetchAddressEntityLabel).mockImplementation(() => { entered(); return labelReady; });
    const engine = new ExchangeHuntEngine();
    const task = engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    await enteredRequest;
    engine.stop();
    release(null);
    await task;
    expect(await store.getHuntRun(engine.getSnapshot().runId!)).toMatchObject({ status: 'stopped', finishedAt: expect.any(Number) });
  });
});

describe('failed requests remain unknown and retryable', () => {
  it('does not repeat forbidden transaction requests during a search', async () => {
    vi.mocked(fetchAddressTransactions).mockRejectedValue(new OklinkApiError(403, 'denied', { kind: 'http' }));
    const engine = new ExchangeHuntEngine();
    await engine.start('BSC', 'seed', DEFAULT_HUNT_OPTIONS);
    expect(engine.getSnapshot()).toMatchObject({ status: 'partial', failedRequests: 1 });
    expect(fetchAddressTransactions).toHaveBeenCalledTimes(2); // 各查询一次普通/代币交易，不追加拒绝请求。
  });
  it('retries a transient label failure and preserves the recovered exchange hit', async () => {
    vi.mocked(fetchAddressEntityLabel).mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValue('Binance. Hot wallet');
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    expect(engine.getSnapshot()).toMatchObject({ status: 'seed-is-exchange', failedRequests: 0, hitCount: 1 });
    expect(await store.getHuntWallet(engine.getSnapshot().runId!, 'seed')).toMatchObject({ tag: 'Binance. Hot wallet', isHit: 1 });
  });

  it('leaves failed labels unconfirmed and persists partial status', async () => {
    vi.mocked(fetchAddressEntityLabel).mockRejectedValue(new Error('label service down'));
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    const snapshot = engine.getSnapshot();
    expect(snapshot).toMatchObject({ running: false, status: 'partial', failedRequests: 1, tagChecked: 0 });
    expect(await store.getHuntRun(snapshot.runId!)).toMatchObject({ status: 'partial', failedRequests: 1 });
    expect(await store.getHuntWallet(snapshot.runId!, 'seed')).toMatchObject({
      tag: null, isHit: 0, tagError: expect.stringContaining('label service down'),
    });
  });

  it('does not treat an error with an empty message as a confirmed absent tag', async () => {
    vi.mocked(fetchAddressEntityLabel).mockRejectedValue(new Error(''));
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    const snapshot = engine.getSnapshot();
    expect(snapshot.tagChecked).toBe(0);
    expect(await store.getHuntWallet(snapshot.runId!, 'seed')).toMatchObject({ tag: null, tagError: expect.any(String) });
  });

  it('retries failed transaction fetches before concluding there are no peers', async () => {
    servePeer('Binance. Hot wallet');
    vi.mocked(fetchAddressTransactions).mockRejectedValueOnce(new Error('temporary transaction failure'));
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, hitLimit: 1 });
    expect(engine.getSnapshot()).toMatchObject({ status: 'hit-target', failedRequests: 0, hitCount: 1 });
  });

  it('does not mark failed expansions as fully searched or exhausted', async () => {
    vi.mocked(fetchAddressTransactions).mockRejectedValue(new Error('transaction service down'));
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', DEFAULT_HUNT_OPTIONS);
    const snapshot = engine.getSnapshot();
    expect(snapshot).toMatchObject({ running: false, status: 'partial', failedRequests: 1 });
    expect(await store.getHuntWallet(snapshot.runId!, 'seed')).toMatchObject({
      expanded: 0, expansionError: expect.stringContaining('transaction service down'),
    });
    expect(await store.getHuntRun(snapshot.runId!)).toMatchObject({ status: 'partial', failedRequests: 1 });
  });

  it('retains successful transfer data when another protocol fails', async () => {
    servePeer('Binance. Hot wallet');
    vi.mocked(fetchAddressTransactions).mockImplementation(async (_chain, _address, _page, _limit, protocol) => {
      if (protocol === 'transaction') throw new Error('native endpoint down');
      return { transactions: [transfer], totalPage: 1 };
    });
    const engine = new ExchangeHuntEngine();
    await engine.start('ETH', 'seed', { ...DEFAULT_HUNT_OPTIONS, hitLimit: 1 });
    expect(engine.getSnapshot()).toMatchObject({ status: 'partial', failedRequests: 1, hitCount: 1 });
    expect((await store.listHuntHitPage(engine.getSnapshot().runId!, 0, 10)).rows).toHaveLength(1);
  });
});
