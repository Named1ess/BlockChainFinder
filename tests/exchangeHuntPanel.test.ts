import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryObserverOptions } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuntRunRow, HuntWalletRow } from '../src/api/db/huntStore';
import type { HuntSnapshot } from '../src/trace/exchangeHunt';
import ExchangeHuntPanel from '../src/components/ExchangeHuntPanel';

type HitPage = { rows: HuntWalletRow[]; total: number };

const state = vi.hoisted(() => ({
  viewRunId: null as string | null,
  initializedSelection: false,
  snapshot: {} as HuntSnapshot,
  hitOptions: undefined as QueryObserverOptions<HitPage> | undefined,
}));

// Seed the history selector for server rendering without a browser or a test-only component prop.
// The panel initializes this null state before rendering any child components.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      if (initial === null && !state.initializedSelection) {
        state.initializedSelection = true;
        return actual.useState(state.viewRunId);
      }
      return actual.useState(initial);
    },
  };
});

vi.mock('../src/trace/useExchangeHunt', () => ({
  useExchangeHunt: () => ({ snapshot: state.snapshot, engine: {} }),
}));

// Keep the real query behavior, retaining the panel's options to exercise a run change below.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery(options: Parameters<typeof actual.useQuery>[0]) {
      if (options.queryKey[0] === 'hunt-hits') state.hitOptions = options as QueryObserverOptions<HitPage>;
      return actual.useQuery(options);
    },
  };
});

function run(id: string, chain: string): HuntRunRow {
  return {
    id, chain, seed: 'seed', startedAt: 1, finishedAt: 2, status: 'hit-target',
    maxWallets: 120, maxNeighbors: 10, hitLimit: 1, tokenFilter: [], scanned: 1,
    tagChecked: 2, depth: 1, hitCount: 1, firstHitDepth: 1, error: null,
  };
}

function hit(id: string): HuntWalletRow {
  return {
    key: `${id}|exchange`, huntId: id, address: 'exchange', parent: 'seed', depth: 1,
    expanded: 0, tag: 'Binance', isHit: 1, path: ['seed', 'exchange'], updatedAt: 1,
  };
}

function clientWithRuns(...runs: HuntRunRow[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['hunt-runs', state.snapshot.runId, state.snapshot.running], runs);
  for (const row of runs) client.setQueryData(['hunt-run-row', row.id], row);
  return client;
}

function render(client: QueryClient): string {
  state.initializedSelection = false;
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(StaticRouter, { location: '/address/ETH/route-seed' },
      createElement(ExchangeHuntPanel, { chain: 'ETH', address: 'route-seed' }))));
}

beforeEach(() => {
  state.viewRunId = null;
  state.hitOptions = undefined;
  state.snapshot = {
    version: 1, running: false, seed: 'seed', chain: 'BSC', runId: 'current', depth: 1,
    scanned: 1, tagChecked: 2, pending: 0, hitCount: 1, hitLimit: 1,
    firstHitDepth: 1, finished: true, error: null, status: 'hit-target', failedRequests: 0,
  };
});

describe('exchange hunt result context', () => {
  it('keeps current global-search wallet and path links on the search chain after route navigation', () => {
    const client = clientWithRuns(run('current', 'BSC'));
    client.setQueryData(['hunt-hits', 'current', 0, 10, 1], { rows: [hit('current')], total: 1 });

    const html = render(client);

    expect(html).toContain('href="/address/BSC/exchange"');
    expect(html).toContain('href="/address/BSC/seed"');
    expect(html).not.toContain('href="/address/ETH/');
    client.clear();
  });

  it('uses the selected historical run chain for every address link', () => {
    state.viewRunId = 'history';
    const client = clientWithRuns(run('current', 'BSC'), run('history', 'TRON'));
    client.setQueryData(['hunt-hits', 'history', 0, 10, 'static'], { rows: [hit('history')], total: 1 });

    const html = render(client);

    expect(html).toContain('href="/address/TRON/exchange"');
    expect(html).toContain('href="/address/TRON/seed"');
    expect(html).not.toContain('href="/address/ETH/');
    expect(html).not.toContain('href="/address/BSC/');
    client.clear();
  });

  it('does not guess a history chain while its run metadata is loading', () => {
    state.viewRunId = 'history';
    const client = clientWithRuns(run('current', 'BSC'));
    client.setQueryData(['hunt-hits', 'history', 0, 10, 'static'], { rows: [hit('history')], total: 1 });

    expect(render(client)).not.toContain('href="/address/');
    client.clear();
  });

  it('does not reuse the previous run hits while a different run is loading', () => {
    const client = clientWithRuns(run('current', 'BSC'), run('history', 'TRON'));
    client.setQueryData(['hunt-hits', 'current', 0, 10, 1], { rows: [hit('current')], total: 1 });
    render(client);
    const observer = new QueryObserver(client, { ...state.hitOptions!, enabled: false });
    expect(observer.getCurrentResult().data?.rows[0].huntId).toBe('current');

    state.viewRunId = 'history';
    render(client);
    observer.setOptions({ ...state.hitOptions!, enabled: false });

    expect(observer.getCurrentResult().data).toBeUndefined();
    observer.destroy();
    client.clear();
  });

  it('shows a failed current run as an error instead of a successful search', () => {
    state.snapshot = { ...state.snapshot, status: 'failed', failedRequests: 0, error: '数据库写入失败' };
    const client = clientWithRuns();

    const html = render(client);

    expect(html).toContain('ant-alert-error');
    expect(html).not.toContain('搜索完成：');
    client.clear();
  });

  it('keeps a partial historical result and its failure details visible while another run is active', () => {
    state.snapshot = { ...state.snapshot, running: true, finished: false };
    state.viewRunId = 'history';
    const history: HuntRunRow = {
      ...run('history', 'TRON'), status: 'partial', failedRequests: 2,
      error: '部分交易请求失败，搜索范围不完整',
    };
    const client = clientWithRuns(history);

    const html = render(client);

    expect(html).toContain('ant-alert-warning');
    expect(html).toContain('部分交易请求失败，搜索范围不完整');
    expect(html).not.toContain('正在第');
    client.clear();
  });
});
