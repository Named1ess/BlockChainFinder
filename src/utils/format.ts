import dayjs from 'dayjs';

export function shortAddress(a: string, head = 6, tail = 4): string {
  if (!a) return '';
  if (a.length <= head + tail + 2) return a;
  return `${a.slice(0, head)}...${a.slice(-tail)}`;
}

export function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatAmount(v: string | number | null | undefined, digits = 6): string {
  const n = toNum(v);
  if (n === null) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatUsd(v: string | number | null | undefined): string {
  const n = toNum(v);
  if (n === null) return '-';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function formatTime(value: string | number | null | undefined): string {
  const n = toNum(value);
  if (n === null || n <= 0) return '-';
  // OKLink 部分端点返回毫秒、部分返回秒，按量级自适应
  const ms = n > 1e12 ? n : n * 1000;
  return dayjs(ms).format('YYYY-MM-DD HH:mm:ss');
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // 非安全上下文（如局域网 IP 访问）下的兜底
  const el = document.createElement('textarea');
  el.value = text;
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  return Promise.resolve();
}
