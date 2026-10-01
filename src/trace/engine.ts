import { fetchAddressTransactions, fetchTokenBalances, txListSupported, type TxProtocolType } from '../api/oklink/endpoints';
import { txTokenSymbol, type TxItem } from '../api/oklink/schemas';
import {
  createEmptyGraph,
  edgeId,
  type AddressNode,
  type EdgeTransfer,
  type TraceDirection,
  type TransferEdge,
} from './graph';

export type { TraceDirection } from './graph';

export interface TraceOptions {
  /** in = 追资金来源，out = 追资金去向，both = 双向 */
  direction: TraceDirection;
  /** 最大追踪深度 */
  maxDepth: number;
  /** 图中节点数上限（防止交易所热钱包把图撑爆） */
  maxNodes: number;
  /** 最小金额过滤（USD）。价格未知的转账不受此过滤 */
  minUsd: number;
  /** 每个节点每轮最多新增的邻居数（按 USD 金额排序取前 N） */
  maxNeighbors: number;
  /** 每个节点每种交易类型抓取的页数（每页 50 条） */
  pagesPerNode: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  direction: 'out',
  maxDepth: 2,
  maxNodes: 60,
  minUsd: 0,
  maxNeighbors: 8,
  pagesPerNode: 1,
};

export interface TraceSnapshot {
  version: number;
  running: boolean;
  seed: string | null;
  chain: string | null;
  /** 已展开的节点数 */
  done: number;
  /** 等待展开的节点数 */
  queued: number;
  error: string | null;
  nodes: AddressNode[];
  edges: TransferEdge[];
}

interface QueuedNode {
  address: string;
  depth: number;
}

export interface CounterpartyAgg {
  out: Map<string, EdgeTransfer>;
  in: Map<string, EdgeTransfer>;
}

/** 代币元信息（来自该节点自身的持仓列表），用于补全符号与 USD 估值 */
export interface TokenMeta {
  symbol: string;
  priceUsd: number | null;
}

const PAGE_SIZE = 50;
/** 溯源时抓取的交易类型：普通转账 + ERC20/TRC20 转账（TRON 的两类列表来自 TronScan） */
const TRACE_PROTOCOLS: TxProtocolType[] = ['transaction', 'token_20'];

/** 拉取地址的代币持仓首页，构建合约地址 -> 符号/价格 映射；失败返回空表不阻断调用方 */
export async function fetchTokenMetaMap(chain: string, address: string, limit = PAGE_SIZE): Promise<Map<string, TokenMeta>> {
  const meta = new Map<string, TokenMeta>();
  try {
    const res = await fetchTokenBalances(chain, address, 1, limit);
    for (const h of res.list) {
      if (!h.tokenContractAddress) continue;
      meta.set(canonicalIdentity(h.tokenContractAddress), {
        symbol: h.symbol || h.token || 'UNKNOWN',
        priceUsd: h.priceUsd?.trim() && Number.isFinite(Number(h.priceUsd)) ? Number(h.priceUsd) : null,
      });
    }
  } catch {
    // 价格缺失只影响 USD 过滤与估值，不中断
  }
  return meta;
}

/**
 * 资金溯源引擎：从种子地址出发 BFS 展开交易对手方，构建资金流向图。
 * 纯 TypeScript 实现、不依赖 React，通过 subscribe/getSnapshot 与 UI 绑定。
 */
