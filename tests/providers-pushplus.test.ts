import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { defaults } from '../src/core/config.js';
import type { AppConfig, CallRequest } from '../src/shared/contracts.js';
import { PushplusProvider, type PushplusFetch } from '../src/providers/pushplus.js';

// 仅用于格式校验的合成号码，不会发送到注入测试传输以外的地址。
const phone = '1' + '0'.repeat(10);
const token = 'fixture-pushplus-user-token';
const secret = 'fixture-only-not-a-real-secret';
const accessKey = 'fixture-short-lived-access';
const callId = 'fixture-pushplus-call';
const paths = { access: '/api/common/openApi/getAccessKey', account: '/api/open/user/myInfo', send: '/send', result: '/api/open/message/sendMessageResult' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function config(): AppConfig {
  const cfg = structuredClone(defaults);
  cfg.mode = 'pushplus'; cfg.recipient = { countryCode: '+86', number: phone, consent: true };
  cfg.providers.pushplus = { token, secretKey: secret };
  return cfg;
}
const request = (): CallRequest => ({ notificationId: 'fixture-notification', eventId: 'fixture-event', taskId: 'fixture-task', to: `+86${phone}`, text: '任务已经完成。', eventType: 'task_completed' });
const account = () => ({ code: 200, data: { token, phoneNumber: phone, verifyStatus: 1, points: 60 } });
type Seen = { url: URL; init: RequestInit; body: any };
function fixture(override?: (entry: Seen) => Promise<Response> | Response | undefined) {
  const seen: Seen[] = [];
  const fetcher: PushplusFetch = async (url, init) => {
    const entry = { url: new URL(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined }; seen.push(entry);
    assert.equal(entry.url.origin, 'https://www.pushplus.plus'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    const result = override?.(entry); if (result) return result;
    if (entry.url.pathname === paths.access) return response({ code: 200, data: { accessKey, expiresIn: 7200 } });
    if (entry.url.pathname === paths.account) return response(account());
    if (entry.url.pathname === paths.send) return response({ code: 200, data: callId });
    if (entry.url.pathname === paths.result) return response({ code: 200, data: { status: 2 } });
    throw new Error('Unexpected fixture path');
  };
  return { seen, fetcher };
}

test('pushplus local checks never contact network; remote check only reads the bound account', async () => {
  const f = fixture(); const provider = new PushplusProvider(f.fetcher);
  assert.equal((await provider.check(config())).ok, true); assert.equal(f.seen.length, 0);
  assert.equal((await provider.check(config(), { remote: true })).ok, true);
  assert.deepEqual(f.seen.map(x => x.url.pathname), [paths.access, paths.account]);
  assert.deepEqual(f.seen[0].body, { token, secretKey: secret });
  assert.equal(f.seen[0].init.method, 'POST'); assert.equal(f.seen[1].init.method, 'GET');
  assert.equal(new Headers(f.seen[1].init.headers).get('access-key'), accessKey);
  for (const entry of f.seen) assert.ok(!entry.url.href.includes(token) && !entry.url.href.includes(secret));
});

test('pushplus fails closed for masked/mismatched account, phone, identity, or points', async () => {
  for (const patch of [
    { token: 'fixture-other-token' }, { phoneNumber: '1********00' }, { phoneNumber: '1' + '1'.repeat(10) },
    { phoneNumber: undefined }, { verifyStatus: 0 }, { verifyStatus: '1' }, { points: 29 }, { points: undefined },
  ]) {
    const f = fixture(x => x.url.pathname === paths.account ? response({ code: 200, data: { ...account().data, ...patch } }) : undefined);
    const result = await new PushplusProvider(f.fetcher).dial(request(), config());
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 0);
    const publicResult = JSON.stringify(result); assert.ok(!publicResult.includes(phone) && !publicResult.includes(token));
  }
});

test('pushplus rejects changed destination, no consent and invalid credentials before network', async () => {
  const f = fixture(); const provider = new PushplusProvider(f.fetcher);
  assert.equal((await provider.dial({ ...request(), to: '+86' + '1' + '1'.repeat(10) }, config())).status, 'failed');
  const cfg = config(); cfg.recipient.consent = false; assert.equal((await provider.dial(request(), cfg)).status, 'failed');
  cfg.recipient.consent = true; cfg.providers.pushplus.secretKey = ''; assert.equal((await provider.dial(request(), cfg)).status, 'failed');
  assert.equal(f.seen.length, 0);
});

test('pushplus sends only one bounded voice title to verified self, and acceptance is not delivery', async () => {
  const f = fixture(); const provider = new PushplusProvider(f.fetcher, () => 100_000);
  const input = { ...request(), text: '\n' + '任务中文😀'.repeat(100), decision: { id: 'fixture-decision', question: '继续？', options: [{ id: 'continue', label: '继续' }] } };
  const result = await provider.dial(input, config());
  assert.equal(result.status, 'accepted'); assert.equal(result.callId, callId); assert.equal(result.retryable, false);
  const send = f.seen.filter(x => x.url.pathname === paths.send); assert.equal(send.length, 1);
  assert.equal(send[0].init.method, 'POST'); assert.equal(send[0].body.channel, 'voice'); assert.equal(send[0].body.template, 'txt');
  assert.ok(send[0].body.title.length <= 100); assert.ok(send[0].body.title.endsWith('请返回电脑选择。'));
  assert.equal(send[0].body.content, send[0].body.title); assert.equal(send[0].body.timestamp, 160_000);
  assert.deepEqual(Object.keys(send[0].body).sort(), ['channel', 'content', 'template', 'timestamp', 'title', 'token']);
  assert.match(result.message!, /尚未确认/);
});

test('pushplus rechecks phone binding before every send even when access credential is cached', async () => {
  let changed = false;
  const f = fixture(x => x.url.pathname === paths.account && changed ? response({ code: 200, data: { ...account().data, phoneNumber: '1' + '1'.repeat(10) } }) : undefined);
  const provider = new PushplusProvider(f.fetcher);
  assert.equal((await provider.check(config(), { remote: true })).ok, true); changed = true;
  assert.equal((await provider.dial(request(), config())).status, 'failed');
  assert.equal(f.seen.filter(x => x.url.pathname === paths.access).length, 1);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.account).length, 2);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 0);
});

