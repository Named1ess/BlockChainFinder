import { fetchAddressTransactions } from '../api/oklink/endpoints';
import { fetchAddressEntityLabel } from '../api/oklink/entity';
import type { TxItem } from '../api/oklink/schemas';
import { aggregateCounterparties, fetchTokenMetaMap } from './engine';
import { isExchangeTag } from '../utils/exchangeTag';
import {
  getHuntWallet,
  getHuntWalletPath,
  putHuntWallet,
  putHuntWalletsIfAbsent,
  saveHuntRun,
  type HuntRunRow,
  type HuntWalletRow,
} from '../api/db/huntStore';

/**
 * 盒武器搜索（交易所命中搜索）—— 流式落库版
 *
 * 从种子地址出发逐层递增深度 BFS（跳数无上限）：
 *   1. 展开当前层全部钱包的交易对手方；
 *   2. 对下一层「整层」钱包做交易所标签检查；
 *   3. 累计命中达到 hitLimit（或未设目标时首个含命中的层）挖完该层后停止；
 *   4. 全部对手方耗尽 / 触达钱包上限仍未达标则结束。
 *
 * 内存策略：钱包发现、标签检查、命中与资金路径全部即时写入 IndexedDB，
 * 引擎内存只保留计数器与当前层队列，上万钱包也不会撑爆内存。
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
  /** 当前运行的搜索记录 id（IndexedDB runs 主键），null = 未开始 */
  runId: string | null;
  depth: number;
  scanned: number;
  tagChecked: number;
  pending: number;
  /** 累计命中的交易所钱包数 */
  hitCount: number;
  hitLimit: number;
  firstHitDepth: number | null;
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
  /**
   * 命中目标：累计发现这么多交易所钱包后才停止（停止前仍会挖完所在层）；
   * 未达标时即使某层有命中也会继续向更深挖掘。0 = 不限（首个含命中的层挖完即停）。
   */
  hitLimit: number;
}

export const DEFAULT_HUNT_OPTIONS: HuntOptions = {
  maxWallets: 120,
  maxNeighbors: 10,
  hitLimit: 10,
};

/** 标签检查的并发度（SSR 页面抓取不走 OKLink API 限流队列） */
const TAG_CONCURRENCY = 4;
const PAGE_SIZE = 50;
/** 每处理多少个钱包同步一次 run 统计到数据库 */
const RUN_FLUSH_INTERVAL = 20;

interface FrontierNode {
  address: string;
}