export class TraceEngine {
  private graph = createEmptyGraph();
  private seed: string | null = null;
  private chain: string | null = null;
  private running = false;
  private stopRequested = false;
  private generation = 0;
  private seenEvents = new Set<string>();
  private done = 0;
  private error: string | null = null;
  private queue: QueuedNode[] = [];
  private depthCounts = new Map<number, number>();
  private version = 0;
  private cachedSnapshot: TraceSnapshot | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): TraceSnapshot => {
    if (!this.cachedSnapshot) this.cachedSnapshot = this.buildSnapshot();
    return this.cachedSnapshot;
  };

  private emit(): void {
    this.version += 1;
    this.cachedSnapshot = this.buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  private buildSnapshot(): TraceSnapshot {
    return {
      version: this.version,
      running: this.running,
      seed: this.seed,
      chain: this.chain,
      done: this.done,
      queued: this.queue.length,
      error: this.error,
      nodes: [...this.graph.nodes.values()].sort((a, b) => a.depth - b.depth || a.address.localeCompare(b.address)),
      edges: [...this.graph.edges.values()].sort((a, b) => b.totalUsd - a.totalUsd),
    };
  }

  /** 从种子地址开始自动多跳溯源 */
  async start(chain: string, seed: string, opts: TraceOptions): Promise<void> {
    if (this.running) return;
    seed = canonicalIdentity(seed);
    this.reset();
    const generation = this.generation;
    this.stopRequested = false;
    this.chain = chain;
    this.seed = seed;
    this.addNode(seed, 0);
    this.queue.push({ address: seed, depth: 0 });
    this.running = true;
    this.emit();
    await this.drain(opts, generation);
  }

  /** 手动展开单个节点（不受 maxDepth 限制，新邻居不自动入队） */
  async expandNode(address: string, opts: TraceOptions): Promise<void> {
    if (this.running) return;
    address = canonicalIdentity(address);
    const node = this.graph.nodes.get(address);
    if (!node || node.expanded) return;
    const generation = this.generation;
    this.stopRequested = false;
    this.running = true;
    this.error = null;
    this.emit();
    try {
      await this.processNode(address, node.depth, opts, false, generation);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.emit();
      }
    }
  }

  stop(): void {
    this.stopRequested = true;
  }

  reset(): void {
    this.generation += 1;
    this.stopRequested = true;
    this.graph = createEmptyGraph();
    this.seed = null;
    this.chain = null;
    this.running = false;
    this.done = 0;
    this.error = null;
    this.queue = [];
    this.seenEvents.clear();
    this.depthCounts.clear();
    this.cachedSnapshot = null;
    this.emit();
  }

  private async drain(opts: TraceOptions, generation: number): Promise<void> {
    try {
      while (generation === this.generation && this.queue.length > 0 && !this.stopRequested) {
        if (this.graph.nodes.size >= opts.maxNodes) {
          this.error = `已达节点上限（${opts.maxNodes}），停止展开。可调大上限或收紧过滤条件。`;
          break;
        }
        const { address, depth } = this.queue.shift()!;
        await this.processNode(address, depth, opts, true, generation);
        if (generation !== this.generation) return;
        if (this.stopRequested) break;
        this.done += 1;
        this.emit();
      }
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.emit();
      }
    }
  }

  /** 拉取 address 的普通+代币交易、解析对手方并更新图。autoQueue=true 时新邻居按深度规则入队 */
  private async processNode(address: string, depth: number, opts: TraceOptions, autoQueue: boolean, generation: number): Promise<void> {
    const node = this.graph.nodes.get(address);
    if (!node || node.expanded) return;

    const chain = this.chain ?? 'ETH';
    const protocols = TRACE_PROTOCOLS.filter((p) => txListSupported(chain, p));
    if (protocols.length === 0) {
      this.error = '当前链暂未接入交易数据源，无法溯源。请选择已支持的链。';
      return;
    }
    const observations = new Map<string, TxItem>();
    try {
      for (const protocol of protocols) {
        const occurrences = new Map<string, number>();
        for (let page = 1; page <= opts.pagesPerNode; page++) {
          const res = await fetchAddressTransactions(chain, address, page, PAGE_SIZE, protocol);
          if (generation !== this.generation || this.stopRequested) return;
          // Count unindexed token occurrences across this address's full history;
          // the graph ledger then takes maximum multiplicity across address views.
          for (const tx of res.transactions) {
            const fingerprint = eventFingerprint(tx, protocol);
            const ordinal = (occurrences.get(fingerprint) ?? 0) + 1;
            occurrences.set(fingerprint, ordinal);
            const exact = tx.txId && (protocol === 'transaction' || (tx.eventIndex !== undefined && tx.eventIndex !== ''));
            const id = exact
              ? fingerprint : `${fingerprint}:${ordinal}`;
            observations.set(id, tx);
          }
          if (page >= res.totalPage) break;
        }
      }
    } catch (err) {
      if (generation !== this.generation || this.stopRequested) return;
      this.error = err instanceof Error ? err.message : String(err);
      return;
    }

    // 用该地址自己的持仓列表补全代币符号与价格（合约地址 -> 元信息）
    const tokenMeta = await this.loadTokenMeta(chain, address);
    if (generation !== this.generation || this.stopRequested) return;
    node.expanded = true;

    const agg = aggregateCounterparties([...observations.values()], address, opts.direction, tokenMeta);

    // 按 USD 金额降序排列，取前 maxNeighbors 个；价格未知者视为 0 排在后面
    const ranked = [...agg.entries()]
      .map(([cp, data]) => ({
        cp,
        usd: [...data.out.values(), ...data.in.values()].reduce((s, t) => s + (t.usdValue ?? 0), 0),
        unknownPrice: [...data.out.values(), ...data.in.values()].some((t) => t.usdValue === null),
      }))
      .filter((e) => e.unknownPrice || e.usd >= opts.minUsd)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, opts.maxNeighbors);

    const selected = new Set(ranked.map(({ cp }) => cp));
    const newTransactions: TxItem[] = [];
    for (const [id, tx] of observations) {
      if (this.seenEvents.has(id)) continue;
      const counterparties = aggregateCounterparties([tx], address, opts.direction, tokenMeta);
      if (![...counterparties.keys()].some((cp) => selected.has(cp))) continue;
      this.seenEvents.add(id);
      newTransactions.push(tx);
    }
    const additions = aggregateCounterparties(newTransactions, address, opts.direction, tokenMeta);
    for (const { cp } of ranked) {
      const data = additions.get(cp);
      for (const dir of ['out', 'in'] as const) {
        const transfers = data ? [...data[dir].values()].filter((t) => t.count > 0) : [];
        if (transfers.length === 0) continue;
        const [from, to] = dir === 'out' ? [address, cp] : [cp, address];
        this.upsertEdge(from, to, transfers);
      }

      if (data && !this.graph.nodes.has(cp)) {
        if (this.graph.nodes.size >= opts.maxNodes) continue;
        this.addNode(cp, depth + 1);
        if (autoQueue && depth + 1 < opts.maxDepth) {
          this.queue.push({ address: cp, depth: depth + 1 });
        }
      }
    }
  }

  /** 拉取第一页代币持仓，构建合约地址到符号/价格的映射；失败不阻断溯源 */
  private async loadTokenMeta(chain: string, address: string): Promise<Map<string, TokenMeta>> {
    return fetchTokenMetaMap(chain, address, PAGE_SIZE);
  }

  private addNode(address: string, depth: number): AddressNode {
    const index = this.depthCounts.get(depth) ?? 0;
    this.depthCounts.set(depth, index + 1);
    const node: AddressNode = {
      address,
      depth,
      expanded: false,
      position: { x: depth * 360, y: index * 140 },
    };
    this.graph.nodes.set(address, node);
    return node;
  }

  private upsertEdge(from: string, to: string, transfers: EdgeTransfer[]): TransferEdge {
    const id = edgeId(from, to);
    let edge = this.graph.edges.get(id);
    if (!edge) {
      edge = { id, from, to, transfers: [], txCount: 0, totalUsd: 0 };
      this.graph.edges.set(id, edge);
    }
    for (const t of transfers) {
      const existing = edge.transfers.find(
        (e) => assetKey(e.contract, e.token) === assetKey(t.contract, t.token) && (e.usdValue === null) === (t.usdValue === null),
      );
      if (existing) {
        existing.amount += t.amount;
        existing.count += t.count;
        existing.usdValue = existing.usdValue === null ? null : existing.usdValue + (t.usdValue ?? 0);
        existing.lastTime = Math.max(existing.lastTime ?? 0, t.lastTime ?? 0) || null;
      } else {
        edge.transfers.push({ ...t });
      }
    }
    edge.txCount = edge.transfers.reduce((s, t) => s + t.count, 0);
    edge.totalUsd = edge.transfers.reduce((s, t) => s + (t.usdValue ?? 0), 0);
    return edge;
  }
}

