import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';

// 从实际解压包启动，不借用源码依赖；所有验证数据仅保留在本项目 .local。
const root = resolve(import.meta.dirname, '..'), packageRoot = resolve(process.argv[2] ?? '');
if (![join(root, '.local') + sep, join(root, 'release') + sep].some(p => packageRoot.startsWith(p))) throw new Error('必须传入本项目 release 或 .local 下的解压包目录');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, version);
const testArea = join(root, '.local', 'portable-provider-tests'); mkdirSync(testArea, { recursive: true });
const dataDir = mkdtempSync(join(testArea, 'run-'));
const evidence = { version, dataDir, packageRoot, checks: [], realCallAttempts: null, ok: false };
const check = (condition, name) => { assert.ok(condition, name); evidence.checks.push(name); };
async function port() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
const managementPort = await port(); let callbackPort = await port(); while (callbackPort === managementPort) callbackPort = await port();
const base = `http://127.0.0.1:${managementPort}`;
const env = { ...process.env, ACB_DATA_DIR: dataDir, ACB_PORT: String(managementPort), ACB_CALLBACK_PORT: String(callbackPort) };
for (const key of Object.keys(env)) if (['path', 'node_path', 'node_options'].includes(key.toLowerCase())) delete env[key];
env.PATH = [join(process.env.SystemRoot, 'System32'), process.env.SystemRoot, join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';');
let child, token;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body, method) {
  const response = await fetch(base + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  check(response.ok, `${method ?? 'request'} ${path}`); return response.json();
}
async function start() {
  child = spawn(join(packageRoot, 'runtime', 'node.exe'), ['dist/server/main.js'], { cwd: packageRoot, env, windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('便携包服务提前退出');
    try { if (existsSync(join(dataDir, 'connection.json')) && (await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) { token = JSON.parse(readFileSync(join(dataDir, 'connection.json'), 'utf8')).token; return; } } catch {}
    await delay(100);
  }
  throw new Error('便携包启动超时');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await api('/shutdown', { confirmation: '关闭本机服务并停止后续通知' });
  const deadline = Date.now() + 15000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  check(child.exitCode === 0, '正常停服且进程退出');
}
try {
  await start(); check((await api('/status')).mode === 'mock', '新安装默认 Mock');
  const fields = { pushplus: ['token', 'secretKey'], ihuyi: ['apiId', 'apiKey'], ronglian: ['accountSid', 'authToken', 'appId'] };
  for (const [id, keys] of Object.entries(fields)) {
    const settings = Object.fromEntries(keys.map(key => [key, ['portable', 'offline', id, key].join('-')]));
    const masked = await api('/config', { mode: id, recipient: { countryCode: '+86', number: '1' + '0'.repeat(10), consent: true }, providers: { [id]: settings } }, 'PUT');
    check(masked.mode === id && keys.every(key => masked.providers[id][key] === '' && masked.secretConfigured[`providers.${id}.${key}`]), `${id} 保存后凭据遮蔽`);
    const localCheck = await api('/providers/check', { provider: id, remote: false }); check(typeof localCheck.ok === 'boolean', `${id} 本地配置检测可用`);
    const pending = await api('/real-test', {}); check(pending.notification.status === 'awaiting_authorization', `${id} 真实测试只准备未拨号`);
    check((await api('/status')).realCallsEnabled === false, `${id} 保存未授权`);
  }
  const mock = await api('/test', {}); let delivered;
  for (let i = 0; i < 30; i++) { delivered = (await api('/notifications')).find(n => n.id === mock.notification.id); if (delivered?.status === 'completed') break; await delay(100); }
  check(delivered?.provider === 'mock' && delivered.status === 'completed', '选真实服务时模拟按钮仍只走 Mock');
  evidence.realCallAttempts = (await api('/notifications')).filter(n => n.provider !== 'mock').reduce((total, n) => total + n.attempts, 0);
  check(evidence.realCallAttempts === 0, '所有真实通道尝试次数为零');
  await stop(); await start();
  const saved = await api('/config');
  check(Object.entries(fields).every(([id, keys]) => keys.every(key => saved.providers[id][key] === '' && saved.secretConfigured[`providers.${id}.${key}`])), '重启后所有新增凭据保留且遮蔽');
  check((await api('/status')).realCallsEnabled === false, '重启未恢复真实授权');
  await stop(); evidence.ok = true;
} finally {
  if (child && child.exitCode === null) { try { await stop(); } catch { child.kill(); } }
  const cleanupDeadline = Date.now() + 5000;
  while (child && child.exitCode === null && child.signalCode === null && Date.now() < cleanupDeadline) await delay(50);
  evidence.processExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (!evidence.processExited) evidence.ok = false;
  writeFileSync(join(root, '.local', 'portable-providers-v015.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: evidence.ok, checks: evidence.checks.length, realCallAttempts: evidence.realCallAttempts }));
  if (!evidence.ok) process.exitCode = 1;
}
