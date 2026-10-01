import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { getHuntRun, getHuntWallet, putHuntWallet, saveHuntRun } from '../src/api/db/huntStore';

it.each(['run', 'wallet'] as const)('rejects a %s write when its transaction aborts after request success', async (kind) => {
  const originalPut = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = originalPut.call(this, value, key);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  });

  const write = kind === 'run'
    ? saveHuntRun({
        id: 'aborted-run', chain: 'ETH', seed: 'seed', startedAt: 1, finishedAt: 2, status: 'exhausted',
        maxWallets: 120, maxNeighbors: 10, hitLimit: 1, tokenFilter: [], scanned: 1, tagChecked: 1,
        depth: 1, hitCount: 0, firstHitDepth: null, error: null,
      })
    : putHuntWallet({
        key: 'aborted-run|seed', huntId: 'aborted-run', address: 'seed', parent: null, depth: 0,
        expanded: 0, tag: null, isHit: 0, path: null, updatedAt: 1,
      });

  await expect(write).rejects.toMatchObject({ name: 'AbortError' });
  expect(await getHuntRun('aborted-run')).toBeUndefined();
  expect(await getHuntWallet('aborted-run', 'seed')).toBeUndefined();
});
