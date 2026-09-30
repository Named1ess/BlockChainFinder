import { beforeEach, expect, it, vi } from 'vitest';
import { pageApiFetch, tronscanFetch } from '../src/api/oklink/client';
import { fetchAddressTransactions } from '../src/api/oklink/endpoints';

vi.mock('../src/api/oklink/client', () => ({ pageApiFetch: vi.fn(), tronscanFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('preserves OKLink transfer log indices including zero', async () => {
  vi.mocked(pageApiFetch).mockResolvedValue({ hits: [{ txhash: 'hash', logIndex: 0 }, { txhash: 'hash', logIndex: 1 }], total: 2 });
  const result = await fetchAddressTransactions('ETH', 'A', 1, 50, 'token_20');
  expect(result.transactions.map(t => t.eventIndex)).toEqual(['0', '1']);
});

it('preserves TronScan transfer event indices', async () => {
  vi.mocked(tronscanFetch).mockResolvedValue({ token_transfers: [{ transaction_id: 'hash', event_index: 0 }, { transaction_id: 'hash', event_index: 1 }], total: 2 });
  const result = await fetchAddressTransactions('TRON', 'A', 1, 50, 'token_20');
  expect(result.transactions.map(t => t.eventIndex)).toEqual(['0', '1']);
});
