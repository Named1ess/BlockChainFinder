import { getChain } from './chains';

/**
 * 交易所实体标签识别。
 *
 * 原理：OKLink 地址页是服务端渲染（SSR），页面 HTML 里直接内嵌了该地址的
 * 实体标签明文，例如：
 *   - 「Binance. DepositAndWithdraw_10」= 币安用户充值/提现钱包（第 10 组）
 *   - 「Gate.io. Hot wallet」等热钱包标签
 *
 * 因此无需任何签名或 Key，抓取地址页 SSR HTML 并解析即可判断一个地址
 * 属于哪个交易所（Gate / OKX / Binance / Bybit …）。结果按地址缓存。
 */

/** 同一地址的标签在会话内基本不变，做进程内缓存避免重复拉取 ~55KB 的 HTML */
const cache = new Map<string, string | null>();

/**
 * 从 OKLink 地址页 SSR HTML 中提取实体标签文本。
 * 页面结构：地址标题处的实体标签形如
 *   `<div class="text-ellipsis"># <!-- -->Binance. DepositAndWithdraw_1<span></span></div>`
 * 注意：OKLink 反爬会在 SSR 中截断标签尾部数字（客户端解密补全），
 * 但交易所名称前缀始终完整，足以判断归属。
 */
export function extractTagFromAddressHtml(html: string): string | null {
  // 移除 React SSR 注释节点，便于拼接被拆分的文本
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = /text-ellipsis[^>]*>#\s*([\s\S]{0,200}?)<\/div>/.exec(cleaned);
  if (!m) return null;
  const text = m[1]
    .replace(/<[^>]+>/g, '') // 去掉内嵌标签
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * 查询地址的交易所实体标签；无标签（普通个人地址）返回 null。
 * 内部带缓存；网络失败同样返回 null（标签缺失不影响主流程）。
 */
export async function fetchAddressEntityLabel(chain: string, address: string): Promise<string | null> {
  const key = `${chain}:${address}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const info = getChain(chain);
  let label: string | null = null;
  try {
    if (info) {
      const res = await fetch(`/oksite/${info.siteSlug}/address/${address}`, {
        headers: { Accept: 'text/html' },
      });
      if (res.ok) {
        label = extractTagFromAddressHtml(await res.text());
      }
    }
  } catch {
    label = null;
  }
  cache.set(key, label);
  return label;
}
