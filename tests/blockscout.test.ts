import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('../src/api/blockscout');
const fetchStub = vi.fn<typeof fetch>();
const address = '0x000000000000000000000000000000000000dEaD';
const sender = '0x1111111111111111111111111111111111111111';
const contract = '0x2222222222222222222222222222222222222222';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  api = await import('../src/api/blockscout');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function finish<T>(request: Promise<T>): Promise<T> {
  const outcome = request.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

function transaction(index: number, extra = {}) {
  return {
    hash: `hash-${index}`, from: { hash: sender }, to: { hash: address },
    block_number: 123, timestamp: '2024-01-01T00:00:00.000000Z',
    value: '1000000000000000001', status: 'ok', fee: { type: 'actual', value: '21000000000000' },
    decoded_input: { method_id: 'a9059cbb' }, ...extra,
  };
}

function token(extra = {}) {
  return { address_hash: contract, symbol: 'TEST', name: 'Test token', type: 'ERC-20', decimals: '18', exchange_rate: null, ...extra };
}

function page(items: unknown[], next: Record<string, string | number | null> | null = null) {
  return Response.json({ items, next_page_params: next });
}

describe('Blockscout source adaptation', () => {
  it('classifies access denial so search and query retries can reject it', async () => {
    fetchStub.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const error = await finish(api.fetchBlockscoutAsset('ETH', address)).catch((value: unknown) => value);
    const { OklinkApiError, shouldRetryQuery } = await import('../src/api/oklink/client');
    expect(error).toBeInstanceOf(OklinkApiError);
    expect(error).toMatchObject({ source: 'Blockscout', kind: 'http', code: 403 });
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it('preserves native balance precision and does not fabricate a complete asset valuation', async () => {
    fetchStub.mockResolvedValue(Response.json({ hash: address, coin_balance: '123456789012345678901234567890', exchange_rate: '3000' }));
    const asset = await finish(api.fetchBlockscoutAsset('ETH', address));
    expect(asset).toMatchObject({ address, chainShortName: 'ETH', balance: '123456789012.34567890123456789', balanceSymbol: 'ETH', dataSource: 'Blockscout' });
    expect(asset.totalTokenValue).toBeUndefined();
    expect(asset.warnings?.join(' ')).toMatch(/总估值.*未提供/);
    expect(fetchStub.mock.calls[0][0]).toBe(`/blockscout/ETH/api/v2/addresses/${address}`);
  });

  it('maps token holdings without rounding their raw integer balance', async () => {
    fetchStub.mockResolvedValue(page([
      { value: '9007199254740993000000001', token: token() },
      { value: '1230000', token: token({ decimals: '6', exchange_rate: '1.01' }) },
      { value: '10', token: token({ decimals: null }) },
    ]));
    const result = await finish(api.fetchBlockscoutTokenBalances('POLYGON', address, 1, 20));
    expect(result).toMatchObject({ dataSource: 'Blockscout', totalPage: 1 });
    expect(result.list[0]).toMatchObject({ symbol: 'TEST', token: 'Test token', tokenContractAddress: contract, holdingAmount: '9007199.254740993000000001' });
    expect(result.list[1]).toMatchObject({ holdingAmount: '1.23', priceUsd: '1.01' });
    expect(result.list[2].holdingAmount).toBeUndefined();
    expect(fetchStub.mock.calls[0][0]).toBe(`/blockscout/POLYGON/api/v2/addresses/${address}/tokens?type=ERC-20`);
  });

  it('maps normal transactions, exact fees and pending state', async () => {
    fetchStub.mockResolvedValue(page([transaction(0), transaction(1, { status: 'error' }), transaction(2, { status: null, timestamp: null, block_number: null })]));
    const result = await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20, 'transaction'));
    expect(result.transactions[0]).toMatchObject({ txId: 'hash-0', from: sender, to: address, height: '123', transactionTime: '1704067200', amount: '1.000000000000000001', txFee: '0.000021', methodId: 'a9059cbb', state: 'success', transactionSymbol: 'ETH' });
    expect(result.transactions[1].state).toBe('fail');
    expect(result.transactions[2].state).not.toBe('success');
    expect(result.transactions[2].transactionTime).toBeUndefined();
  });

  it('preserves zero token log indices and maps ERC-20 units and real addresses', async () => {
    fetchStub.mockResolvedValue(page([{ transaction_hash: 'tx-token', from: { hash: sender }, to: { hash: address }, log_index: 0, block_number: 123, timestamp: '2024-01-01T00:00:00Z', total: { value: '1234567', decimals: '6' }, token: token({ decimals: '6' }) }]));
    const result = await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20, 'token_20'));
    expect(result.transactions[0]).toMatchObject({ txId: 'tx-token', from: sender, to: address, eventIndex: '0', amount: '1.234567', tokenContractAddress: contract, transactionSymbol: 'TEST', transactionTime: '1704067200' });
    expect(fetchStub.mock.calls[0][0]).toBe(`/blockscout/ETH/api/v2/addresses/${address}/token-transfers?type=ERC-20`);
  });

  it('maps internal transfers and their failure status', async () => {
    fetchStub.mockResolvedValue(page([{ transaction_hash: 'tx-internal', from: { hash: sender }, to: null, created_contract: { hash: contract }, index: 0, block_number: 456, timestamp: '2024-01-01T00:00:00Z', value: '1', success: false }]));
    const result = await finish(api.fetchBlockscoutTransactions('POLYGON', address, 1, 20, 'internal'));
    expect(result.transactions[0]).toMatchObject({ txId: 'tx-internal', from: sender, to: contract, eventIndex: '0', height: '456', amount: '0.000000000000000001', transactionSymbol: 'POL', state: 'fail' });
    expect(fetchStub.mock.calls[0][0]).toBe(`/blockscout/POLYGON/api/v2/addresses/${address}/internal-transactions`);
  });

  it('converts upstream cursor batches to UI pages and shares concurrent requests', async () => {
    fetchStub.mockImplementation(async input => {
      const url = new URL(String(input), 'http://local');
      expect(url.searchParams.has('page')).toBe(false);
      expect(url.searchParams.has('limit')).toBe(false);
      if (url.searchParams.get('block_number') === '100') {
        expect(url.searchParams.get('index')).toBe('0');
        return page(Array.from({ length: 15 }, (_, i) => transaction(i + 50)));
      }
      return page(Array.from({ length: 50 }, (_, i) => transaction(i)), { block_number: 100, index: 0, items_count: 50 });
    });
    const [first, third] = await finish(Promise.all([
      api.fetchBlockscoutTransactions('ETH', address, 1, 20, 'transaction'),
      api.fetchBlockscoutTransactions('ETH', address, 3, 20, 'transaction'),
    ]));
    expect(first.transactions).toHaveLength(20);
    expect(first.totalPage).toBeGreaterThan(1);
    expect(third.transactions.map(tx => tx.txId)).toEqual(Array.from({ length: 20 }, (_, i) => `hash-${i + 40}`));
    expect(third.totalPage).toBe(4);
    const last = await finish(api.fetchBlockscoutTransactions('ETH', address, 4, 20, 'transaction'));
    expect(last.transactions.map(tx => tx.txId)).toEqual(['hash-60', 'hash-61', 'hash-62', 'hash-63', 'hash-64']);
    expect(last.totalPage).toBe(4);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('refreshes expired cursor data', async () => {
    fetchStub.mockResolvedValueOnce(page([transaction(0)])).mockResolvedValueOnce(page([transaction(1)]));
    await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20));
    await vi.advanceTimersByTimeAsync(60000);
    const refreshed = await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20));
    expect(refreshed.transactions[0].txId).toBe('hash-1');
  });

  it('evicts old queries instead of retaining every searched address', async () => {
    fetchStub.mockImplementation(async () => page([transaction(fetchStub.mock.calls.length)]));
    const first = await finish(api.fetchBlockscoutTransactions('ETH', 'first-address', 1, 20));
    for (let i = 0; i < 30; i++) await finish(api.fetchBlockscoutTransactions('ETH', `other-address-${i}`, 1, 20));
    const refreshed = await finish(api.fetchBlockscoutTransactions('ETH', 'first-address', 1, 20));
    expect(refreshed.transactions[0].txId).not.toBe(first.transactions[0].txId);
  });

  it('aborts a stalled upstream request instead of leaving the query pending', async () => {
    fetchStub.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    }));
    await expect(finish(api.fetchBlockscoutAsset('ETH', address))).rejects.toThrow(/Blockscout.*超时/);
  });

  it.each([401, 403, 429, 500])('propagates HTTP %s and never turns a denial into an empty page', async status => {
    fetchStub.mockResolvedValue(new Response('private upstream diagnostic', { status }));
    const error = await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20)).catch(error => error);
    expect(error).toMatchObject({ source: 'Blockscout', status });
    expect(error.message).toContain('Blockscout');
    expect(error.message).not.toContain('private upstream diagnostic');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([{ items: null, next_page_params: null }, { message: 'upstream failure' }, { items: [{}], next_page_params: null }])('rejects malformed list response %j', async body => {
    fetchStub.mockResolvedValue(Response.json(body));
    await expect(finish(api.fetchBlockscoutTransactions('ETH', address, 1, 20))).rejects.toThrow(/Blockscout.*响应/);
  });

  it('rejects invalid JSON and malformed address data', async () => {
    fetchStub.mockResolvedValueOnce(new Response('<html>error</html>')).mockResolvedValueOnce(Response.json({}));
    await expect(finish(api.fetchBlockscoutAsset('ETH', address))).rejects.toThrow(/Blockscout.*JSON|Blockscout.*响应/);
    await expect(finish(api.fetchBlockscoutAsset('ETH', address))).rejects.toThrow(/Blockscout.*响应/);
  });

  it('rejects repeated cursors instead of looping or returning duplicate pages', async () => {
    fetchStub.mockImplementation(async () => page([transaction(0)], { index: 1 }));
    await expect(finish(api.fetchBlockscoutTransactions('ETH', address, 2, 20))).rejects.toThrow(/Blockscout.*分页/);
  });

  it('does not send unsupported chains to an unrelated explorer', async () => {
    await expect(finish(api.fetchBlockscoutAsset('BSC', address))).rejects.toThrow(/不支持/);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('Blockscout public entity labels', () => {
  function metadataTag(name: string, tagType = 'name') {
    return { name, tagType, slug: name.toLowerCase().replace(/ /g, '-'), ordinal: 0, meta: {} };
  }

  function addressInfo(extra = {}) {
    return { hash: address, coin_balance: '1000000000000000001', has_token_transfers: false, metadata: null, public_tags: [], ...extra };
  }

  function transfer(from: unknown, to: unknown) {
    return { transaction_hash: 'labeled-transfer', from, to, log_index: 0, block_number: 123, timestamp: '2024-01-01T00:00:00Z', total: { value: '1', decimals: '18' }, token: token() };
  }

  it('reads public metadata and shares the address request with concurrent asset loading', async () => {
    fetchStub.mockResolvedValue(Response.json(addressInfo({
      metadata: { tags: [metadataTag('Bittrex: Hot Wallet'), metadataTag('Bittrex', 'protocol'), metadataTag('Exchange', 'generic')] },
      name: 'Binance', private_tags: [{ display_name: 'OKX' }], watchlist_names: [{ display_name: 'Gate.io' }],
    })));
    const [label, asset] = await finish(Promise.all([
      api.fetchBlockscoutEntityLabel('ETH', address), api.fetchBlockscoutAsset('ETH', address.toLowerCase()),
    ]));
    expect(label).toBe('Bittrex: Hot Wallet; Bittrex');
    expect(asset.balance).toBe('1.000000000000000001');
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('uses approved public tags only when their address matches the queried address', async () => {
    fetchStub.mockResolvedValue(Response.json(addressInfo({ public_tags: [
      { address_hash: sender, display_name: 'Binance', label: 'binance' },
      { address_hash: address.toLowerCase(), display_name: ' Gate.io: Hot Wallet ', label: 'gate-io' },
    ] })));
    expect(await finish(api.fetchBlockscoutEntityLabel('POLYGON', address))).toBe('Gate.io: Hot Wallet');
  });

  it('uses matching address metadata in the first transfer batch without attributing its counterparty', async () => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo({ has_token_transfers: true })))
      .mockResolvedValueOnce(page([
        transfer({ hash: sender, metadata: { tags: [metadataTag('Binance')] } }, { hash: address.toLowerCase(), metadata: { tags: [metadataTag('Bittrex: Hot Wallet')] } }),
      ], { block_number: 122, log_index: 0 }));
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBe('Bittrex: Hot Wallet');
    const transactions = await finish(api.fetchBlockscoutTransactions('ETH', address, 1, 1, 'token_20'));
    expect(transactions.transactions[0].txId).toBe('labeled-transfer');
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1][0]).toBe(`/blockscout/ETH/api/v2/addresses/${address}/token-transfers?type=ERC-20`);
  });

  it('returns and caches null for a successful unlabeled lookup without trusting nicknames or private tags', async () => {
    fetchStub.mockResolvedValue(Response.json(addressInfo({
      name: 'Binance', ens_domain_name: 'binance.eth', private_tags: [{ display_name: 'Binance' }],
      watchlist_names: [{ display_name: 'Binance' }], metadata: { tags: [metadataTag('Binance', 'generic')] },
    })));
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBeNull();
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address.toLowerCase()))).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('returns null when the first transfer batch has no matching public label and does not scan history', async () => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo({ has_token_transfers: true })))
      .mockResolvedValueOnce(page([transfer({ hash: sender, metadata: { tags: [metadataTag('Binance')] } }, { hash: address, metadata: null })], { block_number: 122, log_index: 0 }));
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('propagates label request failures and retries them on the next call', async () => {
    fetchStub.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(Response.json(addressInfo({ metadata: { tags: [metadataTag('Bittrex')] } })));
    await expect(finish(api.fetchBlockscoutEntityLabel('ETH', address))).rejects.toMatchObject({ source: 'Blockscout', status: 403 });
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBe('Bittrex');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not hide or cache a failed transfer enrichment as an unlabeled address', async () => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo({ has_token_transfers: true })))
      .mockResolvedValueOnce(new Response('Service unavailable', { status: 503 }))
      .mockResolvedValueOnce(page([transfer({ hash: address, metadata: { tags: [metadataTag('Bittrex')] } }, { hash: sender })]));
    await expect(finish(api.fetchBlockscoutEntityLabel('ETH', address))).rejects.toMatchObject({ source: 'Blockscout', status: 503 });
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBe('Bittrex');
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it.each([
    { metadata: { tags: null } },
    { metadata: { tags: [{ name: 'Binance' }] } },
    { public_tags: [{ label: 'Binance' }] },
    { hash: sender },
  ])('rejects malformed or mismatched address metadata %j', async extra => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo(extra)))
      .mockResolvedValueOnce(Response.json(addressInfo()));
    await expect(finish(api.fetchBlockscoutEntityLabel('ETH', address))).rejects.toThrow(/Blockscout.*响应/);
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBeNull();
  });

  it('rejects malformed transfer enrichment and permits a later successful lookup', async () => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo({ has_token_transfers: true })))
      .mockResolvedValueOnce(page([{ from: null, to: { hash: address } }]))
      .mockResolvedValueOnce(page([]));
    await expect(finish(api.fetchBlockscoutEntityLabel('ETH', address))).rejects.toThrow(/Blockscout.*响应/);
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBeNull();
  });

  it('expires successful labels and keeps chain-specific labels separate', async () => {
    fetchStub.mockResolvedValueOnce(Response.json(addressInfo({ metadata: { tags: [metadataTag('Bittrex')] } })))
      .mockResolvedValueOnce(Response.json(addressInfo({ metadata: { tags: [metadataTag('Gate.io')] } })))
      .mockResolvedValueOnce(Response.json(addressInfo()));
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBe('Bittrex');
    expect(await finish(api.fetchBlockscoutEntityLabel('POLYGON', address))).toBe('Gate.io');
    await vi.advanceTimersByTimeAsync(60000);
    expect(await finish(api.fetchBlockscoutEntityLabel('ETH', address))).toBeNull();
  });
});
