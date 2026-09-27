import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { SipEndpoint } from '../src/sip/endpoint.js';
import { createSipProvider, defaultSipExecutable } from '../src/sip/index.js';
import { defaults } from '../src/core/config.js';
import { synthesizeTelephony } from '../src/core/voice.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executable = defaultSipExecutable();
let nativeAvailable = true;
try { await access(executable); } catch { nativeAvailable = false; }
const nativeOptions = { skip: nativeAvailable ? false : 'Native SIP is separate: run scripts/build-sip.ps1 first; no native verification claimed.', timeout: 40000 };
function tone(seconds = 8): Buffer {
  const samples = 8000 * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 10000), 44 + i * 2);
  return buffer;
}
async function profileSnapshot(): Promise<unknown> {
  if (!process.env.APPDATA) return null;
  const directory = join(process.env.APPDATA, '.baresip');
  try {
    const names = (await readdir(directory)).sort();
    return await Promise.all(names.map(async name => { const path = join(directory, name); const meta = await stat(path); return { name, size: meta.size, mtime: meta.mtimeMs, digest: meta.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : null }; }));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

test('native SIP launcher refuses an empty working directory without creating global or local config', nativeOptions, async () => {
  const base = resolve('.local/sip-tests', randomUUID());
  await mkdir(base, { recursive: true });
  const before = await profileSnapshot();
  try {
    await assert.rejects(promisify(execFile)(executable, [], { cwd: base, windowsHide: true, timeout: 3000 }), error => (error as { code?: number }).code === 2);
    assert.deepEqual(await readdir(base), []);
    assert.deepEqual(await profileSnapshot(), before);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('native baresip: real loopback INVITE, bidirectional RTP PCM, DTMF and BYE', nativeOptions, async () => {
  const base = resolve('.local/sip-tests', randomUUID());
  const profileBefore = await profileSnapshot();
  await mkdir(base, { recursive: true });
  const source = join(base, 'tone.wav'); await writeFile(source, tone());
  const alice = new SipEndpoint({ executable, directory: join(base, '主叫 空格'), username: 'alice', source, receiveFile: join(base, 'alice.wav') });
  const bob = new SipEndpoint({ executable, directory: join(base, 'bob'), username: 'bob', autoAnswer: true, source, receiveFile: join(base, 'bob.wav') });
  try {
    await alice.start(); await bob.start();
    await alice.control.command('dial', `sip:bob@127.0.0.1:${bob.sipPort}`);
    const established = await alice.control.waitFor(event => event.type === 'CALL_ESTABLISHED');
    assert.ok(established.id, 'real SIP Call-ID exposed by ctrl_tcp');
    await bob.control.waitFor(event => event.type === 'CALL_ESTABLISHED');
    await bob.control.command('sndcode', '1234');
    for (const digit of '1234') await alice.control.waitFor(event => event.type === 'CALL_DTMF_START' && event.param === digit);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await alice.control.command('hangup');
    await alice.control.waitFor(event => event.type === 'CALL_CLOSED');
    await bob.control.waitFor(event => event.type === 'CALL_CLOSED');
    await alice.stop(); await bob.stop();
    assert.deepEqual(await profileSnapshot(), profileBefore, 'native launcher must never alter the real user profile');
    for (const name of ['alice.wav', 'bob.wav']) {
      const pcm = await readFile(join(base, name));
      assert.equal(pcm.toString('ascii', 0, 4), 'RIFF');
      assert.ok(pcm.length > 8044, `${name}: at least 0.5 seconds of received PCM`);
      let energy = 0;
      for (let offset = 44; offset + 1 < pcm.length; offset += 2) energy += Math.abs(pcm.readInt16LE(offset));
      assert.ok(energy / ((pcm.length - 44) / 2) > 100, `${name}: non-silent decoded RTP audio`);
    }
  } catch (error) {
    // Synthetic accounts only; diagnostics never appear in production routes.
    throw new Error(`${String(error)}\nAlice: ${alice.diagnostics}\nBob: ${bob.diagnostics}`);
  } finally { await alice.stop(); await bob.stop(); await rm(base, { recursive: true, force: true }); }
});

test('native baresip: REGISTER digest challenge is answered and unregister completes', nativeOptions, async () => {
  const registrar = createSocket('udp4');
  await new Promise<void>(resolve => registrar.bind(0, '127.0.0.1', resolve));
  const port = registrar.address().port;
  const base = resolve('.local/sip-tests', randomUUID());
  const realm = 'acb-test'; const nonce = randomUUID(); const password = 'synthetic-test-password';
  let challenged = 0; let authorized = 0; let unregistered = 0;
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  registrar.on('message', (bytes, peer) => {
    const request = bytes.toString();
    if (!request.startsWith('REGISTER ')) return;
    const header = (name: string) => request.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? '';
    const auth = header('Authorization');
    const attrs = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const valid = attrs.response === md5(`${md5(`testuser:${realm}:${password}`)}:${nonce}:${md5(`REGISTER:${attrs.uri}`)}`);
    const expiry = header('Expires');
    if (!auth) challenged++;
    else if (valid) { authorized++; if (expiry === '0' || /expires=0\b/.test(header('Contact'))) unregistered++; }
    const status = valid ? '200 OK' : '401 Unauthorized';
    const lines = [`SIP/2.0 ${status}`, `Via: ${header('Via')}`, `From: ${header('From')}`, `To: ${header('To')};tag=registrar`, `Call-ID: ${header('Call-ID')}`, `CSeq: ${header('CSeq')}`];
    if (!valid) lines.push(`WWW-Authenticate: Digest realm="${realm}",nonce="${nonce}",algorithm=MD5`);
    else lines.push(`Contact: ${header('Contact')}`, `Expires: ${expiry || 300}`);
    lines.push('Content-Length: 0', '', '');
    registrar.send(lines.join('\r\n'), peer.port, peer.address);
  });
  const endpoint = new SipEndpoint({ executable, directory: base, username: 'testuser', password, server: '127.0.0.1', serverPort: port, register: true });
  try {
    await endpoint.start(); assert.equal(await endpoint.registration(7000), true);
    assert.ok(challenged > 0); assert.ok(authorized > 0);
    await endpoint.stop(); assert.ok(unregistered > 0, 'owned registration was removed');
  } catch (error) { throw new Error(`${String(error)}\n${endpoint.diagnostics}`); }
  finally { await endpoint.stop(); registrar.close(); await rm(base, { recursive: true, force: true }); }
});

test('native SIP provider: Chinese TTS reaches software endpoint; cancel and real EOF complete correctly', nativeOptions, async () => {
  const base = resolve('.local/sip-tests', randomUUID());
  await mkdir(base, { recursive: true });
  const receiver = new SipEndpoint({ executable, directory: join(base, 'receiver'), username: 'receiver', autoAnswer: true, receiveFile: join(base, 'received.wav') });
  const proxy = createSocket('udp4');
  await new Promise<void>(resolve => proxy.bind(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  let caller: { port: number; address: string } | undefined;
  let inviteCount = 0;
  proxy.on('message', (bytes, peer) => {
    const message = bytes.toString();
    const header = (name: string) => message.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() ?? '';
    if (message.startsWith('REGISTER ')) {
      // Dedicated permissive loopback registrar; authenticated challenge is covered separately above.
      proxy.send([`SIP/2.0 200 OK`, `Via: ${header('Via')}`, `From: ${header('From')}`, `To: ${header('To')};tag=local`, `Call-ID: ${header('Call-ID')}`, `CSeq: ${header('CSeq')}`, `Contact: ${header('Contact')}`, `Expires: ${header('Expires') || 300}`, 'Content-Length: 0', '', ''].join('\r\n'), peer.port, peer.address);
    } else if (message.startsWith('SIP/2.0') && caller) {
      proxy.send(message.replace(/^Via:[^\r\n]+\r\n/m, ''), caller.port, caller.address);
    } else if (/^(INVITE|CANCEL|ACK|BYE) /.test(message)) {
      caller = peer;
      if (message.startsWith('INVITE ')) inviteCount++;
      const firstLine = message.indexOf('\r\n');
      const forwarded = `${message.slice(0, firstLine + 2)}Via: SIP/2.0/UDP 127.0.0.1:${proxyPort};branch=z9hG4bK-acb-${header('CSeq').split(' ')[0]}\r\n${message.slice(firstLine + 2)}`;
      proxy.send(forwarded, receiver.sipPort, '127.0.0.1');
    }
  });
  const config = structuredClone(defaults);
  Object.assign(config.providers.sip, { server: '127.0.0.1', port: proxyPort, username: 'caller', password: '', extension: 'receiver', transport: 'udp', executable });
  const provider = createSipProvider({ dataDir: base, synthesize: synthesizeTelephony, setupTimeoutMs: 7000 });
  let callId = '';
  try {
    await receiver.start();
    const result = await provider.dial({ notificationId: 'local-test', eventId: 'synthetic-event', taskId: 'synthetic-task', to: 'unused', text: '这是一条本地测试汇报。语音已经生成，正在验证通话。' }, config);
    assert.equal(result.status, 'accepted', result.message); callId = result.callId!;
    assert.ok(callId); assert.equal(inviteCount, 1);
    await receiver.control.waitFor(event => event.type === 'CALL_ESTABLISHED');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const canceled = await provider.cancel(callId, config); assert.equal(canceled.ok, true);
    assert.equal((await provider.poll!(callId, config, new Date().toISOString())).status, 'failed');
    await receiver.control.waitFor(event => event.type === 'CALL_CLOSED');
    const audio = await readFile(join(base, 'received.wav'));
    assert.ok(audio.length > 8044);
    let peak = 0;
    for (let i = 44; i + 1 < audio.length; i += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(i)));
    assert.ok(peak > 200, 'received actual non-silent Chinese TTS PCM');
    assert.equal(inviteCount, 1, 'cancel never retries');
    const second = await provider.dial({ notificationId: 'local-complete', eventId: 'second-synthetic-event', taskId: 'synthetic-task', to: 'unused', text: '任务完成。' }, config);
    assert.equal(second.status, 'accepted', second.message); callId = second.callId!;
    const deadline = Date.now() + 8000;
    let completed = await provider.poll!(callId, config, new Date().toISOString());
    while (completed.status === 'accepted' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      completed = await provider.poll!(callId, config, new Date().toISOString());
    }
    assert.equal(completed.status, 'completed', 'completion requires the native end-of-file event');
    assert.equal(inviteCount, 2, 'exactly one INVITE per requested call');
  } catch (error) { throw new Error(`${String(error)}\nReceiver: ${receiver.diagnostics}`); }
  finally { if (callId) await provider.cancel(callId, config); await receiver.stop(); proxy.close(); await rm(base, { recursive: true, force: true }); }
});

test('native SIP: unaccepted ringing call is canceled with no second attempt', nativeOptions, async () => {
  const base = resolve('.local/sip-tests', randomUUID());
  const caller = new SipEndpoint({ executable, directory: join(base, 'caller'), username: 'caller' });
  const callee = new SipEndpoint({ executable, directory: join(base, 'callee'), username: 'callee', autoAnswer: false });
  try {
    await caller.start(); await callee.start();
    await caller.control.command('dial', `sip:callee@127.0.0.1:${callee.sipPort}`);
    await callee.control.waitFor(event => event.type === 'CALL_INCOMING');
    await caller.control.command('hangup');
    await callee.control.waitFor(event => event.type === 'CALL_CLOSED');
    assert.equal(callee.control.events.filter(event => event.type === 'CALL_INCOMING').length, 1);
    assert.equal(caller.control.events.some(event => event.type === 'CALL_ESTABLISHED'), false);
  } finally { await caller.stop(); await callee.stop(); await rm(base, { recursive: true, force: true }); }
});
