import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult } from '../shared/contracts.js';

export class MockProvider implements CallProvider {
  readonly id = 'mock' as const;
  async check(_config: AppConfig): Promise<CheckResult> { return { ok: true, message: 'Mock 已就绪；不会拨打手机或调用云服务。' }; }
  async dial(request: CallRequest): Promise<CallResult> { return { status: 'completed', callId: `mock-${request.notificationId}`, message: 'Mock 通知链路完成，未拨打真实电话。' }; }
  async cancel(): Promise<CheckResult> { return { ok: true, message: 'Mock 已停止。' }; }
}
