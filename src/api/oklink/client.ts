/**
 * OKLink 网页端（www.oklink.com）数据接口的浏览器端 HTTP 客户端。
 *
 * 与开放平台 API 不同，网页端接口无需用户申请 API Key：
 * 页面 JS 会动态生成 `x-apiKey` 请求头，算法为
 *   base64( rotate8(WEB_KEY) | (Date.now() + 1111111111111) + 3位随机数 )
 * 其中 WEB_KEY 是 OKLink 前端公开内置的固定字符串。
 *
 * 所有请求走同源路径 /okapi/explorer/...，由 Vite dev server（或生产环境代理层）
 * 转发到 https://www.oklink.com/api/explorer/...，规避浏览器跨域限制。
 */

const API_BASE = '/okapi/explorer';

/** OKLink 网页前端内置的公开 Key */
const WEB_API_KEY = 'a2c903cc-b31e-4547-9299-b6d07b7631ab';
/** 时间戳混淆偏移量（与网页端一致） */
const TIME_OFFSET = 1111111111111;

function randDigit(): string {
  return String(Math.floor(Math.random() * 10));
}

/** 复现网页端的 x-apiKey 生成算法 */
export function makePageApiKey(): string {
  const rotated = WEB_API_KEY.slice(8) + WEB_API_KEY.slice(0, 8);
  const obfuscatedTime = String(Date.now() + TIME_OFFSET) + randDigit() + randDigit() + randDigit();
  return btoa(`${rotated}|${obfuscatedTime}`);
}

export class OklinkApiError extends Error {
  constructor(
    public code: string | number,
    message: string,
  ) {
    super(`OKLink 接口错误 ${code}: ${message}`);
    this.name = 'OklinkApiError';
  }
}

/** TRON 普通转账/代币转账列表受页面端签名网关保护，暂不可直连 */
export class UnsupportedEndpointError extends OklinkApiError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
    this.name = 'UnsupportedEndpointError';
  }
}

/** 令牌桶限流器：默认突发 3 次、每秒补充 qps 个令牌 */
class TokenBucket {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(
    private capacity: number,
    private refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSecond);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(1000 / this.refillPerSecond);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const qpsFromEnv = Number(import.meta.env.VITE_OKLINK_QPS ?? '');
export const rateLimiter = new TokenBucket(3, Number.isFinite(qpsFromEnv) && qpsFromEnv > 0 ? qpsFromEnv : 2);

interface RequestOptions {
  /** 遇到 429 / 5xx / 网络错误时的最大尝试次数 */
  retries?: number;
}

/** 页面端接口响应信封：{ code: 0, msg, data } */
interface PageEnvelope<T> {
  code?: number | string;
  msg?: string;
  detailMsg?: string;
  data?: T;
}

export async function pageApiFetch<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: RequestOptions = {},
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }

  const maxRetries = options.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rateLimiter.acquire();
      const res = await fetch(`${API_BASE}/${path}?${qs.toString()}`, {
        headers: {
          'x-apiKey': makePageApiKey(),
          Accept: 'application/json',
        },
      });

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new OklinkApiError(res.status, `请求失败（HTTP ${res.status}）`);
      }

      const json = (await res.json()) as PageEnvelope<T>;
      if (json.code !== 0 && json.code !== '0') {
        // 业务错误不重试
        throw new OklinkApiError(json.code ?? '?', json.msg || json.detailMsg || '未知错误');
      }
      return json.data as T;
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof Error && !!(err.message.startsWith('HTTP 429') || /^HTTP 5\d\d$/.test(err.message));
      if (!isRetryable || attempt === maxRetries) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