/** 把一笔笔交易聚合成「对手方 -> 方向 -> 代币转账」结构 */
export function aggregateCounterparties(
  txs: TxItem[],
  self: string,
  direction: TraceDirection,
  tokenMeta: Map<string, TokenMeta>,
): Map<string, CounterpartyAgg> {
  const agg = new Map<string, CounterpartyAgg>();

  const ensure = (cp: string): CounterpartyAgg => {
    let entry = agg.get(cp);
    if (!entry) {
      entry = { out: new Map(), in: new Map() };
      agg.set(cp, entry);
    }
    return entry;
  };

  for (const tx of txs) {
    if (tx.state && tx.state !== 'success') continue;
    const amount = Number(tx.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const contract = tx.tokenContractAddress || '';
    const meta = contract ? tokenMeta.get(canonicalIdentity(contract)) : undefined;
    const price = meta?.priceUsd;
    const usd = price !== undefined && price !== null && Number.isFinite(price) ? amount * price : null;
    const token = meta?.symbol ?? txTokenSymbol(tx);
    const timeNum = Number(tx.transactionTime);
    const time = Number.isFinite(timeNum) && timeNum > 0 ? Math.floor(timeNum / (timeNum > 1e12 ? 1000 : 1)) : null;

    const from = tx.from;
    const to = tx.to;
    if (!from || !to || sameAddress(from, to)) continue;

    let counterparty: string | null = null;
    let dir: 'in' | 'out' | null = null;
    if ((direction === 'out' || direction === 'both') && sameAddress(from, self)) {
      counterparty = canonicalIdentity(to);
      dir = 'out';
    } else if ((direction === 'in' || direction === 'both') && sameAddress(to, self)) {
      counterparty = canonicalIdentity(from);
      dir = 'in';
    }
    if (!counterparty || !dir) continue;

    const bucket = ensure(counterparty)[dir];
    const key = assetKey(contract, token);
    const existing = bucket.get(key);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      existing.usdValue = existing.usdValue === null || usd === null ? null : existing.usdValue + usd;
      existing.lastTime = Math.max(existing.lastTime ?? 0, time ?? 0) || null;
    } else {
      bucket.set(key, { token, contract, amount, count: 1, usdValue: usd, lastTime: time });
    }
  }
  return agg;
}

