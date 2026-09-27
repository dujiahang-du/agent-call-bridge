import type { CallResult } from '../shared/contracts.js';

export const isE164 = (value: string): boolean => /^\+[1-9]\d{6,14}$/.test(value);

export function callbackBase(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return value.replace(/\/+$/, '');
  } catch { return undefined; }
}

// Provider errors may embed credentials, request URLs or full phone numbers.
// Keep the useful machine code, but never forward the provider's message.
export function safeCode(error: unknown): string {
  const value = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof value === 'number' || (typeof value === 'string' && /^[A-Za-z_.0-9-]{1,70}$/.test(value)) ? String(value) : 'PROVIDER_ERROR';
}

export function callError(error: unknown): CallResult {
  const e = error as { status?: number; statusCode?: number } | undefined;
  const status = e?.status ?? e?.statusCode;
  const rawCode = safeCode(error);
  if (status && status >= 400 && status < 500) {
    return { status: 'failed', retryable: status === 429, rawCode, message: status === 429 ? '服务商限流，等待本地重试策略处理。' : '服务商拒绝请求，请检查账号、号码和权限。' };
  }
  // A timeout, disconnect or 5xx can happen after the provider accepted a call.
  return { status: 'unknown', retryable: false, rawCode, message: '无法确定服务商是否受理，已停止自动重拨，请核对服务商记录。' };
}
