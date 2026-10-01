type ApiSource = '数据源' | 'TronScan' | 'Blockscout' | 'TronGrid' | 'OKLink';
type ApiErrorKind = 'http' | 'network' | 'business' | 'response';

interface ApiErrorOptions {
  source?: ApiSource;
  kind?: ApiErrorKind;
}

export class ChainApiError extends Error {
  readonly source: ApiSource;
  readonly kind: ApiErrorKind;

  constructor(
    public code: string | number,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    const source = options.source ?? '数据源';
    super(`${source} 接口错误 ${code}: ${message}`);
    this.name = 'ChainApiError';
    this.source = source;
    this.kind = options.kind ?? 'business';
  }
}

/** 尚未接入的数据源或不支持的功能。 */
export class UnsupportedEndpointError extends ChainApiError {
  constructor(message: string, source: ApiSource = '数据源') {
    super('UNSUPPORTED', message, { source });
    this.name = 'UnsupportedEndpointError';
  }
}

/** No proactive QPS cap; wait only when an upstream rejection requests a cooldown. */
class RequestCooldown {
  private blockedUntil = 0;

  deferFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, performance.now() + ms);
  }

  async acquire(): Promise<void> {
    for (;;) {
      const remaining = this.blockedUntil - performance.now();
      if (remaining <= 0) return;
      await sleep(remaining);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Keep the existing gate interface for provider callers; healthy requests start immediately.
export const rateLimiter = new RequestCooldown();
export const trongridRateLimiter = new RequestCooldown();

interface RequestOptions {
  /** 遇到 429 / 5xx / 网络错误时，在首次请求之后的最大重试次数 */
  retries?: number;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ChainApiError)) return false;
  if (error.kind === 'network') return true;
  const status = Number(error.code);
  return error.kind === 'http' && (status === 429 || (status >= 500 && status < 600));
}

/** 查询层只为暂时性失败追加一次重试，权限、业务和响应格式错误直接展示。 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && isRetryableError(error);
}

async function fetchJson<T>(url: string, init: RequestInit, source: ApiSource): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const timeoutError = () => new ChainApiError('TIMEOUT', '请求超时，请稍后重试。', { source, kind: 'network' });
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ChainApiError('NETWORK', '网络请求失败，请检查网络连接后重试。', { source, kind: 'network' });
    }
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? `上游拒绝访问（HTTP ${response.status}）。${source === 'TronScan'
          ? '此接口需要 TronScan 授权；请在本地 .env.local 配置 TRONSCAN_API_KEY 并重启服务。'
          : source === 'TronGrid' ? '请检查 TronGrid 授权，在本地 .env.local 配置独立的 TRONGRID_API_KEY 并重启服务；它与 TronScan 的 Key 不通用。'
          : '请检查访问授权，或改用服务方受支持的官方接口。'}`
        : source === 'TronGrid' && response.status === 429
          ? '请求被限流，请稍后重试；可在本地 .env.local 配置 TRONGRID_API_KEY 并重启服务以获得独立配额。'
          : `请求失败（HTTP ${response.status}）`;
      throw new ChainApiError(response.status, message, { source, kind: 'http' });
    }
    try {
      return await response.json() as T;
    } catch {
      if (controller.signal.aborted) throw timeoutError();
      throw new ChainApiError('INVALID_RESPONSE', '上游响应不是有效的 JSON，无法读取查询结果。', { source, kind: 'response' });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function providerFetch<T>(
  source: 'TronScan' | 'TronGrid',
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: RequestOptions = {},
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }

  const maxRetries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await (source === 'TronGrid' ? trongridRateLimiter : rateLimiter).acquire();
      const base = source === 'TronGrid' ? '/trongrid' : '/tronscan';
      const json = await fetchJson<T>(`${base}/${path.replace(/^\/+/, '')}?${qs.toString()}`, {
        headers: { Accept: 'application/json' },
      }, source);
      return json;
    } catch (err) {
      lastError = err;
      const throttled = source === 'TronGrid' && err instanceof ChainApiError && err.code === 429;
      if (throttled) trongridRateLimiter.deferFor(6000);
      if (!isRetryableError(err) || attempt === maxRetries) break;
      const pause = throttled ? 6000 : 1000;
      await sleep(pause * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Official APIs use fixed same-origin proxies; optional keys remain in Node. */
export function tronscanFetch<T>(path: string, params: Record<string, string | number | undefined> = {}, options: RequestOptions = {}): Promise<T> {
  return providerFetch<T>('TronScan', path, params, options);
}

export function trongridFetch<T>(path: string, params: Record<string, string | number | undefined> = {}, options: RequestOptions = {}): Promise<T> {
  return providerFetch<T>('TronGrid', path, params, options);
}

/** Compatibility export for callers using the original error class name. */
export { ChainApiError as OklinkApiError };
