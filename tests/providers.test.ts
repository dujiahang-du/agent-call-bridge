import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import twilio from 'twilio';
import { createProviders } from '../src/providers/index.js';
import { TwilioProvider, type TwilioClientFactory } from '../src/providers/twilio.js';
import { AliyunProvider, type AliyunClient } from '../src/providers/aliyun.js';
import { createTwilioCallbackApp, type TwilioCallBinding } from '../src/providers/twilio-callback.js';
import type { AppConfig, CallRequest, CallResult } from '../src/shared/contracts.js';

const require = createRequire(import.meta.url);
const sdk = require('@alicloud/dyvmsapi20170525');
const { $OpenApiUtil } = require('@alicloud/openapi-core');
const sid = `AC${'0'.repeat(32)}`;
const callId = `CA${'1'.repeat(32)}`;
const secret = 'fixture-only-not-a-real-secret';
const recipient = '+15005550009'; // Twilio documented magic test range; never sent to Twilio.
function config(): AppConfig { return {
  mode: 'mock', recipient: { countryCode: '+1', number: '5005550009', consent: true },
  voice: { name: '', rate: 0 }, controlPin: '7531' + '09',
  notification: { enabled: true, types: ['task_completed'], cooldownSeconds: 300, maxPerHour: 3, maxPerDay: 10, stallMinutes: 10, maxRetries: 1 },
  providers: { twilio: { accountSid: sid, authToken: secret, from: '+15005550006', callbackBaseUrl: 'https://callback.example.test/bridge' }, aliyun: { accessKeyId: 'fixture-id', accessKeySecret: secret, ttsCode: 'TTS_FIXTURE', regionId: 'cn-hangzhou' }, sip: { server: '', username: '', password: '', extension: '', port: 5060, transport: 'udp', executable: '' } },
}; }
function request(): CallRequest { return { notificationId: 'notification-fixture', eventId: 'event-fixture', taskId: 'task-fixture', eventType: 'task_completed', to: recipient, text: '任务已完成，检查通过。' }; }

test('default checks and Mock are network-free; unavailable SIP is explicit', async () => {
  const providers = createProviders({ twilioClient: () => { throw new Error('network must not be touched'); }, aliyunClient: () => { throw new Error('network must not be touched'); } });
  for (const id of ['mock', 'twilio', 'aliyun'] as const) assert.equal((await providers[id].check(config())).ok, true);
  assert.equal((await providers.mock.dial(request(), config())).status, 'completed');
  assert.equal((await providers.sip.check(config())).ok, false);
});

test('Twilio official SDK serializes bounded call, callbacks, credentials and escaped Chinese TwiML', async () => {
  const sent: any[] = [];
  const client = twilio(sid, secret, { autoRetry: false, httpClient: { request: async (options: any) => { sent.push(options); return { statusCode: 201, body: JSON.stringify({ sid: callId, status: 'queued' }), headers: {} }; } } as any });
  const provider = new TwilioProvider(() => client);
  const input = request(); input.text = '<任务>&中文';
  const result = await provider.dial(input, config());
  assert.equal(result.status, 'accepted'); assert.equal(result.callId, callId); assert.equal(sent.length, 1);
  const outgoing = sent[0];
  assert.match(outgoing.uri, new RegExp(`/Accounts/${sid}/Calls.json$`));
  assert.equal(outgoing.method, 'post'); assert.equal(outgoing.username, sid); assert.equal(outgoing.password, secret);
  assert.equal(outgoing.data.To, recipient); assert.equal(outgoing.data.Timeout, 25); assert.equal(outgoing.data.TimeLimit, 120);
  assert.equal(outgoing.data.StatusCallback, 'https://callback.example.test/bridge/twilio/status');
  assert.match(outgoing.data.Twiml, /&lt;任务&gt;&amp;中文/); assert.match(outgoing.data.Twiml, /Polly.Zhiyu/);
  assert.equal(outgoing.data.Record, undefined);
});

