import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let api: typeof import('../src/api/tronscan');
const fetchStub = vi.fn<typeof fetch>();
const address = 'TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb';
const sender = 'TDqSquXBgUCLYvYC4XZgrprLK589dkhSCf';
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  api = await import('../src/api/tronscan');
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

function normal(extra = {}) {
  return { hash: 'normal-hash', block: 123, timestamp: 1704067200000, ownerAddress: sender,
    toAddress: address, contractType: 1, confirmed: true, revert: false, contractRet: 'SUCCESS',
    amount: '9007199254740993000001', contractData: { amount: 9007199254740993000000 },
    fee: '', cost: { fee: 100 }, ...extra };
}

function transfer(extra = {}) {
  return { transaction_id: 'token-hash', event_index: 0, block: 456, block_ts: 1704067200000,
    from_address: sender, to_address: address, contract_address: contract,
    quant: '9007199254740993000000001', contractRet: 'SUCCESS', confirmed: true,
    tokenInfo: { tokenAbbr: 'USDT', tokenDecimal: 18, tokenType: 'trc20' },
    event_type: 'Transfer', contract_type: 'trc20', ...extra };
}

function list(data: unknown[], total = data.length) {
  return Response.json({ total, rangeTotal: total, data });
}

describe('TronScan source adaptation', () => {
  it('uses balanceStr to preserve TRX units and does not invent total USD valuation', async () => {
    fetchStub.mockResolvedValue(Response.json({ address, balanceStr: '9007199254740993000001',
      balance: 9007199254740993000000, totalTransactionCount: 120, date_created: 1704067200000,
      latest_operation_time: 1704153600000 }));
    const asset = await finish(api.fetchTronscanAsset(address));
    expect(asset).toMatchObject({ address, chainShortName: 'TRON', dataSource: 'TronScan',
      balance: '9007199254740993.000001', balanceSymbol: 'TRX', transactionCount: '120',
      firstTransactionTime: '1704067200', lastTransactionTime: '1704153600' });
    expect(asset.totalTokenValue).toBeUndefined();
    expect(asset.warnings?.join(' ')).toMatch(/总估值.*未提供/);
    expect(String(fetchStub.mock.calls[0][0])).toBe(`/tronscan/api/accountv2?address=${address}`);
  });

  it('uses only safe integer native balances when the string field is unavailable', async () => {
    fetchStub.mockResolvedValueOnce(Response.json({ address, balance: 1234567 }))
      .mockResolvedValueOnce(Response.json({ address, balance: 9007199254740992 }));
    expect((await finish(api.fetchTronscanAsset(address))).balance).toBe('1.234567');
    await expect(finish(api.fetchTronscanAsset(address))).rejects.toMatchObject({ source: 'TronScan', kind: 'response' });
  });

  it('maps only TRC20 holdings with exact raw balance and authentic upstream valuation', async () => {
    fetchStub.mockResolvedValue(Response.json({ code: 200, total: 21, data: [
      { tokenId: contract, tokenAbbr: 'USDT', tokenName: 'Tether USD', tokenType: 'trc20',
        tokenDecimal: 18, balance: '9007199254740993000000001', quantity: 9007199.254740993,
        tokenPriceInUsd: 1, amountInUsd: '9007199.254740993000000001' },
      { tokenId: '_', tokenType: 'trc10', tokenDecimal: 6, balance: '1000000' },
      { tokenId: 'nft', tokenType: 'trc721', tokenDecimal: 0, balance: '1' },
      { tokenId: 'unknown-decimals', tokenType: 'trc20', balance: '12' },
    ] }));
    const result = await finish(api.fetchTronscanTokenBalances(address, 2, 20));
    expect(result).toMatchObject({ dataSource: 'TronScan', totalPage: 2 });
    expect(result.list).toHaveLength(2);
    expect(result.list[0]).toMatchObject({ symbol: 'USDT', token: 'Tether USD', tokenContractAddress: contract,
      holdingAmount: '9007199.254740993000000001', priceUsd: '1', valueUsd: '9007199.254740993000000001' });
    expect(result.list[1].holdingAmount).toBeUndefined();
    const url = new URL(String(fetchStub.mock.calls[0][0]), 'http://local');
    expect(url.pathname).toBe('/tronscan/api/account/tokens');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ address, start: '20', limit: '20', show: '1', hidden: '1' });
  });

  it('preserves ordinary transfer amounts and excludes TRC10 token amounts', async () => {
    fetchStub.mockResolvedValue(list([normal(), normal({ hash: 'trc10', contractType: 2,
      contractData: { amount: 123, asset_name: '1005193' } })]));
    const result = await finish(api.fetchTronscanTransactions(address, 1, 20, 'transaction'));
    expect(result).toMatchObject({ dataSource: 'TronScan', totalPage: 1 });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ txId: 'normal-hash', height: '123', from: sender, to: address,
      transactionTime: '1704067200', amount: '9007199254740993.000001', txFee: '0.0001',
      transactionSymbol: 'TRX', state: 'success' });
  });

  it('does not turn pending or failed contract execution into success', async () => {
    fetchStub.mockResolvedValue(list([normal({ confirmed: false }), normal({ contractRet: 'OUT_OF_ENERGY' }),
      normal({ revert: true }), normal({ confirmed: undefined, contractRet: undefined })]));
    const rows = (await finish(api.fetchTronscanTransactions(address, 1, 20, 'transaction'))).transactions;
    expect(rows.map(row => row.state)).toEqual(['pending', 'fail', 'fail', undefined]);
  });

  it('does not reinterpret a smart contract token amount as native TRX', async () => {
    fetchStub.mockResolvedValue(list([
      normal({ contractType: 31, amount: '123000000', tokenInfo: { tokenAbbr: 'USDT', tokenDecimal: 6 }, contractData: { call_value: 100 } }),
      normal({ contractType: 31, amount: '123000000', contractData: {} }),
    ]));
    const rows = (await finish(api.fetchTronscanTransactions(address, 1, 20, 'transaction'))).transactions;
    expect(rows[0].amount).toBe('0.0001');
    expect(rows[1].amount).toBeUndefined();
  });

  it('preserves zero event indices and does not mix approvals or NFT transfers into TRC20', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: 3, rangeTotal: 3, token_transfers: [transfer(),
      transfer({ event_type: 'Approval' }), transfer({ contract_type: 'trc721', tokenInfo: { tokenType: 'trc721' } })] }));
    const result = await finish(api.fetchTronscanTransactions(address, 1, 20, 'token_20'));
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ txId: 'token-hash', eventIndex: '0', height: '456',
      transactionTime: '1704067200', from: sender, to: address, amount: '9007199.254740993000000001',
      transactionSymbol: 'USDT', tokenContractAddress: contract });
    const url = new URL(String(fetchStub.mock.calls[0][0]), 'http://local');
    expect(url.searchParams.get('relatedAddress')).toBe(address);
    expect(url.searchParams.get('direction')).toBe('all');
  });

  it('does not assume zero decimals when token metadata is missing', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: 1, token_transfers: [transfer({ tokenInfo: { tokenAbbr: 'USDT' } })] }));
    const result = await finish(api.fetchTronscanTransactions(address, 1, 20, 'token_20'));
    expect(result.transactions[0].amount).toBeUndefined();
  });

  it('maps documented native internal calls and estimates pages when the upstream count is -1', async () => {
    fetchStub.mockResolvedValue(list([{ hash: 'outer-hash', internal_hash: 'inner-hash', block: 67416102,
      timestamp: 1732898367000, from: sender, to: address, call_value: 100, token_id: '_',
      confirmed: true, rejected: false, result: 'SUCCESS', revert: false }], -1));
    const result = await finish(api.fetchTronscanTransactions(address, 1, 20, 'internal'));
    expect(result).toMatchObject({ dataSource: 'TronScan', totalPage: 1 });
    expect(result.transactions[0]).toMatchObject({ txId: 'outer-hash', eventIndex: 'inner-hash', height: '67416102',
      transactionTime: '1732898367', from: sender, to: address, amount: '0.0001', transactionSymbol: 'TRX', state: 'success' });
    const url = new URL(String(fetchStub.mock.calls[0][0]), 'http://local');
    expect(url.pathname).toBe('/tronscan/api/internal-transaction');
    // Public endpoint returned HTTP 404 for tokens=_ in the live contract check.
    expect(url.searchParams.has('tokens')).toBe(false);
  });

  it('does not advertise pages beyond the documented 10000-record window', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: 10000, rangeTotal: 1000000, data: [normal()] }));
    expect((await finish(api.fetchTronscanTransactions(address, 1, 20, 'transaction'))).totalPage).toBe(500);
    await expect(finish(api.fetchTronscanTransactions(address, 501, 20, 'transaction'))).rejects.toMatchObject({ source: 'TronScan' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('allows the final partial page without sending an upstream request past the record window', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: 10000, rangeTotal: 10000, data: [normal()] }));
    const result = await finish(api.fetchTronscanTransactions(address, 334, 30, 'transaction'));
    expect(result.totalPage).toBe(334);
    const url = new URL(String(fetchStub.mock.calls[0][0]), 'http://local');
    expect(url.searchParams.get('start')).toBe('9990');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('uses the full upstream page for pagination even when all rows are filtered out', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: -1, rangeTotal: -1, token_transfers: [
      transfer({ event_type: 'Approval' }), transfer({ contract_type: 'trc721' }),
    ] }));
    const result = await finish(api.fetchTronscanTransactions(address, 1, 2, 'token_20'));
    expect(result.transactions).toEqual([]);
    expect(result.totalPage).toBe(2);
  });

  it('reads only the exact queried address public tag, never its counterpart tag', async () => {
    fetchStub.mockResolvedValueOnce(list([normal({ toAddressTag: 'Binance-Cold 2', ownerAddressTag: 'Other exchange' })]))
      .mockResolvedValueOnce(list([normal({ ownerAddress: address, toAddress: sender, ownerAddressTag: 'Binance-Hot 7', toAddressTag: 'Other exchange' })]))
      .mockResolvedValueOnce(list([normal({ toAddressTag: undefined, ownerAddressTag: 'Binance-Cold 2', name: 'Binance' })]));
    expect(await finish(api.fetchTronscanEntityLabel(address))).toBe('Binance-Cold 2');
    expect(await finish(api.fetchTronscanEntityLabel(address))).toBe('Binance-Hot 7');
    expect(await finish(api.fetchTronscanEntityLabel(address))).toBeNull();
  });

  it('accepts an exact-address public contract tag but does not infer an entity from a name or risk flag', async () => {
    fetchStub.mockResolvedValueOnce(Response.json({ data: [], contractInfo: { [address]: { publicTag: 'USDT Token' } } }))
      .mockResolvedValueOnce(Response.json({ data: [], contractInfo: { [address]: { name: 'Binance', risk: false }, [sender]: { publicTag: 'Binance' } } }));
    expect(await finish(api.fetchTronscanEntityLabel(address))).toBe('USDT Token');
    expect(await finish(api.fetchTronscanEntityLabel(address))).toBeNull();
  });

  it.each(['asset', 'holdings', 'transaction', 'token_20', 'internal', 'label'] as const)('propagates denied %s requests as TronScan errors', async kind => {
    fetchStub.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const request = kind === 'asset' ? api.fetchTronscanAsset(address)
      : kind === 'holdings' ? api.fetchTronscanTokenBalances(address, 1, 20)
      : kind === 'label' ? api.fetchTronscanEntityLabel(address)
      : api.fetchTronscanTransactions(address, 1, 20, kind);
    await expect(finish<unknown>(request)).rejects.toMatchObject({ source: 'TronScan', code: 401, kind: 'http' });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { message: 'service failed' }, { data: null }, { data: [{}] }])('rejects malformed transaction data %j instead of a false empty success', async body => {
    fetchStub.mockResolvedValue(Response.json(body));
    await expect(finish(api.fetchTronscanTransactions(address, 1, 20, 'transaction'))).rejects.toMatchObject({ source: 'TronScan', kind: 'response' });
  });

  it('rejects business errors even when they contain an empty data array', async () => {
    fetchStub.mockResolvedValue(Response.json({ code: 403, status: '0', message: 'invalid API key', total: 0, data: [] }));
    await expect(finish(api.fetchTronscanTokenBalances(address, 1, 20))).rejects.toMatchObject({ source: 'TronScan', code: 403, kind: 'business' });
  });

  it('preserves explicitly empty results as one real empty page', async () => {
    fetchStub.mockResolvedValue(Response.json({ total: 0, rangeTotal: 0, token_transfers: [] }));
    expect(await finish(api.fetchTronscanTransactions(address, 1, 20, 'token_20'))).toEqual({ dataSource: 'TronScan', transactions: [], totalPage: 1 });
  });
});
