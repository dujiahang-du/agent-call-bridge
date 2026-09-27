import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { SipControl } from './control.js';
import { verifySipExecutable } from './binary.js';

export interface EndpointOptions {
  executable: string; directory: string; username: string;
  server?: string; serverPort?: number; password?: string; transport?: 'udp' | 'tcp';
  register?: boolean; autoAnswer?: boolean; source?: string; receiveFile?: string;
  sipPort?: number; bindAddress?: string;
}
const execFileAsync = promisify(execFile);
let currentSid: string | undefined;
async function protectDirectory(directory: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!currentSid) {
    const { stdout } = await execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    currentSid = stdout.match(/S-1-5-[\d-]+/)?.[0];
    if (!currentSid) throw new Error('Cannot identify current Windows user for private SIP configuration');
  }
  await execFileAsync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${currentSid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
}
export async function freePort(protocol: 'tcp' | 'udp' = 'tcp'): Promise<number> {
  if (protocol === 'udp') {
    const socket = createSocket('udp4');
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise<void>(resolve => socket.close(resolve)); return port;
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
export function validateSipValue(value: string, type: 'host' | 'user' | 'password'): void {
  const pattern = type === 'host' ? /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/
    : type === 'user' ? /^[a-zA-Z0-9_.+\-]{1,64}$/ : /^[^\r\n\0;"<>\\]{0,256}$/;
  if (!pattern.test(value)) throw new Error(`Invalid SIP ${type}`);
}
function nativePath(path: string, directory: string): string {
  if (/[\r\n\0,]/.test(path)) throw new Error('Unsupported SIP audio path');
  return relative(directory, resolve(path)).replaceAll('\\', '/');
}

/** Each endpoint owns one hidden subprocess; control always binds to loopback. */
export class SipEndpoint {
  readonly control = new SipControl();
  process?: ChildProcess;
  sipPort = 0;
  diagnostics = '';
  private stopped = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  constructor(readonly options: EndpointOptions) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('SIP endpoint is stopped'));
    return this.starting ??= this.startInternal();
  }

  private async startInternal(): Promise<void> {
    const o = this.options;
    await verifySipExecutable(o.executable);
    validateSipValue(o.username, 'user');
    validateSipValue(o.server ?? '127.0.0.1', 'host');
    validateSipValue(o.password ?? '', 'password');
    if (o.transport && !['udp', 'tcp'].includes(o.transport)) throw new Error('TLS is not enabled in this experimental build');
    if (o.serverPort !== undefined && (!Number.isInteger(o.serverPort) || o.serverPort < 1 || o.serverPort > 65535)) throw new Error('Invalid SIP port');
    if (o.bindAddress && !['0.0.0.0', '127.0.0.1'].includes(o.bindAddress)) throw new Error('Invalid bind address');
    this.sipPort = o.sipPort ?? await freePort('udp');
    const controlPort = await freePort();
    await mkdir(o.directory, { recursive: true, mode: 0o700 });
    await protectDirectory(o.directory);
    const config = [
      `sip_listen ${o.bindAddress ?? '127.0.0.1'}:${this.sipPort}`,
      ...((o.bindAddress ?? '127.0.0.1') === '127.0.0.1' ? ['net_interface 127.0.0.1'] : []),
      `sip_transports ${o.transport ?? 'udp'}`,
      `sip_trans_def ${o.transport ?? 'udp'}`,
      'call_max_calls 1', 'call_local_timeout 30', `call_accept ${o.autoAnswer ? 'yes' : 'no'}`,
      'audio_source ausine,440', 'audio_player none', 'audio_alert none',
      'ausrc_format s16', 'auplay_format s16', 'auenc_format s16', 'audec_format s16',
      'audio_telev_pt 101', 'rtp_stats yes', 'rtp_timeout 20',
      'module g711', 'module aufile', 'module ausine', 'module auconv', 'module auresamp',
      'module_app menu', 'module_app ctrl_tcp', 'module_app debug_cmd', 'module_app rtcpsummary',
      `ctrl_tcp_listen 127.0.0.1:${controlPort}`, 'module_app account',
      'ringback_disabled yes', 'menu_bell off',
    ].join('\n') + '\n';
    const host = o.register ? `${o.server}:${o.serverPort ?? 5060}` : `127.0.0.1:${this.sipPort}`;
    const account = `<sip:${o.username}@${host};transport=${o.transport ?? 'udp'}>;regint=${o.register ? 300 : 0};answermode=${o.autoAnswer ? 'auto' : 'manual'};audio_codecs=PCMU/8000/1,PCMA/8000/1;dtmfmode=rtpevent;ptime=20;inreq_allowed=${o.autoAnswer ? 'yes' : 'no'}${o.register ? `;auth_user=${o.username};auth_pass="${o.password ?? ''}"` : ''}${o.source ? `;audio_source=aufile,${nativePath(o.source, o.directory)}` : ''}${o.receiveFile ? `;audio_player=aufile,${nativePath(o.receiveFile, o.directory)}` : ''}\n`;
    await writeFile(resolve(o.directory, 'config'), config, { mode: 0o600 });
    await writeFile(resolve(o.directory, 'accounts'), account, { mode: 0o600 });
    await writeFile(resolve(o.directory, 'contacts'), '', { mode: 0o600 });
    if (this.stopped) throw new Error('SIP endpoint stopped during startup');
    this.process = spawn(resolve(o.executable), [], { cwd: o.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let startError = false;
    this.process.on('error', () => { startError = true; });
    const collect = (data: Buffer) => { this.diagnostics = (this.diagnostics + data.toString()).slice(-16384); };
    this.process.stdout?.on('data', collect); this.process.stderr?.on('data', collect);
    this.process.once('exit', () => this.control.close());
    for (let attempt = 0; attempt < 35; attempt++) {
      if (this.stopped) throw new Error('SIP endpoint stopped during startup');
      if (startError || this.process.exitCode !== null) throw new Error('SIP executable failed to start');
      try { await this.control.connect(controlPort); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error('SIP control did not start');
  }

  async registration(timeoutMs = 10000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    do {
      const status = await this.control.command('reginfo');
      const plain = status.replace(/\x1b\[[0-9;]*m/g, '');
      if (/\bOK\b/.test(plain)) return true;
      if (/\bERR\b/.test(plain)) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < end);
    return false;
  }

  stop(removePrivateFiles = false): Promise<void> {
    this.stopped = true;
    return this.stopping ??= this.stopInternal(removePrivateFiles);
  }

  private async stopInternal(removePrivateFiles: boolean): Promise<void> {
    // Startup must settle first: otherwise a late mkdir/spawn could outlive shutdown.
    await this.starting?.catch(() => undefined);
    const child = this.process;
    const alive = () => Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
    if (child && alive()) {
      try { await this.control.command('quit', '', 1000); } catch { /* Best effort graceful unregister. */ }
      if (alive()) {
        await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1200))]);
      }
      if (alive()) {
        child.kill();
        await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 1200))]);
        if (alive()) throw new Error('Owned SIP subprocess did not stop');
      }
    }
    this.control.close();
    if (removePrivateFiles) await rm(this.options.directory, { recursive: true, force: true });
  }
}
