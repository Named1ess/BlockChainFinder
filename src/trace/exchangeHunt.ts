import { fetchAddressTransactions } from '../api/oklink/endpoints';
import { fetchAddressEntityLabel } from '../api/oklink/entity';
import type { TxItem } from '../api/oklink/schemas';
import { aggregateCounterparties, fetchTokenMetaMap } from './engine';
import { isExchangeTag } from '../utils/exchangeTag';

/**
 * 盒武器搜索（交易所命中搜索）
 *
 * 从种子地址出发，逐层递增深度做 BFS：
 *   1. 展开当前层全部钱包的交易对手方；
 *   2. 对下一层「整层」钱包做交易所标签检查；
 *   3. 若该层发现至少一个带交易所标签的钱包 —— 也必须把这一层全部检查完才结束；
 *   4. 一层没发现则进入下一层，直到 maxDepth / maxWallets 上限。
 *
 * 汇报口径：搜索深度 = 命中的交易所钱包个数；同时给出实际扫描钱包数
 * （比如深度 2 可能意味着实际经过了 5 个钱包才找到 2 个交易所钱包）。
 */

export interface HuntHit {
  /** 命中交易所标签的钱包地址 */
  address: string;
  /** 交易所标签原文，如「Binance. DepositAndWithdraw_10」 */
  label: string;
  /** 距种子地址的跳数 */
  depth: number;
  /** 资金路径：seed -> ... -> 命中地址 */
  path: string[];
}

export interface HuntSnapshot {
  version: number;
  running: boolean;
  seed: string | null;
  chain: string | null;
  /** 当前正在扫描的跳数（种子为第 0 跳） */
  depth: number;
  /** 已展开（拉取过交易列表）的钱包数 */
  scanned: number;
  /** 已完成标签检查的钱包数 */
  tagChecked: number;
  /** 当前层剩余待处理数量 */
  pending: number;
  /** 命中的交易所钱包（搜索结束后为完整结果，运行中为当前层已确认的） */
  hits: HuntHit[];
  /** 命中所在的跳数；null 表示尚未命中或未开始 */
  hitDepth: number | null;
  /** 是否已完整结束（区别于手动停止/出错） */
  finished: boolean;
  error: string | null;
}

export interface HuntOptions {
  /**
   * 安全上限：最多展开多少个钱包。
   * 跳数不设上限 —— 一路逐层搜索，直到发现带交易所标签的钱包，
   * 或全部对手方搜索完毕 / 触达本上限仍未发现。
   */
  maxWallets: number;
  /** 每个钱包最多追踪多少个对手方（按 USD 金额排序取前 N） */
  maxNeighbors: number;
}

export const DEFAULT_HUNT_OPTIONS: HuntOptions = {
  maxWallets: 120,
  maxNeighbors: 10,
};

/** 标签检查的并发度（SSR 页面抓取不走 OKLink API 限流队列） */
const TAG_CONCURRENCY = 4;
const PAGE_SIZE = 50;

interface FrontierNode {
  address: string;
}

