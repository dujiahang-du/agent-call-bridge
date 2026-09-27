import { createHash } from 'node:crypto';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult } from '../shared/contracts.js';

const origin = 'https://www.pushplus.plus';
const paths = { access: '/api/common/openApi/getAccessKey', account: '/api/open/user/myInfo', result: '/api/open/message/sendMessageResult', send: '/send' } as const;
type Json = Record<string, unknown>;
type ApiReply = Json & { code: number };
export type PushplusFetch = (url: string, init: RequestInit) => Promise<Response>;
class RequestFailure extends Error {
  constructor(readonly code: string, readonly definiteRejection = false) { super(code); }
}
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const credential = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/.test(value);
const mainlandPhone = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  if (/^1\d{10}$/.test(value)) return `+86${value}`;
  if (/^861\d{10}$/.test(value)) return `+${value}`;
  return /^\+861\d{10}$/.test(value) ? value : undefined;
};
function shortTitle(request: CallRequest): string {
  const suffix = request.decision ? '。请返回电脑选择。' : '';
  const text = request.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // 按 UTF-16 长度保守截断，避免代理对令普通账号标题超过 100 字限制。
  let title = '';
  for (const char of text) { if (title.length + char.length + suffix.length > 100) break; title += char; }
  return title + suffix;
}

export class PushplusProvider implements CallProvider {
  readonly id = 'pushplus' as const;
  private stopped = false;
  private readonly shutdownSignal = new AbortController();
  private cache?: { identity: string; accessKey: string; expiresAt: number };
  private pending?: { identity: string; promise: Promise<string> };
  private readonly lastPoll = new Map<string, number>();
  constructor(private readonly fetcher: PushplusFetch = (url, init) => fetch(url, init), private readonly now = Date.now) {}

  private localCheck(config: AppConfig): CheckResult {
    if (this.stopped) return { ok: false, message: '服务已停止，未请求 pushplus。' };
    const p = config.providers.pushplus;
    if (!p || !credential(p.token) || !credential(p.secretKey)) return { ok: false, message: '请填写 pushplus 用户 token 和开放接口 secretKey；消息 token 不能用于绑定校验。' };
    if (!config.recipient.consent || !mainlandPhone(`${config.recipient.countryCode}${config.recipient.number}`)) return { ok: false, message: '请设置本人同意接听的中国大陆 +86 手机。' };
    return { ok: true, message: '本地格式检查通过，尚未核实账号、绑定手机、积分或线路。' };
  }

