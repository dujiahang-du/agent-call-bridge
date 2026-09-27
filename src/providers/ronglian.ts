import { createHash } from 'node:crypto';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult } from '../shared/contracts.js';
import { domesticJson, domesticStatuses, jsonObject, type DomesticFetch } from './ihuyi.js';

const base = 'https://app.cloopen.com:8883/2013-12-26/Accounts/';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9]{32}$/.test(value);
const uncertain = (): CallResult => ({ status: 'unknown', retryable: false, message: '容联受理结果无法确认，不会重新拨号；请到服务商控制台核对。' });

export class RonglianProvider implements CallProvider {
  readonly id = 'ronglian' as const;
  constructor(private readonly fetcher: DomesticFetch = fetch, private readonly now = Date.now, private readonly timeoutMs = 10_000) {}
  async check(config: AppConfig, _options: { remote?: boolean } = {}): Promise<CheckResult> {
    const p = config.providers.ronglian;
    const textOk = p.templateText.length <= 500 && p.templateText.includes('{status}') && !/[{}]/.test(p.templateText.replaceAll('{status}', '')) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(p.templateText);
    const ok = validId(p.accountSid) && validId(p.appId) && /^[\x21-\x7e]{1,256}$/.test(p.authToken) && textOk;
    return { ok, message: ok ? '仅本地格式检查通过；请确认语音通知权限、服务商许可文本与余额。个人准入尚未确认，未连接服务商。' : '请填写主账户 SID、Auth Token、应用 ID 和服务商许可的通知文本；文本仅允许 {status} 变量。' };
  }
  private auth(config: AppConfig) {
    const p = config.providers.ronglian, date = new Date(this.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return {
      sig: createHash('md5').update(p.accountSid + p.authToken + timestamp, 'utf8').digest('hex').toUpperCase(),
      headers: { Authorization: Buffer.from(`${p.accountSid}:${timestamp}`, 'utf8').toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json;charset=utf-8' },
    };
  }
  async dial(request: CallRequest, config: AppConfig, options: { signal?: AbortSignal } = {}): Promise<CallResult> {
    const check = await this.check(config);
    if (!check.ok) return { status: 'failed', retryable: false, message: check.message };
    if (!/^\+861\d{10}$/.test(request.to)) return { status: 'failed', retryable: false, message: '本版本容联适配仅支持中国大陆 +86 手机。' };
    if (!request.eventType || !Object.hasOwn(domesticStatuses, request.eventType)) return { status: 'failed', retryable: false, message: '缺少明确事件类型，未提交自由文本。' };
    if (options.signal?.aborted) return { status: 'failed', retryable: false, message: '通知已停止，未提交。' };
    const p = config.providers.ronglian, auth = this.auth(config);
    const body = { appId: p.appId, to: request.to.slice(3), mediaTxt: p.templateText.replaceAll('{status}', domesticStatuses[request.eventType]), playTimes: '1' };
    try {
      const data = await domesticJson(this.fetcher, `${base}${p.accountSid}/Calls/LandingCalls?sig=${auth.sig}`, { method: 'POST', headers: auth.headers, body: JSON.stringify(body) }, this.timeoutMs, options.signal);
      if (!data) return uncertain();
      const callId = jsonObject(data.LandingCall)?.callSid;
      if (data.statusCode === '000000' && validId(callId)) return { status: 'accepted', callId, retryable: false, message: '容联已受理通知，等待签名查询结果；电话回复尚不支持。' };
      if (typeof data.statusCode === 'string' && /^\d{6}$/.test(data.statusCode) && data.statusCode !== '000000' && !callId) return { status: 'failed', retryable: false, message: '容联明确拒绝了本次提交；请核对账户、语音通知权限、文本与额度。' };
      return uncertain();
    } catch { return uncertain(); }
  }
  async poll(callId: string, config: AppConfig, createdAt: string): Promise<CallResult> {
    const pending: CallResult = { status: 'accepted', callId, retryable: false, message: '暂未取得可确认的容联通话结果；不会重新拨号，请在控制台核对。' };
    if (!validId(callId) || !(await this.check(config)).ok || !Number.isFinite(Date.parse(createdAt))) return { status: 'unknown', retryable: false, message: '查询参数无效，请在容联控制台核对。' };
    // 避免刚受理仍在振铃时，将尚未接听误记为最终失败。
    if (this.now() - Date.parse(createdAt) < 90_000) return pending;
    const p = config.providers.ronglian, auth = this.auth(config);
    try {
      const data = await domesticJson(this.fetcher, `${base}${p.accountSid}/CallResult?sig=${auth.sig}&callsid=${callId}`, { method: 'GET', headers: auth.headers }, this.timeoutMs);
      if (data?.statusCode !== '000000') return pending;
      const result = jsonObject(data.CallResult), state = result?.state;
      // 官方只有成功/未接听/失败与时长，未明确区分通话中和已结束，不据此释放通话槽。
      if (state === '0' || state === 0) return { ...pending, message: '容联报告呼叫成功，但尚未确认通话结束；不代表任务已验收，请在控制台核对。' };
      if (state === '1' || state === 1 || state === '2' || state === 2) return { ...pending, message: '容联报告未接听或失败，但尚未确认最终结束；不会重拨，请在控制台核对。' };
      return pending;
    } catch { return pending; }
  }
  async cancel(_callId: string, _config: AppConfig): Promise<CheckResult> {
    return { ok: false, message: '本版本未接入容联语音通知的远程挂断；已受理的短语音可能继续，请在控制台核对。' };
  }
}
