import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio';
import type { AppConfig, CallRequest, CallResult } from '../shared/contracts.js';
import { callbackBase } from './common.js';
import { twilioStatus } from './twilio.js';

export interface TwilioCallBinding { request: CallRequest; expiresAt: string; consumed: boolean }
export interface TwilioCallbackContext {
  getConfig(): AppConfig;
  findCallById(callId: string): TwilioCallBinding | undefined | Promise<TwilioCallBinding | undefined>;
  updateCall(callId: string, result: CallResult): void | Promise<void>;
  respondDecision(input: { decisionId: string; optionId: string; callId: string; pin: string }): boolean | Promise<boolean>;
  now?: () => number;
}
const equalPin = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ended = (text: string) => { const xml = new twilio.twiml.VoiceResponse(); xml.say({ language: 'zh-CN', voice: 'Polly.Zhiyu' }, text); xml.hangup(); return xml.toString(); };

/** Mount only on a separate callback listener, never on the management app. */
export async function createTwilioCallbackApp(context: TwilioCallbackContext) {
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  await app.register(formbody);
  const now = context.now ?? Date.now;
  const pinAttempts = new Map<string, number>();
  const verified = new Map<string, { until: number; pin: string; decisionId: string }>();
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: '无效回调。' }));
  for (const path of ['/twilio/status', '/twilio/pin', '/twilio/choice']) {
    app.post(path, async (request, reply) => {
      for (const [id, expiry] of pinAttempts) if (expiry <= now()) { pinAttempts.delete(id); verified.delete(id); }
      const config = context.getConfig();
      const base = callbackBase(config.providers.twilio.callbackBaseUrl);
      const signature = request.headers['x-twilio-signature'];
      const body = request.body as Record<string, string> | undefined;
      if (!base || typeof signature !== 'string' || !body || typeof body !== 'object' || Array.isArray(body) || Object.values(body).some(value => typeof value !== 'string')) return reply.code(403).send({ error: '回调认证失败。' });
      // Use the configured public URL, never Host/X-Forwarded-* supplied by a caller.
      if (!twilio.validateRequest(config.providers.twilio.authToken, signature, `${base}${request.raw.url}`, body)) return reply.code(403).send({ error: '回调认证失败。' });
      const callId = body.CallSid;
      if (!/^CA[a-fA-F0-9]{32}$/.test(callId ?? '')) return reply.code(403).send({ error: '通话未绑定。' });
      const binding = await context.findCallById(callId);
      if (!binding || body.AccountSid !== config.providers.twilio.accountSid || body.To !== binding.request.to || body.From !== config.providers.twilio.from) return reply.code(403).send({ error: '通话未绑定。' });
      if (path === '/twilio/status') {
        const result = twilioStatus(body.CallStatus);
        await context.updateCall(callId, { ...result, callId });
        if (result.status === 'completed' || result.status === 'failed') verified.delete(callId);
        return reply.code(204).send();
      }
      reply.type('application/xml');
      const decision = binding.request.decision;
      const expiry = Date.parse(binding.expiresAt);
      if (!decision || binding.consumed || !Number.isFinite(expiry) || expiry <= now()) return ended('这项选择已结束，请在本机查看最新状态。');
      if (path === '/twilio/pin') {
        if (pinAttempts.has(callId)) return ended('本次密码验证已处理。');
        pinAttempts.set(callId, expiry);
        if (!/^\d{4,12}$/.test(config.controlPin) || !/^\d{4,12}$/.test(body.Digits ?? '') || !equalPin(body.Digits, config.controlPin)) return ended('密码错误，本次通话结束。');
        verified.set(callId, { until: Math.min(expiry, now() + 120_000), pin: config.controlPin, decisionId: decision.id });
        const xml = new twilio.twiml.VoiceResponse();
        const gather = xml.gather({ input: ['dtmf'], numDigits: 1, timeout: 12, action: `${base}/twilio/choice`, method: 'POST' });
        gather.say({ language: 'zh-CN', voice: 'Polly.Zhiyu' }, `${decision.question.slice(0, 200)}。${decision.options.slice(0, 9).map((option, i) => `${option.label.slice(0, 60)}，请按${i + 1}`).join('。')}。`);
        xml.hangup();
        return xml.toString();
      }
      const grant = verified.get(callId);
      verified.delete(callId); // Burn before awaiting the core's atomic decision update.
      if (!grant || grant.until <= now() || grant.decisionId !== decision.id || !/^[1-9]$/.test(body.Digits ?? '')) return ended('回复无效或已经使用，请在本机处理。');
      const option = decision.options[Number(body.Digits) - 1];
      if (!option) return ended('没有对应选项，本次通话结束。');
      const accepted = await context.respondDecision({ decisionId: decision.id, optionId: option.id, callId, pin: grant.pin });
      return ended(accepted ? '已记录您的选择。是否继续执行，以原任务权限为准。' : '选择已过期或任务已变化，请在本机确认。');
    });
  }
  app.addHook('onClose', async () => { verified.clear(); pinAttempts.clear(); });
  return app;
}
