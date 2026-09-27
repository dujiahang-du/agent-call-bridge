import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { SipControl } from '../src/sip/control.js';
import { validateSipValue } from '../src/sip/endpoint.js';
import { createSipProvider, validateSipConfig } from '../src/sip/index.js';
import { defaults } from '../src/core/config.js';
import { verifySipExecutable } from '../src/sip/binary.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

test('SIP binary requires cwd-only manifest and rejects tampered content before launch', async () => {
  const directory = resolve('.local/sip-tests', randomUUID());
  await mkdir(directory, { recursive: true });
  const binary = join(directory, 'baresip.exe');
  const data = Buffer.from('not-an-executable-test-fixture');
  const manifest = { entrypoint: 'acb-cwd-only-v1', platform: 'win-x64', tls: false, sha256: createHash('sha256').update(data).digest('hex') };
  try {
    await writeFile(binary, data);
    await assert.rejects(verifySipExecutable(binary));
    await writeFile(join(directory, 'build-manifest.json'), '\uFEFF' + JSON.stringify(manifest));
    await assert.doesNotReject(verifySipExecutable(binary));
    await writeFile(binary, 'changed');
    await assert.rejects(verifySipExecutable(binary), /checksum/);
    await writeFile(binary, data);
    await writeFile(join(directory, 'build-manifest.json'), JSON.stringify({ ...manifest, entrypoint: 'upstream' }));
    await assert.rejects(verifySipExecutable(binary), /Unsupported/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SIP configuration rejects command/config injection and unsupported TLS', () => {
  for (const value of ['host\nmodule evil', 'example.org;transport=tls', 'host@evil', '../host']) assert.throws(() => validateSipValue(value, 'host'));
  for (const value of ['user\nother', 'user;auth_pass=x', 'user"']) assert.throws(() => validateSipValue(value, 'user'));
  assert.throws(() => validateSipValue('password";answermode=auto', 'password'));
  const config = structuredClone(defaults);
  Object.assign(config.providers.sip, { server: '127.0.0.1', username: 'alice', extension: 'bob', port: 5060, transport: 'tls' });
  assert.throws(() => validateSipConfig(config));
  config.providers.sip.transport = 'udp'; assert.doesNotThrow(() => validateSipConfig(config));
});

test('SIP control reassembles fragmented Unicode netstrings and matches response tokens', async () => {
  const server = createServer(socket => socket.once('data', bytes => {
    const colon = bytes.indexOf(':'); const size = Number(bytes.subarray(0, colon).toString());
    const request = JSON.parse(bytes.subarray(colon + 1, colon + 1 + size).toString());
    assert.equal(request.command, 'reginfo');
    const response = Buffer.from(JSON.stringify({ response: true, ok: true, data: '中文状态', token: request.token }));
    const event = Buffer.from(JSON.stringify({ event: true, type: 'CALL_ESTABLISHED', id: 'test-call' }));
    const frames = Buffer.concat([Buffer.from(`${response.length}:`), response, Buffer.from(`,${event.length}:`), event, Buffer.from(',')]);
    socket.write(frames.subarray(0, 9)); setTimeout(() => socket.write(frames.subarray(9)), 10);
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = new SipControl();
  try {
    await control.connect((server.address() as { port: number }).port);
    assert.equal(await control.command('reginfo'), '中文状态');
    assert.equal((await control.waitFor(event => event.type === 'CALL_ESTABLISHED')).id, 'test-call');
  } finally { control.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SIP control timeout is unknown outcome and does not retransmit a command', async () => {
  let received = 0;
  const server = createServer(socket => socket.on('data', () => received++));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = new SipControl();
  try {
    await control.connect((server.address() as { port: number }).port);
    await assert.rejects(control.command('dial', 'sip:synthetic@127.0.0.1', 40), /outcome unknown/);
    assert.equal(received, 1);
    await assert.rejects(control.command('dial', 'sip:user\nquit'), /Invalid/);
  } finally { control.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SIP provider fails closed without TTS and cannot cancel or recover another call', async () => {
  const provider = createSipProvider();
  const result = await provider.dial({ notificationId: 'n', taskId: 't', eventId: 'e', to: 'unused', text: '测试' }, defaults);
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(result.rawCode, 'SIP_TTS_MISSING');
  assert.equal((await provider.cancel('other-process-call', defaults)).ok, false);
  assert.equal((await provider.poll!('other-process-call', defaults, new Date().toISOString())).status, 'unknown');
});