export class ExchangeHuntEngine {
  private seed: string | null = null;
  private chain: string | null = null;
  private runId: string | null = null;
  private running = false;
  private stopRequested = false;
  private startedAt = Date.now();
  private depth = 0;
  private scanned = 0;
  private tagChecked = 0;
  private pending = 0;
  private hitCount = 0;
  private firstHitDepth: number | null = null;
  private finished = false;
  private error: string | null = null;
  private lastOpts: HuntOptions | null = null;
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
      runId: this.runId,
      depth: this.depth,
      scanned: this.scanned,
      tagChecked: this.tagChecked,
      pending: this.pending,
      hitCount: this.hitCount,
      hitLimit: this.lastOpts?.hitLimit ?? 0,
      firstHitDepth: this.firstHitDepth,
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
    this.runId = null;
    this.running = false;
    this.depth = 0;
    this.scanned = 0;
    this.tagChecked = 0;
    this.pending = 0;
    this.hitCount = 0;
    this.firstHitDepth = null;
    this.finished = false;
    this.error = null;
    this.emit();
  }

  async start(chain: string, seed: string, opts: HuntOptions): Promise<void> {
    if (this.running) return;
    this.reset();
    this.stopRequested = false;
    this.chain = chain;
    this.seed = seed;
    this.lastOpts = opts;
    this.runId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.running = true;

    await saveHuntRun(this.buildRunRow('running', null));
    this.emit();

    try {
      await this.run(chain, seed, opts);
    } finally {
      this.running = false;
      this.pending = 0;
      await this.flushRunRow().catch(() => undefined);
      this.emit();
    }
  }

  private buildRunRow(status: HuntRunRow['status'], error: string | null): HuntRunRow {
    return {
      id: this.runId!,
      chain: this.chain ?? '',
      seed: this.seed ?? '',
      startedAt: this.startedAt,
      finishedAt: status === 'running' ? null : Date.now(),
      status,
      maxWallets: this.lastOpts?.maxWallets ?? 0,
      maxNeighbors: this.lastOpts?.maxNeighbors ?? 0,
      hitLimit: this.lastOpts?.hitLimit ?? 0,
      scanned: this.scanned,
      tagChecked: this.tagChecked,
      depth: this.depth,
      hitCount: this.hitCount,
      firstHitDepth: this.firstHitDepth,
      error,
    };
  }

  /** 把统计刷进 runs 表 */
  private async flushRunRow(statusOverride?: HuntRunRow['status']): Promise<void> {
    if (!this.runId) return;
    const status =
      statusOverride ??
      (this.finished ? 'hit-target' : this.stopRequested ? 'stopped' : 'running');
    await saveHuntRun(this.buildRunRow(status, this.error));
  }

  private async run(chain: string, seed: string, opts: HuntOptions): Promise<void> {
    // 种子自身先检查：可能本来就是交易所钱包
    this.pending = 1;
    const seedIsExchange = await this.checkAndStoreTag(seed);
    if (this.stopRequested) return;
    if (seedIsExchange) {
      this.hitCount = 1;
      this.firstHitDepth = 0;
      this.finished = true;
      this.error = '种子地址本身就是交易所钱包。';
      await this.flushRunRow('seed-is-exchange');
      return;
    }
    this.tagChecked += 1;

    let frontier: FrontierNode[] = [{ address: seed }];

    // 跳数不设上限：一路逐层搜下去，直到命中目标、对手方耗尽或触达钱包上限
    for (let depth = 1; ; depth++) {
      if (this.stopRequested) {
        await this.flushRunRow('stopped');
        return;
      }
      if (this.scanned >= opts.maxWallets) {
        const hitInfo =
          this.hitCount > 0 ? `，累计命中 ${this.hitCount} 个交易所钱包${opts.hitLimit > 0 ? `（目标 ${opts.hitLimit}）` : ''}` : '';
        this.error = `已达钱包上限（${opts.maxWallets}，共检查 ${this.tagChecked} 个标签）${hitInfo}。可调大钱包上限后重试。`;
        await this.flushRunRow('wallet-cap');
        return;
      }
      this.depth = depth;
      this.emit();

      // ---- 第 1 步：展开当前层全部钱包，收集下一层 ----
      const nextFrontier: FrontierNode[] = [];
      for (let i = 0; i < frontier.length; i++) {
        if (this.stopRequested) {
          await this.flushRunRow('stopped');
          return;
        }
        if (this.scanned >= opts.maxWallets) break;
        this.pending = frontier.length - i - 1;

        const neighbors = await this.expandNode(chain, frontier[i].address, depth, opts);
        this.scanned += 1;
        if (this.scanned % RUN_FLUSH_INTERVAL === 0) await this.flushRunRow().catch(() => undefined);
        this.emit();

        // 批量「不存在才写入」：已见过的钱包自动跳过，一个事务完成
        const inserted = await putHuntWalletsIfAbsent(
          neighbors
            .filter((cp) => cp !== seed)
            .map((cp) => ({
              key: `${this.runId}|${cp}`,
              huntId: this.runId!,
              address: cp,
              parent: frontier[i].address,
              depth,
              expanded: 0 as const,
              tag: null,
              isHit: 0 as const,
              path: null,
              updatedAt: Date.now(),
            })),
        );
        for (const row of inserted) {
          nextFrontier.push({ address: row.address });
        }
      }
      frontier = nextFrontier;

      if (frontier.length === 0) {
        const hitInfo = this.hitCount > 0 ? `，累计命中 ${this.hitCount} 个交易所钱包` : '';
        this.error = `全部对手方已搜索完毕（展开 ${this.scanned} 个钱包、检查 ${this.tagChecked} 个标签）${hitInfo}。`;
        this.finished = this.hitCount > 0;
        await this.flushRunRow('exhausted');
        return;
      }

      // ---- 第 2 步：整层标签检查（必须扫完这一层才算结束）----
      this.pending = frontier.length;
      this.emit();
      await this.checkLayer(frontier);
      if (this.stopRequested) {
        await this.flushRunRow('stopped');
        return;
      }

      const targetMet = opts.hitLimit > 0 && this.hitCount >= opts.hitLimit;
      // 未设目标时：首个含命中的层挖完即停；设了目标：达标才停
      if ((opts.hitLimit > 0 && targetMet) || (opts.hitLimit <= 0 && this.hitCount > 0)) {
        this.finished = true;
        await this.flushRunRow('hit-target');
        return;
      }
      // 未达命中目标：带着已有命中继续向更深挖掘
    }
  }

  /** 拉取一个钱包的普通+代币交易，返回按 USD 金额排序的前 N 个对手方，并标记该钱包已展开 */
  private async expandNode(
    chain: string,
    address: string,
    depth: number,
    opts: HuntOptions,
  ): Promise<string[]> {
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

    // 标记已展开（种子首次出现时落库）
    const row = await getHuntWallet(this.runId!, address);
    if (row) {
      await putHuntWallet({ ...row, expanded: 1, updatedAt: Date.now() });
    } else {
      await putHuntWallet({
        key: `${this.runId}|${address}`,
        huntId: this.runId!,
        address,
        parent: null,
        depth,
        expanded: 1,
        tag: null,
        isHit: 0,
        path: null,
        updatedAt: Date.now(),
      });
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
  private async checkLayer(frontier: FrontierNode[]): Promise<void> {
    let cursor = 0;
    let checkedInLayer = 0;

    const worker = async (): Promise<void> => {
      while (!this.stopRequested) {
        const idx = cursor++;
        if (idx >= frontier.length) return;
        const node = frontier[idx];

        const isHit = await this.checkAndStoreTag(node.address);
        checkedInLayer += 1;
        this.tagChecked += 1;
        this.pending = Math.max(0, frontier.length - checkedInLayer);

        if (isHit && !this.stopRequested) {
          this.hitCount += 1;
          if (this.firstHitDepth === null) this.firstHitDepth = this.depth;
        }
        this.emit();
      }
    };

    await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, frontier.length) }, () => worker()));
  }

  /** 查标签并写回钱包行；仅交易所标签返回 true（KOL/ENS/项目方等实体标签不算） */
  private async checkAndStoreTag(address: string): Promise<boolean> {
    let label: string | null = null;
    try {
      label = await fetchAddressEntityLabel(this.chain ?? '', address);
    } catch {
      label = null;
    }
    const isHit = isExchangeTag(label);

    const existing = await getHuntWallet(this.runId!, address);
    const row: HuntWalletRow = existing ?? {
      key: `${this.runId}|${address}`,
      huntId: this.runId!,
      address,
      parent: null,
      depth: 0,
      expanded: 0,
      tag: null,
      isHit: 0,
      path: null,
      updatedAt: Date.now(),
    };

    const finalRow: HuntWalletRow = {
      ...row,
      tag: label ?? '',
      isHit: isHit ? 1 : 0,
      updatedAt: Date.now(),
    };
    if (isHit) {
      // 命中即回溯完整资金路径一并入库
      finalRow.path = await getHuntWalletPath(this.runId!, address);
    }
    await putHuntWallet(finalRow);
    return isHit;
  }
}
