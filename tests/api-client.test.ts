import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let client: typeof import('../src/api/oklink/client');
const fetchStub = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  client = await import('../src/api/oklink/client');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function finishRequest<T>(request: Promise<T>): Promise<T> {
  const outcome = request.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

describe.each(['TronScan', 'TronGrid'] as const)('%s HTTP client', source => {
  function request(retries?: number) {
    const fetchApi = source === 'TronScan' ? client.tronscanFetch : client.trongridFetch;
    return fetchApi<{ total: number }>('address/transfers', { address: 'TAddress' }, { retries });
  }

  function successResponse() {
    const data = { total: 7 };
    return Response.json(data);
  }

  it.each([401, 403])('rejects HTTP %s with actionable authorization context without retrying', async status => {
    fetchStub.mockResolvedValue(new Response('Forbidden: private upstream diagnostic', {
      status,
      headers: { 'Content-Type': 'text/plain' },
    }));

    const error = await finishRequest(request()).catch(error => error);

    expect(error).toBeInstanceOf(client.OklinkApiError);
    expect(error).toMatchObject({ code: status, source });
    expect(error.message).toContain(source);
    expect(error.message).toMatch(/上游.*拒绝/);
    expect(error.message).toMatch(/受支持.*接口|授权/);
    expect(error.message).not.toContain('private upstream diagnostic');
    expect(error.message).not.toMatch(/x-apiKey|x-sec-token/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])('recovers after transient HTTP %s', async status => {
    fetchStub.mockResolvedValueOnce(new Response('', { status })).mockResolvedValueOnce(successResponse());

    await expect(finishRequest(request(1))).resolves.toEqual({ total: 7 });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('recovers after a network failure', async () => {
    fetchStub.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(successResponse());

    await expect(finishRequest(request(1))).resolves.toEqual({ total: 7 });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('preserves status and source when HTTP retries are exhausted', async () => {
    fetchStub.mockImplementation(async () => new Response('', { status: 503 }));

    const error = await finishRequest(request(1)).catch(error => error);

    expect(error).toBeInstanceOf(client.OklinkApiError);
    expect(error).toMatchObject({ code: 503, source });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly on invalid JSON without retrying or returning empty data', async () => {
    fetchStub.mockResolvedValue(new Response('<html>Unexpected upstream page</html>', { status: 200 }));

    const error = await finishRequest(request()).catch(error => error);

    expect(error).toBeInstanceOf(client.OklinkApiError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', source });
    expect(error.message).toMatch(/JSON|响应格式/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('keeps non-retryable HTTP errors as failures', async () => {
    fetchStub.mockResolvedValue(new Response('', { status: 404 }));

    const error = await finishRequest(request()).catch(error => error);

    expect(error).toMatchObject({ code: 404, source });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, false],
    [403, false],
    [404, false],
    [429, true],
    [500, true],
  ] as const)('only permits a bounded query retry for transient HTTP %s', async (status, retryable) => {
    fetchStub.mockResolvedValue(new Response('', { status }));
    const error = await finishRequest(request(0)).catch(error => error);

    expect(client.shouldRetryQuery(0, error)).toBe(retryable);
    expect(client.shouldRetryQuery(1, error)).toBe(false);
    expect(client.shouldRetryQuery(2, error)).toBe(false);
  });

  it('preserves network failure context and permits only one query retry', async () => {
    fetchStub.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await finishRequest(request(0)).catch(error => error);

    expect(error).toMatchObject({ code: 'NETWORK', source });
    expect(client.shouldRetryQuery(0, error)).toBe(true);
    expect(client.shouldRetryQuery(1, error)).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('does not retry unreadable response data at the query layer', async () => {
    fetchStub.mockResolvedValue(new Response('{invalid json', { status: 200 }));
    const error = await finishRequest(request(0)).catch(error => error);

    expect(client.shouldRetryQuery(0, error)).toBe(false);
  });

  it('does not retry cancelled requests', async () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    fetchStub.mockRejectedValue(aborted);
    const error = await finishRequest(request()).catch(error => error);

    expect(error).toBe(aborted);
    expect(client.shouldRetryQuery(0, error)).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

it('does not retry a business rejection even when its code resembles HTTP 500', () => {
  const error = new client.ChainApiError(500, '查询参数无效', { source: 'TronScan', kind: 'business' });
  expect(client.shouldRetryQuery(0, error)).toBe(false);
});

it('does not query-retry unsupported endpoints or unknown application errors', () => {
  expect(client.shouldRetryQuery(0, new client.UnsupportedEndpointError('接口不可用'))).toBe(false);
  expect(client.shouldRetryQuery(0, new Error('Invalid address'))).toBe(false);
});

it('normalizes provider paths so slash-prefixed endpoints reach the correct route', async () => {
  fetchStub.mockResolvedValue(Response.json({ total: 0, data: [] }));
  await finishRequest(client.tronscanFetch('/api/transaction', { address: 'TAddress' }));
  expect(fetchStub.mock.calls[0][0]).toBe('/tronscan/api/transaction?address=TAddress');
});

it('aborts a stalled provider request instead of leaving the query pending', async () => {
  fetchStub.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')));
  }));
  const pending = client.tronscanFetch('api/transaction', {}, { retries: 0 });
  const outcome = pending.catch(error => error);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(await outcome).toMatchObject({ source: 'TronScan', code: 'TIMEOUT', kind: 'network' });
});

it.each(['TronScan', 'TronGrid'] as const)('starts %s requests immediately without a local QPS limit', async source => {
  const starts: number[] = [];
  fetchStub.mockImplementation(async () => {
    starts.push(performance.now());
    return Response.json({ success: true, data: [] });
  });
  const request = source === 'TronScan' ? client.tronscanFetch : client.trongridFetch;
  await finishRequest(Promise.all(Array.from({ length: 12 }, (_, index) => request(`accounts/${index}`))));
  expect(starts).toHaveLength(12);
  expect(starts.every(start => start === 0)).toBe(true);
});

it('waits beyond the TronGrid suspension window before retrying 429', async () => {
  const starts: number[] = [];
  fetchStub.mockImplementation(async () => {
    starts.push(performance.now());
    return starts.length === 1 ? new Response('', { status: 429 }) : Response.json({ success: true });
  });
  await finishRequest(client.trongridFetch('v1/accounts/first', {}, { retries: 1 }));
  expect(starts).toHaveLength(2);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(5000);
});

it('pauses new TronGrid requests only after a known 429, then releases them together', async () => {
  const starts: number[] = [];
  fetchStub.mockImplementation(async () => {
    starts.push(performance.now());
    return starts.length === 1 ? new Response('', { status: 429 }) : Response.json({ success: true });
  });
  await expect(finishRequest(client.trongridFetch('v1/accounts/first', {}, { retries: 0 }))).rejects.toMatchObject({ code: 429 });
  await finishRequest(Promise.all([
    client.trongridFetch('v1/accounts/second', {}, { retries: 0 }),
    client.trongridFetch('v1/trc20/info', {}, { retries: 0 }),
  ]));
  expect(starts).toHaveLength(3);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(5000);
  expect(starts[2]).toBe(starts[1]);
});
