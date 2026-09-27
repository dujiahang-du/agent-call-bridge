import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaults } from '../src/core/config.js';
import { IhuyiProvider, type DomesticFetch } from '../src/providers/ihuyi.js';
import { RonglianProvider } from '../src/providers/ronglian.js';
import type { AppConfig, CallRequest } from '../src/shared/contracts.js';

const now = Date.parse('2026-09-27T04:05:06Z');
const phone = '+86' + '1' + '0'.repeat(10);
const secret = ['fixture', 'only', 'domestic'].join('-');
const callId = 'c'.repeat(32);
function config(): AppConfig {
  const c = structuredClone(defaults);
  c.providers.ihuyi = { apiId: ['fixture', 'account'].join('_'), apiKey: secret, templateId: '4'.repeat(4) };
  c.providers.ronglian = { accountSid: 'a'.repeat(32), authToken: secret, appId: 'b'.repeat(32), templateText: '您的AI任务{status}，请查看本机界面。' };
  return c;
}
function request(): CallRequest { return { notificationId: 'domestic-test', eventId: 'event-test', taskId: 'private-task', eventType: 'task_completed', to: phone, text: 'PRIVATE_FREE_TEXT', decision: { id: 'private-decision', question: 'PRIVATE_QUESTION', options: [{ id: 'continue', label: 'PRIVATE_OPTION' }] } }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function noLeaks(value: unknown) { const result = JSON.stringify(value); for (const s of [secret, phone, 'SERVICE_PRIVATE_MESSAGE', 'PRIVATE_FREE_TEXT', 'PRIVATE_QUESTION']) assert.ok(!result.includes(s), 'result must not contain private data'); }
const factories = [
  { id: 'ihuyi', make: (f: DomesticFetch, timeout?: number) => new IhuyiProvider(f, () => now, timeout), success: { code: 2, voiceid: '9'.repeat(15) }, reject: { code: 4051, msg: 'SERVICE_PRIVATE_MESSAGE' } },
  { id: 'ronglian', make: (f: DomesticFetch, timeout?: number) => new RonglianProvider(f, () => now, timeout), success: { statusCode: '000000', LandingCall: { callSid: callId } }, reject: { statusCode: '160001', statusMsg: 'SERVICE_PRIVATE_MESSAGE' } },
];

test('domestic checks and unsupported cancellation are offline, including remote check request', async () => {
  let sends = 0;
  for (const factory of factories) {
    const p = factory.make(async () => { sends++; throw new Error('must stay offline'); });
    assert.equal((await p.check(config())).ok, true);
    assert.equal((await p.check(config(), { remote: true })).ok, true);
    assert.equal((await p.check(structuredClone(defaults))).ok, false);
    assert.equal((await p.cancel(callId, config())).ok, false);
  }
  assert.equal(sends, 0);
});

test('Ihuyi submits official template API with UTF-8 MD5 dynamic password and fixed event variables', async () => {
  const c = config(); let sends = 0;
  const p = new IhuyiProvider(async (url, init) => {
    sends++;
    assert.equal(url, 'https://api.ihuyi.com/vm/Submit.json');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.match(new Headers(init.headers).get('content-type')!, /^application\/x-www-form-urlencoded/);
    const body = new URLSearchParams(String(init.body));
    assert.deepEqual([...body.keys()].sort(), ['account', 'content', 'mobile', 'password', 'templateid', 'time']);
    assert.equal(body.get('content'), 'AI任务|报告完成'); assert.equal(body.get('mobile'), phone.slice(3));
    assert.equal(body.get('templateid'), c.providers.ihuyi.templateId);
    assert.equal(body.get('time'), String(now / 1000));
    const expected = createHash('md5').update(c.providers.ihuyi.apiId + secret + phone.slice(3) + 'AI任务|报告完成' + now / 1000, 'utf8').digest('hex');
    assert.equal(body.get('password'), expected); assert.ok(!String(init.body).includes(secret));
    return json(factories[0].success);
  }, () => now);
  const result = await p.dial(request(), c);
  assert.equal(result.status, 'accepted'); assert.equal(result.callId, '9'.repeat(15)); assert.equal(sends, 1); noLeaks(result);
});

test('Ihuyi documented rejection accepts empty, numeric zero and string zero call ID placeholders', async () => {
  for (const voiceid of ['', 0, '0']) {
    let sends = 0;
    const p = new IhuyiProvider(async () => { sends++; return json({ code: 4051, voiceid, msg: 'SERVICE_PRIVATE_MESSAGE' }); }, () => now);
    const result = await p.dial(request(), config());
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(result.callId, undefined); assert.equal(sends, 1); noLeaks(result);
    const accepted = new IhuyiProvider(async () => json({ code: 2, voiceid }), () => now);
    assert.equal((await accepted.dial(request(), config())).status, 'unknown');
  }
});

function verifyRonglianAuth(url: string, init: RequestInit, c: AppConfig) {
  const decoded = Buffer.from(new Headers(init.headers).get('authorization')!, 'base64').toString('utf8');
  const [account, timestamp] = decoded.split(':');
  assert.equal(account, c.providers.ronglian.accountSid); assert.match(timestamp, /^\d{14}$/);
  const date = new Date(now), pad = (n: number) => String(n).padStart(2, '0');
  assert.equal(timestamp, `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`);
  assert.equal(new URL(url).searchParams.get('sig'), createHash('md5').update(account + secret + timestamp, 'utf8').digest('hex').toUpperCase());
  assert.equal(init.redirect, 'error'); assert.ok(init.signal);
}

test('Ronglian signs LandingCalls with one timestamp and substitutes only configured status text', async () => {
  const c = config(); let sends = 0;
  const p = new RonglianProvider(async (url, init) => {
    sends++; verifyRonglianAuth(url, init, c);
    assert.equal(new URL(url).origin, 'https://app.cloopen.com:8883');
    assert.equal(new URL(url).pathname, `/2013-12-26/Accounts/${c.providers.ronglian.accountSid}/Calls/LandingCalls`);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), { appId: c.providers.ronglian.appId, to: phone.slice(3), mediaTxt: '您的AI任务报告完成，请查看本机界面。', playTimes: '1' });
    return json(factories[1].success);
  }, () => now);
  const result = await p.dial(request(), c);
  assert.equal(result.status, 'accepted'); assert.equal(result.callId, callId); assert.equal(sends, 1); noLeaks(result);
});