test('Twilio rejects +86 before SDK and never independently retries unknown acceptance', async () => {
  let calls = 0;
  const factory: TwilioClientFactory = () => ({ calls: { create: async () => { calls++; throw Object.assign(new Error('private provider payload'), { code: 'ETIMEDOUT' }); } } } as any);
  const provider = new TwilioProvider(factory);
  const domestic = { ...request(), to: `+86${'1' + '0'.repeat(10)}` };
  assert.equal((await provider.dial(domestic, config())).rawCode, 'UNSUPPORTED_DESTINATION'); assert.equal(calls, 0);
  const outcome = await provider.dial(request(), config());
  assert.equal(outcome.status, 'unknown'); assert.equal(outcome.retryable, false); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(outcome).includes('private provider payload'));
});

test('Twilio status polling and cancel use existing call without another dial', async () => {
  const sent: any[] = [];
  const provider = new TwilioProvider(() => twilio(sid, secret, { httpClient: { request: async (options: any) => { sent.push(options); return { statusCode: 200, body: JSON.stringify({ sid: callId, status: options.method === 'post' ? 'completed' : 'busy' }), headers: {} }; } } as any }));
  const outcome = await provider.poll(callId, config());
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.retryable, false);
  assert.equal((await provider.cancel(callId, config())).ok, true);
  assert.equal(sent[1].data.Status, 'completed');
  assert.ok(sent.every(s => s.uri.endsWith(`/Calls/${callId}.json`)));
});

test('Twilio +886 reaches only the intercepted SDK; +86 remains blocked before SDK', async () => {
  const sent: any[] = [];
  const provider = new TwilioProvider(() => twilio(sid, secret, { autoRetry: false, httpClient: { request: async (options: any) => { sent.push(options); return { statusCode: 201, body: JSON.stringify({ sid: callId, status: 'queued' }), headers: {} }; } } as any }));
  // Format-only synthetic destination, never sent to a real provider.
  const taiwan = '+886' + '0'.repeat(9);
  assert.equal((await provider.dial({ ...request(), to: taiwan }, config())).status, 'accepted');
  assert.equal(sent.length, 1); assert.equal(sent[0].data.To, taiwan);
  assert.equal((await provider.dial({ ...request(), to: '+86' + '1' + '0'.repeat(10) }, config())).rawCode, 'UNSUPPORTED_DESTINATION');
  assert.equal(sent.length, 1);
});

test('accepted terminal outcomes never redial; only explicit pre-acceptance rate limit permits retry', async () => {
  for (const status of ['busy', 'no-answer']) {
    let calls = 0;
    const provider = new TwilioProvider(() => ({ calls: { create: async () => { calls++; return { sid: callId, status }; } } } as any));
    const outcome = await provider.dial(request(), config());
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.retryable, false); assert.equal(outcome.callId, callId); assert.equal(calls, 1);
  }
  for (const status of [429, 400, 503]) {
    let calls = 0;
    const provider = new TwilioProvider(() => ({ calls: { create: async () => { calls++; throw Object.assign(new Error('fixture error'), { status }); } } } as any));
    const outcome = await provider.dial(request(), config());
    assert.equal(outcome.retryable, status === 429); assert.equal(outcome.status, status === 503 ? 'unknown' : 'failed'); assert.equal(calls, 1);
  }
});

test('dial and signed callback both require a 6–12 digit PIN', async () => {
  for (const length of [4, 5, 6, 12, 13]) {
    const cfg = config(); cfg.controlPin = '7'.repeat(length);
    const input = { ...request(), decision: { id: 'length-fixture', question: '选择', options: [{ id: 'continue', label: '继续' }] } };
    let calls = 0;
    const provider = new TwilioProvider(() => ({ calls: { create: async () => { calls++; return { sid: callId, status: 'queued' }; } } } as any));
    const valid = length >= 6 && length <= 12;
    assert.equal((await provider.dial(input, cfg)).status, valid ? 'accepted' : 'failed'); assert.equal(calls, valid ? 1 : 0);
    const app = await createTwilioCallbackApp({ getConfig: () => cfg, findCallById: () => ({ request: input, expiresAt: new Date(Date.now() + 60_000).toISOString(), consumed: false }), updateCall: () => {}, respondDecision: () => true });
    try {
      const path = '/twilio/pin'; const body = { CallSid: callId, AccountSid: sid, From: cfg.providers.twilio.from, To: recipient, Digits: cfg.controlPin };
      const response = await app.inject({ method: 'POST', url: path, payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(secret, `${cfg.providers.twilio.callbackBaseUrl}${path}`, body) } });
      assert.match(response.body, valid ? /twilio\/choice/ : /密码错误/);
    } finally { await app.close(); }
  }
});

