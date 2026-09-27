import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult, EventType } from '../shared/contracts.js';
import { callError, safeCode } from './common.js';

const require = createRequire(import.meta.url);
const sdk = require('@alicloud/dyvmsapi20170525') as typeof import('@alicloud/dyvmsapi20170525');
const { $OpenApiUtil } = require('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
const { RuntimeOptions } = require('@darabonba/typescript') as typeof import('@darabonba/typescript');

type Client = InstanceType<typeof sdk.default>;
export type AliyunClient = Pick<Client, 'singleCallByTtsWithOptions' | 'queryCallDetailByCallIdWithOptions'>;
export type AliyunClientFactory = (config: AppConfig) => AliyunClient;
export const makeAliyunClient: AliyunClientFactory = config => new sdk.default(new $OpenApiUtil.Config({
  accessKeyId: config.providers.aliyun.accessKeyId, accessKeySecret: config.providers.aliyun.accessKeySecret,
  regionId: config.providers.aliyun.regionId || 'cn-hangzhou', endpoint: 'dyvmsapi.aliyuncs.com', protocol: 'https',
}));
const runtime = () => new RuntimeOptions({ autoretry: false, maxAttempts: 1, connectTimeout: 10_000, readTimeout: 10_000 });
const statuses: Record<EventType, string> = { task_completed: '已完成', task_failed: '执行失败', task_stalled: '等待处理', retry_exhausted: '重试耗尽', decision_required: '需要您决定', turn_finished: '本轮结束' };

export class AliyunProvider implements CallProvider {
  readonly id = 'aliyun' as const;
  constructor(private readonly clientFactory: AliyunClientFactory = makeAliyunClient, private readonly now = Date.now) {}
  async check(config: AppConfig, options: { remote?: boolean } = {}): Promise<CheckResult> {
    const p = config.providers.aliyun;
    const ok = Boolean(p.accessKeyId && p.accessKeySecret && /^TTS_[A-Za-z0-9]+$/.test(p.ttsCode));
    return { ok, message: !ok ? '请填写阿里云凭据和审核通过的公共模式模板。' : options.remote ? '仅完成本地检查；本版本不通过测试拨号验证凭据。请在阿里云控制台核实企业资质、模板及线路。' : '格式检查通过；企业、场景和模板审核状态尚未验证。' };
  }
  async dial(request: CallRequest, config: AppConfig): Promise<CallResult> {
    const check = await this.check(config);
    if (!check.ok) return { status: 'failed', retryable: false, message: check.message };
    if (!/^\+861\d{10}$/.test(request.to)) return { status: 'failed', retryable: false, message: '本版本阿里云适配仅支持中国大陆 +86 手机通知。' };
    const eventType = request.eventType;
    if (!eventType || !Object.hasOwn(statuses, eventType)) return { status: 'failed', retryable: false, message: '缺少明确事件类型，未向已审核模板传入自由文本。' };
    const params = new sdk.SingleCallByTtsRequest({
      calledNumber: request.to.slice(3), ttsCode: config.providers.aliyun.ttsCode,
      ttsParam: JSON.stringify({ task: 'AI任务', status: statuses[eventType] }),
      playTimes: 1, volume: 100, speed: 0,
      outId: createHash('sha256').update(request.notificationId).digest('hex').slice(0, 15),
    });
    try {
      const response = await this.clientFactory(config).singleCallByTtsWithOptions(params, runtime());
      const body = response.body;
      if (body?.code === 'OK' && body.callId) return { status: 'accepted', callId: body.callId, message: '模板通知已受理；阿里云通知不接收电话回复，请在本机界面操作。' };
      return { status: 'failed', retryable: false, rawCode: safeCode(body), message: '阿里云未受理，请核实资质、公共模板和剩余额度。' };
    } catch (e) { return callError(e); }
  }
  async poll(callId: string, config: AppConfig, createdAt: string): Promise<CallResult> {
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) return { status: 'unknown', callId, retryable: false, message: '通话日期无效，无法可靠查询。' };
    if (this.now() - timestamp < 5 * 60_000) return { status: 'accepted', callId, message: '阿里云记录有同步延迟，五分钟后开始查询。' };
    try {
      const response = await this.clientFactory(config).queryCallDetailByCallIdWithOptions(new sdk.QueryCallDetailByCallIdRequest({ callId, prodId: 11000000300006, queryDate: timestamp }), runtime());
      if (response.body?.code !== 'OK') return { status: 'accepted', callId, message: '暂未取得呼叫详情，不会重新拨号。' };
      const raw = response.body.data;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!data || typeof data !== 'object' || !Object.keys(data).length) return { status: 'accepted', callId, message: '呼叫详情尚未同步。' };
      // A positive duration confirms the call was answered, not task acceptance.
      if (Number(data.duration) > 0 && data.endDate) return { status: 'completed', callId, message: '通知通话已接通并结束；不代表用户已验收任务。' };
      if (data.endDate && Number(data.duration) === 0) return { status: 'failed', callId, retryable: false, message: '呼叫已结束但没有接通。' };
      return { status: 'accepted', callId, message: '呼叫详情尚未达到可确认的终态。' };
    } catch (e) { return { status: 'accepted', callId, message: `查询暂不可用（${safeCode(e)}），不会重新拨号。` }; }
  }
  async cancel(_callId: string, _config: AppConfig): Promise<CheckResult> {
    // CancelCall is documented for ClickToDial, not SingleCallByTts.
    return { ok: false, message: '公共模板通知不支持本应用远程挂断；已发出的一次短语音可能继续播放。请停止后续通知，必要时在服务商控制台核对。' };
  }
}
