import type { Connect, Plugin } from 'vite';
import { DEMO_E, DEMO_EDGES, DEMO_F } from '../src/demo';

/** Offline ETH/Polygon fixtures using the same response contracts as the live providers. */
const TOKENS = [
  { address_hash: '0xdac17f958d2ee523a2206206994597c13d831ec7', type: 'ERC-20', symbol: 'USDT', name: 'Demo Tether USD', decimals: '6', exchange_rate: '1' },
  { address_hash: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', type: 'ERC-20', symbol: 'USDC', name: 'Demo USD Coin', decimals: '6', exchange_rate: '1' },
];

const LABELS: Record<string, string> = {
  [DEMO_E]: '演示交易所 Binance（模拟标签）',
  [DEMO_F]: '演示交易所 OKX（模拟标签）',
};

function addressRef(address: string) {
  const label = LABELS[address.toLowerCase()];
  return {
    hash: address,
    metadata: label ? { tags: [{ name: label, tagType: 'name' }] } : null,
    public_tags: [],
  };
}

function transactionHash(chain: string, index: number, internal = false): string {
  const prefix = chain === 'ETH' ? 'e' : 'a';
  return `0x${prefix}${(index + (internal ? 100 : 1)).toString(16).padStart(63, '0')}`;
}

function transfers(chain: string, address: string) {
  return DEMO_EDGES.map(([from, to], index) => ({ from, to, index }))
    .filter(row => row.from === address.toLowerCase() || row.to === address.toLowerCase())
    .map(row => ({
      ...row,
      hash: transactionHash(chain, row.index),
      common: {
        from: addressRef(row.from),
        to: addressRef(row.to),
        block_number: 21000000 - row.index,
        timestamp: new Date(Date.UTC(2026, 8, 30, 12) - row.index * 1800000).toISOString(),
      },
    }));
}

function list(items: unknown[]) {
  return { items, next_page_params: null };
}

const middleware: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!/^\/(?:blockscout|tronscan|trongrid|okapi|oksite|oklink-web)(?:\/|$)/.test(url.pathname)) {
    next();
    return;
  }

  function send(status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }

  const match = /^\/blockscout\/(ETH|POLYGON)\/api\/v2\/addresses\/(0x[a-fA-F0-9]{40})(?:\/(transactions|token-transfers|internal-transactions|tokens))?$/.exec(url.pathname);
  if (!match) {
    send(501, { error: '离线演示不支持该接口；演示模式仅提供 Ethereum 和 Polygon 的固定模拟数据。' });
    return;
  }

  const [, chain, address, endpoint] = match;
  const rows = transfers(chain, address);
  if (!endpoint) {
    send(200, {
      ...addressRef(address),
      coin_balance: rows.length ? '12500000000000000000' : '0',
      has_token_transfers: rows.some(row => row.index % 3 !== 0),
    });
  } else if (endpoint === 'transactions') {
    send(200, list(rows.filter(row => row.index % 3 === 0).map(row => ({
      ...row.common,
      hash: row.hash,
      value: '2500000000000000000',
      status: 'ok',
      fee: { value: '210000000000000' },
    }))));
  } else if (endpoint === 'token-transfers') {
    send(200, list(rows.filter(row => row.index % 3 !== 0).map(row => ({
      ...row.common,
      transaction_hash: row.hash,
      log_index: 0,
      token: TOKENS[row.index % 3 - 1],
      total: { value: row.index % 3 === 1 ? '12000000000' : '4500000000', decimals: '6' },
    }))));
  } else if (endpoint === 'internal-transactions') {
    send(200, list(rows.filter(row => row.index % 3 === 0).map(row => ({
      ...row.common,
      transaction_hash: transactionHash(chain, row.index, true),
      index: 0,
      value: '250000000000000000',
      success: true,
    }))));
  } else {
    send(200, list(rows.length ? TOKENS.map((token, index) => ({
      token,
      value: index === 0 ? '25000000000' : '4500000000',
    })) : []));
  }
};

export function providerMockPlugin(): Plugin {
  return {
    name: 'provider-mock',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