test('pushplus caches and single-flights access keys, refreshes on expiry and credential changes', async () => {
  let now = 100_000; const f = fixture(); const provider = new PushplusProvider(f.fetcher, () => now);
  await Promise.all([provider.check(config(), { remote: true }), provider.check(config(), { remote: true })]);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.access).length, 1);
  now += 7_200_000; await provider.check(config(), { remote: true });
  assert.equal(f.seen.filter(x => x.url.pathname === paths.access).length, 2);
  const cfg = config(); cfg.providers.pushplus.secretKey = 'fixture-rotated-secret'; await provider.check(cfg, { remote: true });
  assert.equal(f.seen.filter(x => x.url.pathname === paths.access).length, 3);
});

test('pushplus send timeout, 5xx, redirect and malformed response stay unknown without retry or error leakage', async () => {
  const variants = [
    () => { throw new Error(`private ${secret} ${phone}`); },
    () => response({ code: 200, data: callId }, 503),
    () => response({ code: 503, msg: secret }),
    () => new Response('', { status: 302, headers: { location: 'https://example.test/collect' } }),
    () => new Response('not-json-' + secret),
    () => response({ code: 200 }),
    () => response({ code: 200, data: secret.repeat(5000) }),
  ];
  for (const fail of variants) {
    const f = fixture(x => x.url.pathname === paths.send ? fail() : undefined);
    const result = await new PushplusProvider(f.fetcher).dial(request(), config());
    assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false);
    assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 1);
    assert.ok(!JSON.stringify(result).includes(secret) && !JSON.stringify(result).includes(phone));
  }
});

test('pushplus explicit request rejection never automatically retries', async () => {
  for (const make of [() => response({ code: 429 }, 429), () => response({ code: 905, msg: secret }), () => response({ code: 403 }, 403)]) {
    const f = fixture(x => x.url.pathname === paths.send ? make() : undefined);
    const result = await new PushplusProvider(f.fetcher).dial(request(), config());
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
    assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 1); assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('pushplus abort during account verification prevents the subsequent charged send', async () => {
  const abort = new AbortController();
  const f = fixture(x => { if (x.url.pathname === paths.account) { abort.abort(); return response(account()); } });
  const result = await new PushplusProvider(f.fetcher).dial(request(), config(), { signal: abort.signal });
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.match(result.message!, /未提交/);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 0);
});

test('pushplus successful readonly check does not authorize a later aborted dial', async () => {
  const f = fixture(); const provider = new PushplusProvider(f.fetcher);
  assert.equal((await provider.check(config(), { remote: true })).ok, true);
  const count = f.seen.length; const abort = new AbortController(); abort.abort();
  const result = await provider.dial(request(), config(), { signal: abort.signal });
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
  assert.equal(f.seen.length, count); assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 0);
});

