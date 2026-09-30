import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  getHuntWallet,
  getHuntWalletPath,
  listHuntHitPage,
  putHuntWallet,
  putHuntWalletsIfAbsent,
  type HuntWalletRow,
} from '../src/api/db/huntStore';

let nextHunt = 0;

function huntId(): string {
  return `hunt-store-test-${++nextHunt}`;
}

function wallet(huntId: string, address: string, parent: string | null = null, isHit: 0 | 1 = 0): HuntWalletRow {
  return {
    key: `${huntId}|${address}`,
    huntId,
    address,
    parent,
    depth: parent === null ? 0 : 1,
    expanded: 0,
    tag: null,
    isHit,
    path: null,
    updatedAt: 1,
  };
}

describe('putHuntWalletsIfAbsent', () => {
  it('keeps an existing parent while committing new rows on either side of a duplicate', async () => {
    const id = huntId();
    const seed = wallet(id, 'seed');
    const existing = wallet(id, 'existing', 'seed');
    await putHuntWallet(seed);
    await putHuntWallet(existing);

    const before = wallet(id, 'before', 'existing');
    const replacement = wallet(id, 'existing', 'wrong-parent');
    const after = wallet(id, 'after', 'before');
    const inserted = await putHuntWalletsIfAbsent([before, replacement, after]);

    expect(inserted.map((row) => row.address)).toEqual(['before', 'after']);
    expect(await getHuntWallet(id, 'existing')).toEqual(existing);
    expect(await getHuntWallet(id, 'before')).toEqual(before);
    expect(await getHuntWallet(id, 'after')).toEqual(after);
    expect(await getHuntWalletPath(id, 'after')).toEqual(['seed', 'existing', 'before', 'after']);
  });

  it('inserts a key once when it occurs twice in the same batch', async () => {
    const id = huntId();
    const first = wallet(id, 'duplicate', 'first-parent');
    const second = wallet(id, 'duplicate', 'second-parent');
    const tail = wallet(id, 'tail', 'duplicate');

    const inserted = await putHuntWalletsIfAbsent([first, second, tail]);

    expect(inserted.map((row) => row.address)).toEqual(['duplicate', 'tail']);
    expect(await getHuntWallet(id, 'duplicate')).toEqual(first);
    expect(await getHuntWallet(id, 'tail')).toEqual(tail);
  });

  it('rejects and rolls back the batch when a row cannot be cloned', async () => {
    const id = huntId();
    const valid = wallet(id, 'valid');
    const invalid = { ...wallet(id, 'invalid'), path: [() => 'uncloneable'] } as unknown as HuntWalletRow;

    await expect(putHuntWalletsIfAbsent([valid, invalid])).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await getHuntWallet(id, 'valid')).toBeUndefined();
  });

  it('rejects when the transaction aborts after an add request succeeds', async () => {
    const id = huntId();
    const row = wallet(id, 'abort-after-success');
    const originalAdd = IDBObjectStore.prototype.add;
    let addSucceeded = false;
    const addSpy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
      if ((value as HuntWalletRow).key === row.key) {
        request.addEventListener('success', () => {
          addSucceeded = true;
          this.transaction.abort();
        }, { once: true });
      }
      return request;
    });

    try {
      await expect(putHuntWalletsIfAbsent([row])).rejects.toThrow();
      expect(addSucceeded).toBe(true);
      expect(await getHuntWallet(id, 'abort-after-success')).toBeUndefined();
    } finally {
      addSpy.mockRestore();
    }
  });
});

describe('listHuntHitPage', () => {
  it('returns consecutive pages in key order with the same filtered total', async () => {
    const id = huntId();
    const otherId = huntId();
    const hits = Array.from({ length: 25 }, (_, i) => wallet(id, `hit-${String(i).padStart(2, '0')}`, null, 1));
    await putHuntWalletsIfAbsent([...hits.reverse(), wallet(id, 'not-hit'), wallet(otherId, 'foreign-hit', null, 1)]);

    const first = await listHuntHitPage(id, 0, 10);
    const second = await listHuntHitPage(id, 10, 10);
    const last = await listHuntHitPage(id, 20, 10);
    const beyond = await listHuntHitPage(id, 30, 10);

    expect(first).toMatchObject({ total: 25 });
    expect(first.rows.map((row) => row.address)).toEqual([
      'hit-00', 'hit-01', 'hit-02', 'hit-03', 'hit-04',
      'hit-05', 'hit-06', 'hit-07', 'hit-08', 'hit-09',
    ]);
    expect(second.total).toBe(25);
    expect(second.rows.map((row) => row.address)).toEqual([
      'hit-10', 'hit-11', 'hit-12', 'hit-13', 'hit-14',
      'hit-15', 'hit-16', 'hit-17', 'hit-18', 'hit-19',
    ]);
    expect(last.total).toBe(25);
    expect(last.rows.map((row) => row.address)).toEqual(['hit-20', 'hit-21', 'hit-22', 'hit-23', 'hit-24']);
    expect(beyond).toEqual({ rows: [], total: 25 });
  });
});
