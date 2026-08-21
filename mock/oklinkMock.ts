import type { Plugin } from 'vite';
import { DEMO_B, DEMO_C, DEMO_D, DEMO_E, DEMO_EDGES, DEMO_F } from '../src/demo';

/**
 * OKLink 网页端数据接口的本地 Mock 中间件。
 * 通过 `OKLINK_MOCK=1 npm run dev` 启用，完全离线即可体验完整功能。
 * 路由与响应结构对齐 OKLink 网页端真实接口（{ code: 0, data: { total, hits } }）。
 */

/** FNV-1a 字符串哈希，用作伪随机种子 */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** mulberry32 可复现伪随机数生成器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type MockToken = 'ETH' | 'USDT' | 'USDC';

interface MockTransfer {
  counterparty: string;
  direction: 'in' | 'out';
  token: MockToken;
  amount: number;
}

const TOKEN_META: Record<MockToken, { contract: string; price: number; name: string }> = {
  ETH: { contract: '', price: 3500, name: 'Ether' },
  USDT: { contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1, name: 'Tether USD' },
  USDC: { contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', price: 1, name: 'USD Coin' },
};

/** 固定演示资金网络中的转账；未知地址则生成确定性的随机转账 */
function transfersOf(self: string): MockTransfer[] {
  const out: MockTransfer[] = [];
  const tokens: MockToken[] = ['ETH', 'USDT', 'USDC'];
  const amounts: Record<MockToken, number> = { ETH: 2.5, USDT: 12000, USDC: 4500 };

  for (const [from, to] of DEMO_EDGES) {
    if (from !== self && to !== self) continue;
    const token = tokens[hashSeed(from + to) % tokens.length];
    if (from === self) out.push({ counterparty: to, direction: 'out', token, amount: amounts[token] });
    if (to === self) out.push({ counterparty: from, direction: 'in', token, amount: amounts[token] * 0.8 });
  }

  if (out.length > 0) return out;

  const rng = mulberry32(hashSeed(self));
  const n = 3 + Math.floor(rng() * 4);
  const pool = [DEMO_B, DEMO_C, DEMO_D, DEMO_E, DEMO_F];
  for (let i = 0; i < n; i++) {
    const cp =
      rng() < 0.35
        ? pool[Math.floor(rng() * pool.length)]
        : `0x${(rng().toString(16).slice(2) + '0'.repeat(40)).slice(0, 40)}`;
    out.push({
      counterparty: cp,
      direction: rng() < 0.5 ? 'in' : 'out',
      token: tokens[Math.floor(rng() * tokens.length)],
      amount: Math.round(rng() * 10000) / 100,
    });
  }
  return out;
}

function txidFor(self: string, i: number): string {
  return `0x${hashSeed(`${self}:${i}`).toString(16).padStart(8, '0').repeat(8).slice(0, 64)}`;
}

function baseTime(i: number): number {
  return Math.floor(Date.now() / 1000) - 3600 - i * 1800;
}

/** 普通转账（transactionsByClassfy/condition）：仅原生币转账 */
function buildClassfyHits(self: string): unknown[] {
  return transfersOf(self)
    .filter((t) => t.token === 'ETH')
    .map((t, i) => ({
      hash: txidFor(`${self}:native`, i),
      blockHash: `0x${hashSeed(`blk:${self}:${i}`).toString(16).padStart(8, '0').repeat(8).slice(0, 64)}`,
      blockHeight: 21000000 - i * 40,
      blocktime: baseTime(i),
      method: 'ETH transfer',
      from: t.direction === 'out' ? self : t.counterparty,
      to: t.direction === 'out' ? t.counterparty : self,
      value: t.amount,
      realValue: t.direction === 'out' ? -t.amount : t.amount,
      fee: 0.00021,
      isError: false,
      status: '0x1',
      isFromRisk: false,
      isToRisk: false,
    }));
}

/** 代币转账（transfers/condition/token）：USDT / USDC */
function buildTokenTransferHits(self: string): unknown[] {
  return transfersOf(self)
    .filter((t) => t.token !== 'ETH')
    .map((t, i) => {
      const meta = TOKEN_META[t.token];
      return {
        txhash: txidFor(`${self}:erc20`, i),
        blockHeight: 21000000 - i * 40 - 3,
        blocktime: baseTime(i) - 120,
        from: t.direction === 'out' ? self : t.counterparty,
        to: t.direction === 'out' ? t.counterparty : self,
        tokenContractAddress: meta.contract,
        tokenIdLogo: '',
        logoUrl: '',
        symbol: t.token,
        coinName: meta.name,
        tokenType: 'ERC20',
        value: t.amount,
        realValue: t.direction === 'out' ? -t.amount : t.amount,
        methodId: '0xa9059cbb',
        method: 'transfer',
        isRiskStablecoin: false,
        isRiskToken: false,
        isFromRisk: false,
        isToRisk: false,
      };
    });
}

/** 内部调用（internalTx/condition） */
function buildInternalHits(self: string): unknown[] {
  return transfersOf(self)
    .filter((t) => t.token === 'ETH')
    .slice(0, 3)
    .map((t, i) => ({
      txhash: txidFor(`${self}:internal`, i),
      blocktime: baseTime(i) - 300,
      from: t.direction === 'out' ? self : t.counterparty,
      to: t.direction === 'out' ? t.counterparty : self,
      value: t.amount / 10,
      gasUsed: 23000,
      gasLimit: 61000,
      callType: 'call',
      isError: false,
    }));
}

/** 资产列表（holders/token）：首行原生币，其余为代币持仓 */
function buildAssetHits(self: string): unknown[] {
  const rng = mulberry32(hashSeed(`bal:${self}`));
  const ethBalance = Math.round(rng() * 3000) / 100;
  const hits: unknown[] = [
    {
      holderAddress: self,
      tokenContractAddress: '',
      value: ethBalance,
      price: TOKEN_META.ETH.price,
      ethValue: 1,
      usdValue: ethBalance * TOKEN_META.ETH.price,
      symbol: 'ETH',
      coinName: TOKEN_META.ETH.name,
    },
  ];
  for (const t of [
    { symbol: 'USDT', contract: TOKEN_META.USDT.contract, price: 1 },
    { symbol: 'USDC', contract: TOKEN_META.USDC.contract, price: 1 },
    { symbol: 'UNI', contract: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', price: 8.5 },
  ] as const) {
    const amount = Math.round(rng() * 50000 * 100) / 100;
    hits.push({
      holderAddress: self,
      tokenContractAddress: t.contract,
      value: amount,
      price: t.price,
      usdValue: amount * t.price,
      symbol: t.symbol,
      coinName: t.symbol,
    });
  }
  return hits;
}

interface PagedParams {
  offset: number;
  limit: number;
}

function paginate<T>(hits: T[], { offset, limit }: PagedParams): { total: number; hits: T[] } {
  return { total: hits.length, hits: hits.slice(offset, offset + limit) };
}

function send(res: import('http').ServerResponse, body: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function oklinkMockPlugin(): Plugin {
  return {
    name: 'oklink-mock',
    configureServer(server) {
      server.middlewares.use('/okapi', (req, res) => {
        // req.url 形如 /explorer/v2/eth/addresses/0x.../transactionsByClassfy/condition
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = decodeURIComponent(url.pathname);

        const q = url.searchParams;
        const paged: PagedParams = {
          offset: Math.max(0, Number(q.get('offset') ?? '0')),
          limit: Math.min(50, Math.max(1, Number(q.get('limit') ?? '20'))),
        };

        const classfyMatch = /^\/explorer\/v2\/[^/]+\/addresses\/([^/]+)\/transactionsByClassfy\/condition$/.exec(path);
        const tokenTxMatch = /^\/explorer\/v2\/[^/]+\/addresses\/([^/]+)\/transfers\/condition\/token$/.exec(path);
        const mixedMatch = /^\/explorer\/v1\/[^/]+\/addresses\/([^/]+)\/transfers\/condition$/.exec(path);
        const internalMatch = /^\/explorer\/v2\/[^/]+\/addresses\/([^/]+)\/internalTx\/condition$/.exec(path);
        const assetMatch = /^\/explorer\/v2\/[^/]+\/addresses\/([^/]+)\/holders\/token$/.exec(path);
        const totalValueMatch = /^\/explorer\/v2\/[^/]+\/addresses\/([^/]+)\/totalvalue$/.exec(path);

        setTimeout(() => {
          try {
            if (classfyMatch) {
              send(res, { code: 0, msg: '', detailMsg: '', data: paginate(buildClassfyHits(classfyMatch[1]), paged) });
            } else if (tokenTxMatch || mixedMatch) {
              const addr = (tokenTxMatch ?? mixedMatch)![1];
              send(res, { code: 0, msg: '', detailMsg: '', data: paginate(buildTokenTransferHits(addr), paged) });
            } else if (internalMatch) {
              send(res, { code: 0, msg: '', detailMsg: '', data: paginate(buildInternalHits(internalMatch[1]), paged) });
            } else if (assetMatch) {
              const hits = buildAssetHits(assetMatch[1]);
              send(res, { code: 0, msg: '', detailMsg: '', data: { total: hits.length, hits: paginate(hits, paged).hits } });
            } else if (totalValueMatch) {
              const hits = buildAssetHits(totalValueMatch[1]) as Array<{ usdValue: number }>;
              const total = hits.reduce((s, h) => s + (h.usdValue ?? 0), 0);
              send(res, { code: 0, msg: '', detailMsg: '', data: total });
            } else {
              send(res, { code: 404, msg: `mock 未实现该端点: ${path}`, detailMsg: '', data: null });
            }
          } catch (err) {
            send(res, { code: 500, msg: String(err), detailMsg: '', data: null });
          }
        }, 150);
      });
    },
  };
}
