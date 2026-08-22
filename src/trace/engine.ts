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

interface CounterpartyAgg {
  out: Map<string, EdgeTransfer>;
  in: Map<string, EdgeTransfer>;
}

/** 代币元信息（来自该节点自身的持仓列表），用于补全符号与 USD 估值 */
interface TokenMeta {
  symbol: string;
  priceUsd: number | null;
}

const PAGE_SIZE = 50;
/** 溯源时抓取的交易类型：普通转账 + ERC20/TRC20 转账（TRON 的两类列表来自 TronScan） */
const TRACE_PROTOCOLS: TxProtocolType[] = ['transaction', 'token_20'];

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
    this.reset();
    this.chain = chain;
    this.seed = seed;
    this.addNode(seed, 0);
    this.queue.push({ address: seed, depth: 0 });
    this.running = true;
    this.emit();
    await this.drain(opts);
  }

  /** 手动展开单个节点（不受 maxDepth 限制，新邻居不自动入队） */
  async expandNode(address: string, opts: TraceOptions): Promise<void> {
    if (this.running) return;
    const node = this.graph.nodes.get(address);
    if (!node || node.expanded) return;
    this.running = true;
    this.error = null;
    this.emit();
    await this.processNode(address, node.depth, opts, false);
    this.running = false;
    this.emit();
  }

  stop(): void {
    this.stopRequested = true;
  }

  reset(): void {
    this.stopRequested = true;
    this.graph = createEmptyGraph();
    this.seed = null;
    this.chain = null;
    this.running = false;
    this.done = 0;
    this.error = null;
    this.queue = [];
    this.depthCounts.clear();
    this.cachedSnapshot = null;
    this.emit();
  }

  private async drain(opts: TraceOptions): Promise<void> {
    this.stopRequested = false;
    while (this.queue.length > 0 && !this.stopRequested) {
      if (this.graph.nodes.size >= opts.maxNodes) {
        this.error = `已达节点上限（${opts.maxNodes}），停止展开。可调大上限或收紧过滤条件。`;
        break;
      }
      const { address, depth } = this.queue.shift()!;
      await this.processNode(address, depth, opts, true);
      this.done += 1;
      this.emit();
    }
    this.running = false;
    this.emit();
  }

  /** 拉取 address 的普通+代币交易、解析对手方并更新图。autoQueue=true 时新邻居按深度规则入队 */
  private async processNode(address: string, depth: number, opts: TraceOptions, autoQueue: boolean): Promise<void> {
    const node = this.graph.nodes.get(address);
    if (!node || node.expanded) return;
    node.expanded = true;

    const chain = this.chain ?? 'ETH';
    const protocols = TRACE_PROTOCOLS.filter((p) => txListSupported(chain, p));
    if (protocols.length === 0) {
      this.error = '当前链的网页端接口暂不支持交易列表抓取（Tron 转账列表受 OKLink 签名网关保护），无法溯源。';
      return;
    }
    let txs: TxItem[] = [];
    try {
      for (const protocol of protocols) {
        for (let page = 1; page <= opts.pagesPerNode; page++) {
          const res = await fetchAddressTransactions(chain, address, page, PAGE_SIZE, protocol);
          txs.push(...res.transactions);
          if (page >= res.totalPage) break;
        }
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return;
    }

    // 用该地址自己的持仓列表补全代币符号与价格（合约地址 -> 元信息）
    const tokenMeta = await this.loadTokenMeta(chain, address);

    const agg = aggregateCounterparties(txs, address, opts.direction, tokenMeta);

    // 按 USD 金额降序排列，取前 maxNeighbors 个；价格未知者视为 0 排在后面
    const ranked = [...agg.entries()]
      .map(([cp, data]) => ({
        cp,
        usd: [...data.out.values(), ...data.in.values()].reduce((s, t) => s + (t.usdValue ?? 0), 0),
        data,
      }))
      .filter((e) => e.usd >= opts.minUsd)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, opts.maxNeighbors);

    for (const { cp, data } of ranked) {
      for (const dir of ['out', 'in'] as const) {
        const transfers = [...data[dir].values()].filter((t) => t.count > 0);
        if (transfers.length === 0) continue;
        const [from, to] = dir === 'out' ? [address, cp] : [cp, address];
        this.upsertEdge(from, to, transfers);
      }

      if (!this.graph.nodes.has(cp)) {
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
    const meta = new Map<string, TokenMeta>();
    try {
      const res = await fetchTokenBalances(chain, address, 1, PAGE_SIZE);
      for (const h of res.list) {
        if (!h.tokenContractAddress) continue;
        meta.set(h.tokenContractAddress.toLowerCase(), {
          symbol: h.symbol || h.token || 'UNKNOWN',
          priceUsd: Number(h.priceUsd),
        });
      }
    } catch {
      // 价格缺失只影响 USD 过滤与估值，不中断
    }
    return meta;
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
        (e) => e.token === t.token && e.contract === t.contract && (e.usdValue === null) === (t.usdValue === null),
      );
      if (existing) {
        existing.amount += t.amount;
        existing.count += t.count;
        existing.usdValue = (existing.usdValue ?? 0) + (t.usdValue ?? 0);
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
function aggregateCounterparties(
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
    const meta = contract ? tokenMeta.get(contract.toLowerCase()) : undefined;
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
      counterparty = to;
      dir = 'out';
    } else if ((direction === 'in' || direction === 'both') && sameAddress(to, self)) {
      counterparty = from;
      dir = 'in';
    }
    if (!counterparty || !dir) continue;

    const bucket = ensure(counterparty)[dir];
    const existing = bucket.get(token);
    if (existing) {
      existing.amount += amount;
      existing.count += 1;
      existing.lastTime = Math.max(existing.lastTime ?? 0, time ?? 0) || null;
    } else {
      bucket.set(token, { token, contract, amount, count: 1, usdValue: usd, lastTime: time });
    }
  }
  return agg;
}

/** 地址比较统一转小写（EVM）；TRON 等 base58 地址不受影响 */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
