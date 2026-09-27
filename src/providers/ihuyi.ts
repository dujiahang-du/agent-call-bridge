import { createHash } from 'node:crypto';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult, EventType } from '../shared/contracts.js';

export type DomesticFetch = (url: string, init: RequestInit) => Promise<Response>;
export const domesticStatuses: Record<EventType, string> = { task_completed: '报告完成', task_failed: '执行失败', task_stalled: '等待处理', retry_exhausted: '重试耗尽', decision_required: '需要您决定', turn_finished: '本轮结束' };
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// 两家国内 HTTP 适配共用：只发送一次，限制响应大小，终止信号覆盖响应体读取。
export async function domesticJson(fetcher: DomesticFetch, url: string, init: RequestInit, timeoutMs: number, external?: AbortSignal): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, { ...init, redirect: 'error', signal });
    signal.throwIfAborted();
    if (!response.ok || !response.body) { await response.body?.cancel(); return undefined; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65_536) { await reader.cancel(); return undefined; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return jsonObject(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { clearTimeout(timer); }
}

const rejected = new Set(['0', '1', '400', '401', '402', '403', '4030', '404', '405', '4050', '40505', '4051', '4052', '406', '407', '4071', '4072', '40722', '4077', '408', '4080', '4081', '4086']);
const uncertain = (): CallResult => ({ status: 'unknown', retryable: false, message: '互亿受理结果无法确认，不会重新拨号；请到服务商控制台核对。' });

export class IhuyiProvider implements CallProvider {
  readonly id = 'ihuyi' as const;
  constructor(private readonly fetcher: DomesticFetch = fetch, private readonly now = Date.now, private readonly timeoutMs = 10_000) {}
  async check(config: AppConfig, _options: { remote?: boolean } = {}): Promise<CheckResult> {
    const p = config.providers.ihuyi;
    const ok = /^[A-Za-z0-9_-]{1,128}$/.test(p.apiId) && /^[\x21-\x7e]{1,256}$/.test(p.apiKey) && /^[1-9]\d{0,19}$/.test(p.templateId);
    return { ok, message: ok ? '仅本地格式检查通过；仍须企业实名、语音通知开通、两变量模板审核及可用余额，未连接服务商。' : '请填写语音通知的 APIID、APIKEY 和审核通过的两变量模板 ID。' };
  }
  async dial(request: CallRequest, config: AppConfig, options: { signal?: AbortSignal } = {}): Promise<CallResult> {
    const check = await this.check(config);
    if (!check.ok) return { status: 'failed', retryable: false, message: check.message };
    if (!/^\+861\d{10}$/.test(request.to)) return { status: 'failed', retryable: false, message: '本版本互亿适配仅支持中国大陆 +86 手机。' };
    if (!request.eventType || !Object.hasOwn(domesticStatuses, request.eventType)) return { status: 'failed', retryable: false, message: '缺少明确事件类型，未提交自由文本。' };
    if (options.signal?.aborted) return { status: 'failed', retryable: false, message: '通知已停止，未提交。' };
    const p = config.providers.ihuyi;
    const mobile = request.to.slice(3), content = `AI任务|${domesticStatuses[request.eventType]}`, time = String(Math.floor(this.now() / 1000));
    const password = createHash('md5').update(p.apiId + p.apiKey + mobile + content + time, 'utf8').digest('hex');
    const body = new URLSearchParams({ account: p.apiId, password, mobile, content, templateid: p.templateId, time });
    try {
      const data = await domesticJson(this.fetcher, 'https://api.ihuyi.com/vm/Submit.json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', Accept: 'application/json' }, body: body.toString() }, this.timeoutMs, options.signal);
      if (!data) return uncertain();
      const code = typeof data.code === 'number' || typeof data.code === 'string' ? String(data.code) : '';
      const callId = typeof data.voiceid === 'string' ? data.voiceid : Number.isSafeInteger(data.voiceid) ? String(data.voiceid) : '';
      if (code === '2' && /^[1-9]\d{0,39}$/.test(callId)) return { status: 'accepted', callId, retryable: false, message: '互亿已受理通知；接听结果须在控制台核对，电话回复尚不支持。' };
      // 官方失败响应可用空值或 0 占位，不能误认为已经生成呼叫。
      if (rejected.has(code) && (!callId || callId === '0')) return { status: 'failed', retryable: false, message: '互亿明确拒绝了本次提交；请核对企业资质、模板、额度与平台限制。' };
      return uncertain();
    } catch { return uncertain(); }
  }
  async cancel(_callId: string, _config: AppConfig): Promise<CheckResult> {
    return { ok: false, message: '互亿通知接口未提供本应用可核实的挂断能力；已受理的短语音可能继续，请在控制台核对。' };
  }
}