function assetKey(contract: string, token: string): string {
  return contract ? `contract:${canonicalIdentity(contract)}` : `native:${token}`;
}

/** EVM hex identity ignores checksum case; Base58 identity is case sensitive. */
export function canonicalIdentity(value: string): string {
  return /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value;
}

/**
 * Native transaction hashes and indexed token events are exact. Without a token
 * index, fingerprint + per-address ordinal preserves identical events across
 * pages and takes their maximum multiplicity across address views. This assumes
 * stable pagination: overlapping unindexed pages may overcount indistinguishable
 * events. A missing hash also makes otherwise identical transfers ambiguous.
 * Protocol separates native value from token logs in the same transaction.
 */
function eventFingerprint(tx: TxItem, protocol: TxProtocolType): string {
  const asset = assetKey(tx.tokenContractAddress ?? '', tx.transactionSymbol ?? 'UNKNOWN');
  const hash = canonicalIdentity(tx.txId);
  if (hash && protocol === 'transaction') return JSON.stringify([protocol, hash]);
  if (tx.txId && tx.eventIndex !== undefined && tx.eventIndex !== '') {
    return JSON.stringify([protocol, hash, asset, tx.eventIndex]);
  }
  return JSON.stringify([protocol, hash, asset, canonicalIdentity(tx.from), canonicalIdentity(tx.to), tx.amount,
    ...(hash ? [] : [tx.height, tx.transactionTime])]);
}

/** EVM checksum variants compare equally; Base58 retains case. */
function sameAddress(a: string, b: string): boolean {
  return canonicalIdentity(a) === canonicalIdentity(b);
}