test('pushplus actual request deadline aborts a sent request once and reports unknown', async t => {
  // 定时器保持测试循环存活，AbortSignal.timeout 本身不会保持 Node 进程运行。
  const keepAlive = setTimeout(() => {}, 7000); t.after(() => clearTimeout(keepAlive));
  const f = fixture(x => x.url.pathname === paths.send ? new Promise<Response>((_resolve, reject) => {
    x.init.signal!.addEventListener('abort', () => reject(x.init.signal!.reason), { once: true });
  }) : undefined);
  const result = await new PushplusProvider(f.fetcher).dial(request(), config());
  assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 1);
});

test('pushplus abort after send begins is unknown, not a claim that the remote phone stopped', async () => {
  const abort = new AbortController();
  const f = fixture(x => { if (x.url.pathname === paths.send) { abort.abort(); return response({ code: 200, data: callId }); } });
  const result = await new PushplusProvider(f.fetcher).dial(request(), config(), { signal: abort.signal });
  assert.equal(result.status, 'unknown'); assert.equal(result.retryable, false);
  assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 1);
});

test('pushplus polling is delayed, maps delivery states conservatively and never invokes send', async () => {
  for (const [status, expected] of [[0, 'accepted'], [1, 'accepted'], [2, 'completed'], [3, 'failed'], [99, 'unknown']] as const) {
    const f = fixture(x => x.url.pathname === paths.result ? response({ code: 200, data: { status, errorMessage: secret } }) : undefined);
    const provider = new PushplusProvider(f.fetcher, () => 100_000);
    assert.equal((await provider.poll(callId, config(), new Date(95_000).toISOString())).status, 'accepted'); assert.equal(f.seen.length, 0);
    const result = await provider.poll(callId, config(), new Date(50_000).toISOString());
    assert.equal(result.status, expected); assert.equal(result.retryable, false);
    assert.equal(f.seen.filter(x => x.url.pathname === paths.send).length, 0);
    assert.equal(f.seen.at(-1)!.url.searchParams.get('shortCode'), callId);
    assert.ok(!JSON.stringify(result).includes(secret));
    if (status === 2) assert.match(result.message!, /未证明电话接听/);
  }
});

test('pushplus poll failure and invalid query identifiers remain unknown; cancel makes no remote request', async () => {
  const f = fixture(x => x.url.pathname === paths.result ? response({ code: 500 }, 500) : undefined);
  const provider = new PushplusProvider(f.fetcher, () => 100_000);
  assert.equal((await provider.poll('../fixture', config(), new Date(0).toISOString())).status, 'unknown'); assert.equal(f.seen.length, 0);
  assert.equal((await provider.poll(callId, config(), new Date(0).toISOString())).status, 'unknown');
  const count = f.seen.length; assert.equal((await provider.cancel(callId, config())).ok, false); assert.equal(f.seen.length, count);
  await provider.shutdown(); assert.equal((await provider.dial(request(), config())).status, 'failed'); assert.equal(f.seen.length, count);
});

test('pushplus actual Node HTTP transport contract is exercised against loopback fixtures only', async t => {
  const seen: { path: string; method: string; body: any; access?: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url!, method: req.method!, body: raw ? JSON.parse(raw) : undefined, access: req.headers['access-key'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === paths.access ? { code: 200, data: { accessKey, expiresIn: 7200 } } : req.url === paths.account ? account() : { code: 200, data: callId }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const provider = new PushplusProvider(async (url, init) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://www.pushplus.plus');
    return fetch(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, init);
  });
  assert.equal((await provider.dial(request(), config())).status, 'accepted');
  assert.deepEqual(seen.map(x => x.path), [paths.access, paths.account, paths.send]);
  assert.equal(seen[1].access, accessKey); assert.equal(seen[2].body.channel, 'voice'); assert.equal(seen[2].body.token, token);
});
