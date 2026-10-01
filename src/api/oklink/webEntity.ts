import { z } from 'zod';
import { getChain } from './chains';
import { ChainApiError, UnsupportedEndpointError } from './client';

const labelResponseSchema = z.object({
  chain: z.string(),
  address: z.string(),
  label: z.string().trim().min(1).nullable(),
  source: z.literal('OKLink'),
});

const serviceErrorSchema = z.object({
  error: z.object({
    code: z.union([z.string().min(1), z.number().finite()]),
    message: z.string().trim().min(1),
  }),
});

function invalidResponse(): ChainApiError {
  return new ChainApiError('INVALID_RESPONSE', '官网查询服务响应格式无效，无法确认地址标签。', { source: 'OKLink', kind: 'response' });
}

/** The local service reads the normal website workflow; no website credentials enter the client. */
export async function fetchOklinkWebEntityLabel(chain: string, address: string): Promise<string | null> {
  const info = getChain(chain);
  if (!info) throw new UnsupportedEndpointError(`${chain} 暂未接入 OKLink 地址标签查询。`, 'OKLink');
  if (!info.addressPattern.test(address)) {
    throw new ChainApiError('INVALID_ADDRESS', '地址格式与所选链不匹配。', { source: 'OKLink', kind: 'business' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const timeoutError = () => new ChainApiError('TIMEOUT', '官网地址标签查询超时，请稍后重试。', { source: 'OKLink', kind: 'network' });
  try {
    let response: Response;
    try {
      const params = new URLSearchParams({ chain, address });
      response = await fetch(`/oklink-web/entity?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ChainApiError('NETWORK', '无法连接官网查询服务，请检查本地服务后重试。', { source: 'OKLink', kind: 'network' });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) throw timeoutError();
      if (response.ok) throw invalidResponse();
    }

    const serviceError = serviceErrorSchema.safeParse(body);
    if (!response.ok) {
      const message = serviceError.success ? serviceError.data.error.message
        : response.status === 401 || response.status === 403
          ? `官网查询服务拒绝访问（HTTP ${response.status}），请稍后重试。`
          : `官网查询服务请求失败（HTTP ${response.status}）。`;
      throw new ChainApiError(response.status, message, { source: 'OKLink', kind: 'http' });
    }
    if (serviceError.success) {
      throw new ChainApiError(serviceError.data.error.code, serviceError.data.error.message, { source: 'OKLink', kind: 'business' });
    }
    if (typeof body === 'object' && body !== null && 'error' in body) throw invalidResponse();
    const parsed = labelResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.chain !== chain) throw invalidResponse();
    const matches = info.kind === 'evm'
      ? parsed.data.address.toLowerCase() === address.toLowerCase()
      : parsed.data.address === address;
    if (!matches) throw invalidResponse();
    return parsed.data.label;
  } finally {
    clearTimeout(timeout);
  }
}