test('Alibaba official SDK generates a verifiable signed request using only approved template fields', async t => {
  let incoming: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    incoming = { url: req.url, method: req.method, headers: req.headers, body };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Code: 'OK', CallId: 'fixture-call', RequestId: 'fixture-request' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const client = new sdk.default(new $OpenApiUtil.Config({ accessKeyId: 'fixture-id', accessKeySecret: secret, endpoint: `127.0.0.1:${port}`, protocol: 'http', regionId: 'cn-hangzhou' }));
  const provider = new AliyunProvider(() => client);
  const input = { ...request(), to: `+86${'1' + '0'.repeat(10)}`, text: 'private content must not reach template', eventType: 'task_failed' as const };
  const outcome = await provider.dial(input, config()); assert.equal(outcome.status, 'accepted');
  const url = new URL(incoming.url, `http://127.0.0.1:${port}`);
  const params = new URLSearchParams(incoming.body || url.search);
  assert.equal(params.get('CalledShowNumber'), null);
  assert.deepEqual(JSON.parse(params.get('TtsParam')!), { task: 'AI任务', status: '执行失败' });
  assert.equal(params.get('CalledNumber'), input.to.slice(3)); assert.equal(params.get('PlayTimes'), '1');
  assert.ok(!incoming.body.includes(input.text)); assert.ok(params.get('OutId')!.length <= 15);
  const auth = incoming.headers.authorization as string;
  assert.match(auth, /^ACS3-HMAC-SHA256 Credential=fixture-id,/);
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)![1];
  const headers = signedHeaders.split(';').map(name => `${name}:${incoming.headers[name].trim()}\n`).join('');
  const canonicalQuery = Array.from(url.searchParams).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`).join('&');
  const payloadHash = createHash('sha256').update(incoming.body).digest('hex');
  assert.equal(incoming.headers['x-acs-content-sha256'], payloadHash);
  const canonical = `${incoming.method}\n${url.pathname}\n${canonicalQuery}\n${headers}\n${signedHeaders}\n${payloadHash}`;
  const expected = createHmac('sha256', secret).update(`ACS3-HMAC-SHA256\n${createHash('sha256').update(canonical).digest('hex')}`).digest('hex');
  assert.equal(auth.split('Signature=')[1], expected);
});

test('Alibaba delays polling, parses synchronized result and does not retry unknown timeout', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z'); let reads = 0; let dials = 0;
  const client = {
    singleCallByTtsWithOptions: async (_request: any, runtime: any) => { dials++; assert.equal(runtime.autoretry, false); throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
    queryCallDetailByCallIdWithOptions: async (params: any) => { reads++; assert.equal(params.prodId, 11000000300006); return { body: { code: 'OK', data: JSON.stringify({ duration: 8, endDate: '2026-01-01 08:01:00' }) } }; },
  } as unknown as AliyunClient;
  const provider = new AliyunProvider(() => client, () => now);
  const input = { ...request(), to: `+86${'1' + '0'.repeat(10)}` };
  assert.equal((await provider.dial(input, config())).status, 'unknown'); assert.equal(dials, 1);
  const created = new Date(now).toISOString();
  assert.equal((await provider.poll('fixture', config(), created)).status, 'accepted'); assert.equal(reads, 0);
  now += 300_001;
  assert.equal((await provider.poll('fixture', config(), created)).status, 'completed'); assert.equal(reads, 1);
});

test('callbacks require exact public URL signature, account/call/recipient binding, PIN and one-shot allowed choice', async t => {
  const cfg = config(); const input = request();
  input.decision = { id: 'decision-fixture', question: '下一步', options: [{ id: 'continue', label: '继续' }, { id: 'stop', label: '停止' }] };
  const binding: TwilioCallBinding = { request: input, expiresAt: new Date(Date.now() + 60_000).toISOString(), consumed: false };
  const updates: CallResult[] = []; const choices: any[] = [];
  const app = await createTwilioCallbackApp({ getConfig: () => cfg, findCallById: id => id === callId ? binding : undefined, updateCall: (_id, result) => { updates.push(result); }, respondDecision: value => { choices.push(value); binding.consumed = true; return true; } });
  t.after(() => app.close());
  const baseBody = { CallSid: callId, AccountSid: sid, From: cfg.providers.twilio.from, To: recipient };
  async function post(path: string, extras: Record<string, string> = {}, signatureUrl?: string) {
    const body = { ...baseBody, ...extras };
    const signature = twilio.getExpectedTwilioSignature(secret, signatureUrl ?? `${cfg.providers.twilio.callbackBaseUrl}${path}`, body);
    return app.inject({ method: 'POST', url: path, payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature, host: 'spoofed.test', 'x-forwarded-host': 'spoofed.test' } });
  }
  assert.equal((await post('/twilio/status', { CallStatus: 'completed' }, 'https://wrong.test/twilio/status')).statusCode, 403);
  assert.equal((await post('/twilio/status', { To: '+15005550006', CallStatus: 'completed' })).statusCode, 403);
  assert.equal((await post('/twilio/status', { CallSid: `CA${'2'.repeat(32)}`, CallStatus: 'completed' })).statusCode, 403);
  assert.equal((await post('/twilio/status', { CallStatus: 'ringing', AdditionalFutureField: 'kept-for-signature' })).statusCode, 204); assert.equal(updates.length, 1);
  for (const status of ['busy', 'no-answer']) {
    assert.equal((await post('/twilio/status', { CallStatus: status })).statusCode, 204);
    assert.equal(updates.at(-1)?.retryable, false);
  }
  assert.match((await post('/twilio/choice', { Digits: '1' })).body, /回复无效/); assert.equal(choices.length, 0);
  assert.match((await post('/twilio/pin', { Digits: cfg.controlPin })).body, /twilio\/choice/);
  const result = await post('/twilio/choice', { Digits: '2' }); assert.match(result.body, /已记录/);
  assert.equal(choices[0].optionId, 'stop'); assert.equal(choices[0].decisionId, input.decision.id); assert.equal(choices[0].pin, cfg.controlPin);
  await post('/twilio/choice', { Digits: '1' }); assert.equal(choices.length, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).statusCode, 404);
});

test('wrong PIN burns the phone attempt and expired decisions cannot be answered', async t => {
  const cfg = config(); const input = { ...request(), decision: { id: 'd', question: '决定', options: [{ id: 'retry', label: '重试' }] } };
  let time = 1_000; let responses = 0;
  const app = await createTwilioCallbackApp({ now: () => time, getConfig: () => cfg, findCallById: () => ({ request: input, expiresAt: new Date(2_000).toISOString(), consumed: false }), updateCall: () => {}, respondDecision: () => { responses++; return true; } });
  t.after(() => app.close());
  async function pin(digits: string) { const path = '/twilio/pin'; const body = { CallSid: callId, AccountSid: sid, From: cfg.providers.twilio.from, To: recipient, Digits: digits }; return app.inject({ method: 'POST', url: path, payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(secret, `${cfg.providers.twilio.callbackBaseUrl}${path}`, body) } }); }
  assert.match((await pin('9999')).body, /密码错误/); assert.match((await pin(cfg.controlPin)).body, /已处理/);
  time = 3_000; assert.match((await pin(cfg.controlPin)).body, /已结束/); assert.equal(responses, 0);
});
