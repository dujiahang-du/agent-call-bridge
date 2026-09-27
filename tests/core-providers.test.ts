import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ConfigStore, defaults } from '../src/core/config.js';
import { createApp } from '../src/server/app.js';
import type { ProviderId } from '../src/shared/contracts.js';

const newProviders = ['pushplus', 'ihuyi', 'ronglian'] as const;
function directory() { const root = resolve('.local', 'core-provider-tests'); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, 'run-')); }
const event = (id: string) => ({ eventId: id, taskId: id, source: 'offline-provider-test', type: 'task_failed', summary: '离线接入验证' });
async function settle(app: Awaited<ReturnType<typeof createApp>>) {
  for (let i = 0; i < 100; i++) { await app.acb.drain(); if (app.acb.notifications().every(n => n.status !== 'dialing')) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('本地队列未在期限内完成');
}

test('v0.1.4 encrypted config loads new provider defaults without rewriting or losing prior credentials', () => {
  const dir = directory();
  try {
    const old: any = structuredClone(defaults);
    for (const id of newProviders) delete old.providers[id];
    old.providers.twilio.authToken = ['old', 'offline', 'credential'].join('-');
    old.voice.rate = 2;
    const key = randomBytes(32), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(old), 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    writeFileSync(join(dir, 'local.key'), key); writeFileSync(join(dir, 'config.enc'), encrypted);
    const store = new ConfigStore(dir, true);
    assert.equal(store.read().providers.twilio.authToken, old.providers.twilio.authToken);
    assert.equal(store.read().voice.rate, 2);
    for (const id of newProviders) assert.deepEqual(store.read().providers[id], defaults.providers[id]);
    assert.equal(readFileSync(join(dir, 'config.enc'), 'utf8'), encrypted);
    assert.doesNotThrow(() => store.masked());
    store.update({ mode: 'pushplus' });
    assert.equal(new ConfigStore(dir, true).read().mode, 'pushplus');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('new provider secrets are encrypted, masked, preserved when blank and cleared explicitly', () => {
  const dir = directory();
  try {
    const store = new ConfigStore(dir, true);
    const paths = { pushplus: ['token', 'secretKey'], ihuyi: ['apiId', 'apiKey'], ronglian: ['accountSid', 'authToken', 'appId'] };
    for (const [provider, keys] of Object.entries(paths)) for (const field of keys) {
      const value = ['offline', provider, field, 'fixture'].join('-');
      store.update({ providers: { [provider]: { [field]: value } } });
      const masked = store.masked();
      assert.equal(masked.providers[provider][field], '');
      assert.equal(masked.secretConfigured[`providers.${provider}.${field}`], true);
      assert.ok(!JSON.stringify(masked).includes(value));
      assert.ok(!readFileSync(join(dir, 'config.enc'), 'utf8').includes(value));
      store.update({ providers: { [provider]: { [field]: '' } } });
      assert.equal((store.read().providers as any)[provider][field], value);
      store.update({ providers: { [provider]: { [field]: null } } });
      assert.equal((new ConfigStore(dir, true).read().providers as any)[provider][field], '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all new providers stay locked until explicit per-call authorization, deduplicate and honor destination limits', async () => {
  for (const id of newProviders) {
    const dir = directory(); const app = await createApp({ dataDir: dir, projectRoot: dir, testMode: true }); let calls = 0;
    try {
      app.acb.providers[id] = { id, check: async () => ({ ok: true, message: 'offline' }), dial: async () => { calls++; return { status: 'completed' }; }, cancel: async () => ({ ok: false, message: 'cannot cancel' }) };
      app.acb.updateConfig({ mode: id, recipient: { countryCode: '+86', number: '1' + '0'.repeat(10), consent: true } });
      const input = event(`locked-${id}`), first = app.acb.accept(input);
      assert.equal(app.acb.accept(input).duplicate, true); await settle(app); assert.equal(calls, 0);
      app.acb.authorize(first.notification.id, '拨打本次真实电话'); await settle(app); assert.equal(calls, 1);
      app.acb.enableReal('我确认线路可用并同意受限自动外呼及可能费用');
      app.acb.accept(event(`limited-${id}`)); await settle(app);
      assert.equal(calls, 1); assert.ok(app.acb.notifications().some(n => n.status === 'suppressed'));
      app.acb.updateConfig({ voice: { rate: 1 } }); assert.equal(app.acb.realCallsEnabled, false);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('stop, revocation, settings change, shutdown and timeout abort pending provider preparation before dispatch', async () => {
  for (const action of ['pause', 'disable', 'config', 'shutdown', 'timeout'] as const) {
    const dir = directory(); const app = await createApp({ dataDir: dir, projectRoot: dir, testMode: true });
    let signal: AbortSignal | undefined; let enter!: () => void; const entered = new Promise<void>(r => { enter = r; });
    try {
      app.acb.providers.pushplus = {
        id: 'pushplus', check: async () => ({ ok: true, message: 'offline' }), cancel: async () => ({ ok: false, message: 'no external call' }),
        dial: async (_request, _config, options) => {
          signal = options?.signal; enter();
          await new Promise<void>(r => signal!.addEventListener('abort', () => r(), { once: true }));
          return { status: 'unknown', retryable: false, message: 'preparation aborted' };
        },
      };
      app.acb.updateConfig({ mode: 'pushplus', recipient: { countryCode: '+86', number: '1' + '0'.repeat(10), consent: true } });
      const n = app.acb.accept(event(`abort-${action}`)).notification; app.acb.authorize(n.id, '拨打本次真实电话'); await entered;
      if (action === 'pause') await app.acb.pause(true);
      if (action === 'disable') app.acb.disableReal();
      if (action === 'config') app.acb.updateConfig({ voice: { rate: 1 } });
      if (action === 'shutdown') app.acb.beginShutdown();
      await settle(app); assert.equal(signal?.aborted, true);
      assert.equal(app.acb.notifications()[0].status, 'unknown'); assert.equal(app.acb.notifications()[0].attempts, 1);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test('account check is authenticated, explicit, read-only and cannot unlock real calls', async () => {
  const dir = directory(); const app = await createApp({ dataDir: dir, projectRoot: dir, testMode: true }); let reads = 0, calls = 0;
  try {
    app.acb.providers.pushplus = { id: 'pushplus', check: async (_config, options) => { if (options?.remote) reads++; return { ok: true, message: 'offline account verified' }; }, dial: async () => { calls++; return { status: 'completed' }; }, cancel: async () => ({ ok: false, message: 'none' }) };
    const headers = { authorization: `Bearer ${app.localToken}` };
    const payload = { confirmation: '只核对pushplus绑定账号，不拨号' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/pushplus/account-check', payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/pushplus/account-check', headers, payload })).statusCode, 400);
    app.acb.updateConfig({ mode: 'pushplus' as ProviderId });
    assert.equal((await app.inject({ method: 'POST', url: '/api/pushplus/account-check', headers, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/providers/check', headers, payload: { provider: 'pushplus', remote: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/pushplus/account-check', headers, payload })).statusCode, 200);
    assert.equal(reads, 1); assert.equal(calls, 0); assert.equal(app.acb.realCallsEnabled, false);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('delayed authorization starts the call result deadline and query date at actual dispatch', async () => {
  const dir = directory(); const app = await createApp({ dataDir: dir, projectRoot: dir, testMode: true }); let queriedAt = 0;
  try {
    app.acb.providers.ronglian = { id: 'ronglian', check: async () => ({ ok: true, message: 'offline' }), dial: async () => ({ status: 'accepted', callId: 'delayed-offline-call' }), poll: async (_id, _config, createdAt) => { queriedAt = Date.parse(createdAt); return { status: 'accepted', callId: 'delayed-offline-call' }; }, cancel: async () => ({ ok: false, message: 'offline' }) };
    app.acb.updateConfig({ mode: 'ronglian', recipient: { countryCode: '+86', number: '1' + '0'.repeat(10), consent: true } });
    const pending = app.acb.accept(event('delayed-authorization')).notification;
    app.acb.store.run('UPDATE notifications SET created_at=? WHERE id=?', Date.now() - 86400000, pending.id);
    const start = Date.now(); app.acb.authorize(pending.id, '拨打本次真实电话'); await settle(app);
    app.acb.store.run('UPDATE notifications SET next_at=0 WHERE id=?', pending.id); await app.acb.drain();
    assert.equal(app.acb.notifications()[0].status, 'accepted'); assert.ok(queriedAt >= start);
    app.acb.store.run('UPDATE attempts SET created_at=?', Date.now() - 600001); await app.acb.drain();
    assert.equal(app.acb.notifications()[0].status, 'unknown'); assert.equal(app.acb.notifications()[0].attempts, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