export class ExchangeHuntEngine {
  private seed: string | null = null;
  private chain: string | null = null;
  private running = false;
  private stopRequested = false;
  private depth = 0;
  private scanned = 0;
  private tagChecked = 0;
  private pending = 0;
  private hits: HuntHit[] = [];
  private hitDepth: number | null = null;
  private finished = false;
  private error: string | null = null;
  private parent = new Map<string, string>();
  private version = 0;
  private cachedSnapshot: HuntSnapshot | null = null;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): HuntSnapshot => {
    if (!this.cachedSnapshot) this.cachedSnapshot = this.buildSnapshot();
    return this.cachedSnapshot;
  };

  private emit(): void {
    this.version += 1;
    this.cachedSnapshot = this.buildSnapshot();
    for (const fn of this.listeners) fn();
  }

  private buildSnapshot(): HuntSnapshot {
    return {
      version: this.version,
      running: this.running,
      seed: this.seed,
      chain: this.chain,
      depth: this.depth,
      scanned: this.scanned,
      tagChecked: this.tagChecked,
      pending: this.pending,
      hits: [...this.hits],
      hitDepth: this.hitDepth,
      finished: this.finished,
      error: this.error,
    };
  }

  stop(): void {
    this.stopRequested = true;
  }

  reset(): void {
    this.stopRequested = true;
    this.seed = null;
    this.chain = null;
    this.running = false;
    this.depth = 0;
    this.scanned = 0;
    this.tagChecked = 0;
    this.pending = 0;
    this.hits = [];
    this.hitDepth = null;
    this.finished = false;
    this.error = null;
    this.parent.clear();
    this.emit();
  }

  async start(chain: string, seed: string, opts: HuntOptions): Promise<void> {
    if (this.running) return;
    this.reset();
    this.stopRequested = false;
    this.chain = chain;
    this.seed = seed;
    this.running = true;
    this.emit();

    try {
      await this.run(chain, seed, opts);
    } finally {
      this.running = false;
      this.pending = 0;
      this.emit();
    }
  }

  private async run(chain: string, seed: string, opts: HuntOptions): Promise<void> {
    this.parent.clear();

    // 种子自身先检查：可能本来就是交易所钱包（KOL/ENS 等其他实体标签不算）
    this.pending = 1;
    const seedLabel = await this.checkTag(chain, seed);
    if (this.stopRequested) return;
    if (seedLabel) {
      this.hits = [{ address: seed, label: seedLabel, depth: 0, path: [seed] }];
      this.hitDepth = 0;
      this.finished = true;
      this.error = '种子地址本身就是交易所钱包。';
      return;
    }
    this.tagChecked += 1;

    let frontier: FrontierNode[] = [{ address: seed }];

    // 跳数不设上限：一路逐层搜下去，直到命中交易所、对手方耗尽或触达钱包上限
    for (let depth = 1; ; depth++) {
      if (this.stopRequested) return;
      if (this.scanned >= opts.maxWallets) {
        this.error = `已达钱包上限（${opts.maxWallets}，共检查 ${this.tagChecked} 个标签），未发现带交易所标签的钱包。可调大钱包上限后重试。`;
        return;
      }
      this.depth = depth;
      this.emit();

      // ---- 第 1 步：展开当前层全部钱包，收集下一层 ----
      const nextFrontier: FrontierNode[] = [];
      for (let i = 0; i < frontier.length; i++) {
        if (this.stopRequested) return;
        if (this.scanned >= opts.maxWallets) break;
        this.pending = frontier.length - i - 1;

        const neighbors = await this.expandNode(chain, frontier[i].address, opts);
        this.scanned += 1;
        this.emit();

        for (const cp of neighbors) {
          if (cp === seed) continue;
          // 全局去重：已在更浅层级出现过的钱包不再重复入队/检查
          if (this.parent.has(cp)) continue;
          this.parent.set(cp, frontier[i].address);
          nextFrontier.push({ address: cp });
        }
      }
      frontier = nextFrontier;

      if (frontier.length === 0) {
        this.error = `全部对手方已搜索完毕（展开 ${this.scanned} 个钱包、检查 ${this.tagChecked} 个标签），未发现带交易所标签的钱包。`;
        return;
      }

      // ---- 第 2 步：整层标签检查（必须扫完这一层才算结束）----
      this.pending = frontier.length;
      this.emit();
      const layerHits = await this.checkLayer(chain, frontier);
      if (this.stopRequested) return;

      if (layerHits.length > 0) {
        // 走到这里说明整层已全部检查完毕
        this.hits = layerHits.sort((a, b) => b.address.localeCompare(a.address));
        this.hitDepth = depth;
        this.finished = true;
        return;
      }
    }
  }

  /** 拉取一个钱包的普通+代币交易，返回按 USD 金额排序的前 N 个对手方 */
  private async expandNode(chain: string, address: string, opts: HuntOptions): Promise<string[]> {
    const txs: TxItem[] = [];
    try {
      for (const protocol of ['transaction', 'token_20'] as const) {
        const res = await fetchAddressTransactions(chain, address, 1, PAGE_SIZE, protocol);
        txs.push(...res.transactions);
      }
    } catch (err) {
      // 单个钱包失败不中断整体搜索，记录原因供 UI 提示
      this.error = err instanceof Error ? err.message : String(err);
      return [];
    }

    const tokenMeta = await fetchTokenMetaMap(chain, address);
    const agg = aggregateCounterparties(txs, address, 'both', tokenMeta);

    const ranked = [...agg.entries()]
      .map(([cp, data]) => ({
        cp,
        usd: [...data.out.values(), ...data.in.values()].reduce((s, t) => s + (t.usdValue ?? 0), 0),
        count: [...data.out.values(), ...data.in.values()].reduce((s, t) => s + t.count, 0),
      }))
      .sort((a, b) => b.usd - a.usd || b.count - a.count)
      .slice(0, opts.maxNeighbors);

    return ranked.map((r) => r.cp);
  }

  /** 并发检查一整层的交易所标签；发现命中也继续查完该层 */
  private async checkLayer(chain: string, frontier: FrontierNode[]): Promise<HuntHit[]> {
    const hits: HuntHit[] = [];
    let cursor = 0;
    let checkedInLayer = 0;

    const worker = async (): Promise<void> => {
      while (!this.stopRequested) {
        const idx = cursor++;
        if (idx >= frontier.length) return;
        const node = frontier[idx];

        const label = await this.checkTag(chain, node.address);
        checkedInLayer += 1;
        this.tagChecked += 1;
        this.pending = Math.max(0, frontier.length - checkedInLayer);

        if (label && !this.stopRequested) {
          hits.push({ address: node.address, label, depth: this.depth, path: this.pathOf(node.address) });
          // 运行中即时可见（但整层查完才决定停止）
          this.hits = [...hits];
        }
        this.emit();
      }
    };

    await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, frontier.length) }, () => worker()));
    return hits;
  }

  /** 查单个地址的交易所标签；仅返回「交易所」标签，KOL/ENS/项目方等实体标签返回 null */
  private async checkTag(chain: string, address: string): Promise<string | null> {
    try {
      const label = await fetchAddressEntityLabel(chain, address);
      return isExchangeTag(label) ? label : null;
    } catch {
      return null;
    }
  }

  /** 回溯资金路径：seed -> ... -> 目标地址 */
  private pathOf(address: string): string[] {
    const path: string[] = [];
    let cur: string | undefined = address;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      path.push(cur);
      cur = this.parent.get(cur);
    }
    return path.reverse();
  }
}
