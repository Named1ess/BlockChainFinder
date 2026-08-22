/**
 * 盒武器搜索的本地持久化层（IndexedDB）。
 *
 * 设计目标：搜索过程流式落库，内存只保留计数器与当前层队列，
 * 上万钱包也不会撑爆内存。所有钱包、标签、命中与资金路径即产即写，
 * UI 通过分页查询读取，并支持回看历史搜索。
 *
 * 结构：
 *   runs    —— 一次搜索一条记录（参数、状态、统计）
 *   wallets —— 每个发现的钱包一条记录（父指针、深度、标签、命中、路径）
 */

export interface HuntRunRow {
  id: string;
  chain: string;
  seed: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'hit-target' | 'stopped' | 'exhausted' | 'wallet-cap' | 'seed-is-exchange';
  maxWallets: number;
  maxNeighbors: number;
  hitLimit: number;
  /** 币种过滤（空数组 = 不过滤） */
  tokenFilter: string[] | null;
  scanned: number;
  tagChecked: number;
  depth: number;
  hitCount: number;
  firstHitDepth: number | null;
  error: string | null;
}

export interface HuntWalletRow {
  /** 主键：`${huntId}|${address}` */
  key: string;
  huntId: string;
  address: string;
  /** 父钱包地址（种子为 null） */
  parent: string | null;
  /** 距种子的跳数 */
  depth: number;
  expanded: 0 | 1;
  /** 交易所标签原文（未检查为 null，非交易所为 ''） */
  tag: string | null;
  isHit: 0 | 1;
  /** 命中时回溯好的完整资金路径 seed -> ... -> 本地址 */
  path: string[] | null;
  updatedAt: number;
}

const DB_NAME = 'chainfinder';
const DB_VERSION = 1;
const RUNS = 'runs';
const WALLETS = 'wallets';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS)) {
        const s = db.createObjectStore(RUNS, { keyPath: 'id' });
        s.createIndex('byStartedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains(WALLETS)) {
        const s = db.createObjectStore(WALLETS, { keyPath: 'key' });
        s.createIndex('byHunt', 'huntId');
        s.createIndex('byHuntHit', ['huntId', 'isHit']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function walletKey(huntId: string, address: string): string {
  return `${huntId}|${address}`;
}

/* ---------------- runs ---------------- */

export async function saveHuntRun(run: HuntRunRow): Promise<void> {
  const db = await openDB();
  const store = db.transaction(RUNS, 'readwrite').objectStore(RUNS);
  await req(store.put(run));
}

export async function getHuntRun(id: string): Promise<HuntRunRow | undefined> {
  const db = await openDB();
  const store = db.transaction(RUNS, 'readonly').objectStore(RUNS);
  return req(store.get(id));
}

export async function listHuntRuns(limit = 30): Promise<HuntRunRow[]> {
  const db = await openDB();
  const store = db.transaction(RUNS, 'readonly').objectStore(RUNS);
  const index = store.index('byStartedAt');
  const out: HuntRunRow[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursorReq = index.openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) {
        resolve();
        return;
      }
      out.push(cursor.value as HuntRunRow);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  return out;
}

/* ---------------- wallets ---------------- */

export async function getHuntWallet(huntId: string, address: string): Promise<HuntWalletRow | undefined> {
  const db = await openDB();
  const store = db.transaction(WALLETS, 'readonly').objectStore(WALLETS);
  return req(store.get(walletKey(huntId, address)));
}

export async function putHuntWallet(row: HuntWalletRow): Promise<void> {
  const db = await openDB();
  const store = db.transaction(WALLETS, 'readwrite').objectStore(WALLETS);
  await req(store.put(row));
}

/**
 * 批量插入「不存在时才写入」的钱包行（单个事务，减少开销）。
 * 返回实际新插入的行；已存在（更浅层级见过 / 批内重复）的会被跳过。
 */
export async function putHuntWalletsIfAbsent(rows: HuntWalletRow[]): Promise<HuntWalletRow[]> {
  if (rows.length === 0) return [];
  const db = await openDB();
  const tx = db.transaction(WALLETS, 'readwrite');
  const store = tx.objectStore(WALLETS);
  const inserted: HuntWalletRow[] = [];
  await Promise.all(
    rows.map(async (row) => {
      try {
        await req(store.add(row)); // add = 主键已存在时抛 ConstraintError
        inserted.push(row);
      } catch {
        // 已访问过 → 跳过
      }
    }),
  );
  return inserted;
}

/** 删除一次搜索的全部数据（run 记录 + 其所有钱包行） */
export async function deleteHuntRunData(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([RUNS, WALLETS], 'readwrite');
  const wIndex = tx.objectStore(WALLETS).index('byHunt');
  await new Promise<void>((resolve, reject) => {
    const cReq = wIndex.openCursor(IDBKeyRange.only(id));
    cReq.onsuccess = () => {
      const cursor = cReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    cReq.onerror = () => reject(cReq.error);
  });
  await req(tx.objectStore(RUNS).delete(id));
}

/** 当前源的总存储占用与配额（字节） */
export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/** 分页读取某次搜索的交易所命中（按主键序稳定输出） */
export async function listHuntHitPage(
  huntId: string,
  offset: number,
  limit: number,
): Promise<{ rows: HuntWalletRow[]; total: number }> {
  const db = await openDB();
  const tx = db.transaction(WALLETS, 'readonly');
  const index = tx.objectStore(WALLETS).index('byHuntHit');
  const range = IDBKeyRange.bound([huntId, 1], [huntId, 1]);
  const total = await req(index.count(range));
  const rows: HuntWalletRow[] = [];
  if (total > 0 && offset < total) {
    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openCursor(range);
      let skipped = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (skipped < offset) {
          skipped += 1;
          cursor.advance(offset - skipped + 1);
          return;
        }
        rows.push(cursor.value as HuntWalletRow);
        if (rows.length >= limit) {
          resolve();
          return;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }
  return { rows, total };
}

/** 沿父指针回溯资金路径 seed -> ... -> address */
export async function getHuntWalletPath(huntId: string, address: string): Promise<string[]> {
  const path: string[] = [];
  let cur: string | undefined = address;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    path.push(cur);
    const row = await getHuntWallet(huntId, cur);
    cur = row?.parent ?? undefined;
  }
  return path.reverse();
}
