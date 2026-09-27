import type { CallProvider, ProviderId } from '../shared/contracts.js';
import { MockProvider } from './mock.js';
import { TwilioProvider, type TwilioClientFactory } from './twilio.js';
import { AliyunProvider, type AliyunClientFactory } from './aliyun.js';

export function createProviders(options: { twilioClient?: TwilioClientFactory; aliyunClient?: AliyunClientFactory; sip?: CallProvider } = {}): Record<ProviderId, CallProvider> {
  return {
    mock: new MockProvider(), twilio: new TwilioProvider(options.twilioClient), aliyun: new AliyunProvider(options.aliyunClient),
    sip: options.sip ?? {
      id: 'sip',
      async check() { return { ok: false, message: 'SIP 组件尚未载入；不能进行 SIP 通话。' }; },
      async dial() { return { status: 'failed', retryable: false, message: 'SIP 组件尚未载入。' }; },
      async cancel() { return { ok: false, message: 'SIP 组件尚未载入。' }; },
    },
  };
}