  private async json(path: string, init: RequestInit, signal?: AbortSignal): Promise<ApiReply> {
    const combined = AbortSignal.any([this.shutdownSignal.signal, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const response = await this.fetcher(`${origin}${path}`, { ...init, redirect: 'error', signal: combined, headers: { accept: 'application/json', ...init.headers } });
    combined.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw new RequestFailure(`HTTP_${response.status}`, response.status >= 400 && response.status < 500 && response.status !== 408);
    // 同时限制时长和响应大小；不保存或回显可能含个人资料的服务商响应。
    if (Number(response.headers.get('content-length')) > 65_536) throw new RequestFailure('RESPONSE_TOO_LARGE');
    if (!response.body) throw new RequestFailure('INVALID_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); combined.throwIfAborted();
        if (done) break;
        size += value.length;
        if (size > 65_536) throw new RequestFailure('RESPONSE_TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(body) || typeof body.code !== 'number' || !Number.isInteger(body.code)) throw new RequestFailure('INVALID_RESPONSE');
    return body as ApiReply;
  }

  private async access(config: AppConfig, signal?: AbortSignal): Promise<string> {
    const p = config.providers.pushplus;
    const identity = createHash('sha256').update(p.token).update('\0').update(p.secretKey).digest('hex');
    if (this.cache && this.cache.identity !== identity) this.cache = undefined;
    signal?.throwIfAborted();
    if (this.cache && this.cache.expiresAt > this.now()) return this.cache.accessKey;
    if (this.pending?.identity === identity) return this.pending.promise;
    const promise = (async () => {
      const body = await this.json(paths.access, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: p.token, secretKey: p.secretKey }) }, signal);
      signal?.throwIfAborted();
      if (body.code !== 200 || !object(body.data)) throw new RequestFailure('ACCESS_DENIED', true);
      const { accessKey, expiresIn } = body.data;
      if (!credential(accessKey) || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new RequestFailure('INVALID_ACCESS_RESPONSE');
      if (this.pending?.identity === identity) this.cache = { identity, accessKey, expiresAt: this.now() + Math.max(0, Math.min(expiresIn, 7200) - 60) * 1000 };
      return accessKey;
    })();
    this.pending = { identity, promise };
    try { return await promise; } finally { if (this.pending?.promise === promise) this.pending = undefined; }
  }

  private async verifyAccount(config: AppConfig, signal?: AbortSignal): Promise<CheckResult> {
    const key = await this.access(config, signal); signal?.throwIfAborted();
    const body = await this.json(paths.account, { method: 'GET', headers: { 'access-key': key } }, signal); signal?.throwIfAborted();
    if (body.code !== 200 || !object(body.data)) { this.cache = undefined; return { ok: false, message: '账号资料查询失败；请核对开放接口、secretKey 和出口 IP 白名单。未发起电话。' }; }
    const info = body.data;
    if (info.token !== config.providers.pushplus.token) return { ok: false, message: '无法确认资料所属账号与用户 token 一致，未发起电话。' };
    const bound = mainlandPhone(info.phoneNumber);
    if (!bound) return { ok: false, message: '服务商未返回完整绑定手机号（可能已隐藏），无法安全核对接听目标，未发起电话。' };
    if (bound !== mainlandPhone(`${config.recipient.countryCode}${config.recipient.number}`)) return { ok: false, message: 'pushplus 绑定手机与本地接听号码不一致，未发起电话；请在官网与本地配置核对。' };
    if (info.verifyStatus !== 1) return { ok: false, message: 'pushplus 账号尚未完成个人实名，未发起电话。' };
    if (typeof info.points !== 'number' || !Number.isFinite(info.points) || info.points < 30) return { ok: false, message: 'pushplus 积分不足一次通知，或积分信息无法确认；未发起电话。' };
    return { ok: true, message: '账号、完整绑定手机号、实名状态和当前积分已核对；未拨号，仍不保证线路接通。' };
  }

  async check(config: AppConfig, options: { remote?: boolean } = {}): Promise<CheckResult> {
    const local = this.localCheck(config);
    if (!local.ok || !options.remote) return local;
    try { return await this.verifyAccount(config); }
    catch { return { ok: false, message: 'pushplus 账号只读核对失败或超时；请核对开放接口与出口 IP 白名单。未发起电话。' }; }
  }

  async dial(request: CallRequest, config: AppConfig, options: { signal?: AbortSignal } = {}): Promise<CallResult> {
    const local = this.localCheck(config);
    if (!local.ok) return { status: 'failed', retryable: false, message: local.message };
    if (request.to !== mainlandPhone(`${config.recipient.countryCode}${config.recipient.number}`)) return { status: 'failed', retryable: false, message: '通知目标与当前本人手机配置不一致，未发起电话。' };
    const title = shortTitle(request);
    if (!title.trim()) return { status: 'failed', retryable: false, message: '没有可播报的通知标题，未发起电话。' };
    const signal = AbortSignal.any([this.shutdownSignal.signal, AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
    let sent = false;
    try {
      signal.throwIfAborted();
      const verified = await this.verifyAccount(config, signal); signal.throwIfAborted();
      if (!verified.ok) return { status: 'failed', retryable: false, message: verified.message };
      // 不设置接收人或群组参数，只通知已核对的用户 token 所属手机。
      // 过期时间限制服务商排队延迟，不能代替本地去重。
      const payload = { token: config.providers.pushplus.token, title, content: title, template: 'txt', channel: 'voice', timestamp: this.now() + 60_000 };
      signal.throwIfAborted(); sent = true;
      const body = await this.json(paths.send, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, signal);
      signal.throwIfAborted();
      if (body.code === 200 && typeof body.data === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.data)) return { status: 'accepted', callId: body.data, retryable: false, message: 'pushplus 已受理标题通知，尚未确认发送或接听；电话不支持回复操作。' };
      if ((body.code >= 400 && body.code < 500) || (body.code >= 600 && body.code < 1000)) return { status: 'failed', retryable: false, message: 'pushplus 明确拒绝通知，请在官网核对状态与额度；没有自动重拨。' };
      throw new RequestFailure('INVALID_SEND_RESPONSE');
    } catch (error) {
      if (!sent) return { status: 'failed', retryable: false, message: '绑定核验失败、超时或授权已撤销；未提交电话请求。' };
      if (error instanceof RequestFailure && error.definiteRejection) return { status: 'failed', retryable: false, message: 'pushplus 拒绝请求；没有自动重拨。' };
      return { status: 'unknown', retryable: false, message: '无法确认 pushplus 是否受理（超时、中止或异常响应）；禁止自动重拨，请核对官网记录。' };
    }
  }

  async poll(callId: string, config: AppConfig, createdAt: string): Promise<CallResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId) || !Number.isFinite(Date.parse(createdAt))) return { status: 'unknown', retryable: false, message: '通知查询标识或日期无效，禁止自动重拨。' };
    const waiting: CallResult = { status: 'accepted', callId, retryable: false, message: '等待 pushplus 更新发送状态；不会重新拨号。' };
    if (this.now() - Date.parse(createdAt) < 15_000 || this.now() - (this.lastPoll.get(callId) ?? 0) < 15_000) return waiting;
    this.lastPoll.set(callId, this.now());
    if (this.lastPoll.size > 1000) this.lastPoll.delete(this.lastPoll.keys().next().value!);
    try {
      const key = await this.access(config);
      const body = await this.json(`${paths.result}?shortCode=${encodeURIComponent(callId)}`, { method: 'GET', headers: { 'access-key': key } });
      if (body.code !== 200 || !object(body.data)) { this.cache = undefined; throw new RequestFailure('POLL_FAILED'); }
      const status = body.data.status;
      if (status === 0 || status === 1) return waiting;
      this.lastPoll.delete(callId);
      if (status === 2) return { status: 'completed', callId, retryable: false, message: 'pushplus 报告消息已发送；接口未证明电话接听或听完，也不代表任务验收。' };
      if (status === 3) return { status: 'failed', callId, retryable: false, message: 'pushplus 报告发送失败；未自动重拨，请在官网核对积分退还。' };
      throw new RequestFailure('UNKNOWN_STATUS');
    } catch { return { status: 'unknown', callId, retryable: false, message: 'pushplus 发送结果暂不可确认，已停止轮询和自动重拨；请核对官网记录。' }; }
  }

  async cancel(_callId: string, _config: AppConfig): Promise<CheckResult> {
    return { ok: false, message: 'pushplus 未提供本适配可用的远程挂断；已受理通知可能继续拨出。停止会阻止本地后续通知。' };
  }
  async shutdown(): Promise<CheckResult> {
    this.stopped = true; this.shutdownSignal.abort(); this.cache = undefined; this.pending = undefined; this.lastPoll.clear();
    return { ok: true, message: '已停止本地 pushplus 请求；不能保证服务商已受理的电话取消。' };
  }
}