for (const factory of factories) {
  test(`${factory.id}: invalid destination/event/config and pre-aborted calls never send`, async () => {
    let sends = 0; const p = factory.make(async () => { sends++; return json(factory.success); });
    const invalids = [{ ...request(), to: '+1' + '0'.repeat(10) }, { ...request(), eventType: undefined }, { ...request(), eventType: 'toString' as never }];
    for (const r of invalids) assert.equal((await p.dial(r, config())).status, 'failed');
    assert.equal((await p.dial(request(), structuredClone(defaults))).status, 'failed');
    assert.equal((await p.dial(request(), config(), { signal: AbortSignal.abort() })).status, 'failed');
    assert.equal(sends, 0);
  });
  test(`${factory.id}: documented rejection is final, while server errors/malformed/redirect/ambiguous success are unknown`, async () => {
    const responses = [json(factory.reject), json(factory.success, 503), new Response('not json'), new Response('', { status: 302, headers: { Location: 'https://outside.example.test' } }), json(factory.id === 'ihuyi' ? { code: 2 } : { statusCode: '000000' }), json({ code: phone, statusCode: secret, msg: 'SERVICE_PRIVATE_MESSAGE' }), new Response(' '.repeat(70_000))];
    for (let i = 0; i < responses.length; i++) {
      let sends = 0; const p = factory.make(async (_url, init) => { sends++; assert.equal(init.redirect, 'error'); return responses[i]; });
      const result = await p.dial(request(), config());
      assert.equal(result.status, i === 0 ? 'failed' : 'unknown'); assert.equal(result.retryable, false); assert.equal(sends, 1); noLeaks(result);
    }
  });
  test(`${factory.id}: timeout and revocation abort the one outgoing request without leaking or retrying`, async () => {
    for (const externalAbort of [false, true]) {
      const external = new AbortController(); let sends = 0; let observed: AbortSignal | undefined;
      const p = factory.make(async (_url, init) => {
        sends++; observed = init.signal!;
        if (externalAbort) queueMicrotask(() => external.abort());
        return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error(secret + phone)), { once: true }));
      }, 20);
      const result = await p.dial(request(), config(), { signal: external.signal });
      assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false); assert.equal(sends, 1); assert.equal(observed?.aborted, true); noLeaks(result);
    }
  });
}

test('Ronglian rejects blank, oversized or arbitrary template variables locally', async () => {
  const p = new RonglianProvider(async () => { throw new Error('must not send'); });
  for (const text of ['', '自由摘要{summary}', '{status}{task}', 'x'.repeat(501) + '{status}', '{status}' + String.fromCharCode(0)]) {
    const c = config(); c.providers.ronglian.templateText = text;
    assert.equal((await p.check(c)).ok, false);
  }
});

test('Ronglian signed result query never submits a call and maps documented states conservatively', async () => {
  const c = config(); let state: unknown = '0', sends = 0;
  const p = new RonglianProvider(async (url, init) => {
    sends++; verifyRonglianAuth(url, init, c); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    const parsed = new URL(url);
    assert.equal(parsed.pathname, `/2013-12-26/Accounts/${c.providers.ronglian.accountSid}/CallResult`);
    assert.equal(parsed.searchParams.get('callsid'), callId);
    return json({ statusCode: '000000', CallResult: { state, callTime: '12' } });
  }, () => now);
  assert.equal((await p.poll(callId, c, new Date(now).toISOString())).status, 'accepted'); assert.equal(sends, 0);
  for (const [s, expected] of [['0', 'accepted'], ['1', 'accepted'], ['2', 'accepted'], ['unexpected', 'accepted']] as const) {
    state = s; const result = await p.poll(callId, c, new Date(now - 120_000).toISOString());
    assert.equal(result.status, expected); assert.equal(result.retryable, false); noLeaks(result);
  }
  assert.equal(sends, 4);
  assert.equal((await p.poll('../outside', c, new Date(now - 120_000).toISOString())).status, 'unknown'); assert.equal(sends, 4);
});

test('Ronglian query failure stays accepted for bounded engine/manual reconciliation, never redials', async () => {
  for (const response of [undefined, json({ statusCode: '160001', statusMsg: secret }), json({ statusCode: '000000', CallResult: null })]) {
    let sends = 0;
    const p = new RonglianProvider(async (_url, init) => { sends++; assert.equal(init.method, 'GET'); if (!response) throw new Error(secret); return response; }, () => now);
    const result = await p.poll(callId, config(), new Date(now - 120_000).toISOString());
    assert.equal(result.status, 'accepted'); assert.equal(result.retryable, false); assert.equal(sends, 1); noLeaks(result);
  }
});
