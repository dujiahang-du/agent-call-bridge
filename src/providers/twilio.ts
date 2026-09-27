import twilio from 'twilio';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult } from '../shared/contracts.js';
import { callbackBase, callError, isE164, safeCode } from './common.js';

export type TwilioClientFactory = (config: AppConfig) => Pick<twilio.Twilio, 'calls' | 'api'>;
export const makeTwilioClient: TwilioClientFactory = config => twilio(config.providers.twilio.accountSid, config.providers.twilio.authToken, { autoRetry: false, maxRetries: 0, timeout: 10_000 });

export function twilioStatus(status: string | undefined): CallResult {
  if (status === 'completed') return { status: 'completed', message: '通话已结束；不代表用户已理解或任务已经验收。' };
  if (status === 'busy' || status === 'no-answer') return { status: 'failed', retryable: true, rawCode: status, message: '占线或无人接听。' };
  if (status === 'failed' || status === 'canceled') return { status: 'failed', retryable: false, rawCode: status, message: '通话失败或已取消。' };
  if (['queued', 'initiated', 'ringing', 'in-progress'].includes(status ?? '')) return { status: 'accepted', message: '服务商已受理，等待通话结果。' };
  return { status: 'unknown', retryable: false, message: '服务商通话状态未知，停止自动重拨。' };
}

export function notificationTwiml(request: CallRequest, config: AppConfig): string {
  const response = new twilio.twiml.VoiceResponse();
  const text = request.text.slice(0, 400);
  if (request.decision) {
    const gather = response.gather({ input: ['dtmf'], numDigits: config.controlPin.length, timeout: 12, method: 'POST', action: `${callbackBase(config.providers.twilio.callbackBaseUrl)}/twilio/pin` });
    gather.say({ language: 'zh-CN', voice: 'Polly.Zhiyu' }, `${text}。如需回复，请输入您设置的电话控制密码。`);
    response.say({ language: 'zh-CN', voice: 'Polly.Zhiyu' }, '未收到输入，本次通话结束。');
  } else response.say({ language: 'zh-CN', voice: 'Polly.Zhiyu' }, text);
  response.hangup();
  return response.toString();
}

export class TwilioProvider implements CallProvider {
  readonly id = 'twilio' as const;
  constructor(private readonly clientFactory: TwilioClientFactory = makeTwilioClient) {}
  async check(config: AppConfig, options: { remote?: boolean } = {}): Promise<CheckResult> {
    const p = config.providers.twilio;
    const checks = [
      { name: '账号', ok: /^AC[a-fA-F0-9]{32}$/.test(p.accountSid) && p.authToken.length >= 16, detail: '需要 Account SID 和 Auth Token。' },
      { name: '主叫', ok: isE164(p.from), detail: '需要可用的 E.164 主叫号码；格式有效不代表线路可用。' },
      { name: 'HTTPS 回调', ok: Boolean(callbackBase(p.callbackBaseUrl)), detail: '公网 HTTPS 回调仅代理独立回调监听端口，不能代理管理界面。' },
    ];
    if (!checks.every(c => c.ok)) return { ok: false, message: 'Twilio 配置不完整。', checks };
    if (!options.remote) return { ok: true, message: '本地格式检查通过，尚未验证账号、线路或回调可达性。', checks };
    try {
      const account = await this.clientFactory(config).api.accounts(p.accountSid).fetch();
      return { ok: account.status === 'active', message: account.status === 'active' ? '账号查询通过；仍需核实地区权限、主叫号码和回调连通性。' : 'Twilio 账号未激活。', checks };
    } catch (e) { return { ok: false, message: `账号查询失败（${safeCode(e)}）。` }; }
  }
  async dial(request: CallRequest, config: AppConfig): Promise<CallResult> {
    if (!isE164(request.to)) return { status: 'failed', retryable: false, message: '被叫号码必须采用 E.164 格式。' };
    if (request.to.startsWith('+86')) return { status: 'failed', retryable: false, rawCode: 'UNSUPPORTED_DESTINATION', message: 'Twilio 官方不支持中国大陆 +86 外呼。' };
    const checked = await this.check(config);
    if (!checked.ok) return { status: 'failed', retryable: false, message: checked.message };
    if (request.decision && (!/^\d{4,12}$/.test(config.controlPin) || request.decision.options.length < 1 || request.decision.options.length > 9)) return { status: 'failed', retryable: false, message: '电话回复需要 4–12 位数字密码及 1–9 个选项。' };
    try {
      const call = await this.clientFactory(config).calls.create({
        to: request.to, from: config.providers.twilio.from, twiml: notificationTwiml(request, config),
        statusCallback: `${callbackBase(config.providers.twilio.callbackBaseUrl)}/twilio/status`,
        statusCallbackMethod: 'POST', statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: 25, timeLimit: 120,
      });
      return { ...twilioStatus(call.status), callId: call.sid };
    } catch (e) { return callError(e); }
  }
  async poll(callId: string, config: AppConfig): Promise<CallResult> {
    try { const call = await this.clientFactory(config).calls(callId).fetch(); return { ...twilioStatus(call.status), callId }; }
    catch (e) { return { status: 'accepted', callId, message: `结果查询暂不可用（${safeCode(e)}），不会重新拨号。` }; }
  }
  async cancel(callId: string, config: AppConfig): Promise<CheckResult> {
    try { await this.clientFactory(config).calls(callId).update({ status: 'completed' }); return { ok: true, message: '已请求终止通话。' }; }
    catch (e) { return { ok: false, message: `无法确认终止结果（${safeCode(e)}）；请到服务商控制台核对。` }; }
  }
}
