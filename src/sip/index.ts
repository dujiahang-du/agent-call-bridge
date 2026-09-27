import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig, CallProvider, CallRequest, CallResult, CheckResult } from '../shared/contracts.js';
import { SipEndpoint, validateSipValue } from './endpoint.js';
import { defaultSipExecutable, verifySipExecutable } from './binary.js';
export { defaultSipExecutable } from './binary.js';

export interface SipProviderOptions {
  dataDir?: string;
  synthesize?: (text: string, voice: string, rate: number) => Promise<Buffer>;
  setupTimeoutMs?: number;
}
interface ActiveCall { endpoint: SipEndpoint; result: CallResult; timer?: NodeJS.Timeout; played: boolean; cleanup?: Promise<void>; }

export function validateSipConfig(config: AppConfig): void {
  const sip = config.providers.sip;
  validateSipValue(sip.server, 'host'); validateSipValue(sip.username, 'user');
  validateSipValue(sip.password, 'password'); validateSipValue(sip.extension, 'user');
  if (!['udp', 'tcp'].includes(sip.transport.toLowerCase())) throw new Error('本期 SIP 仅支持 UDP/TCP，未启用 TLS/SRTP。');
  if (!Number.isInteger(sip.port) || sip.port < 1 || sip.port > 65535) throw new Error('SIP 端口应在 1–65535。');
  if (/[\r\n\0]/.test(sip.executable)) throw new Error('SIP 可执行文件路径无效。');
}

function wavDuration(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('TTS did not return WAV audio');
  let bytesPerSecond = 0;
  let dataSize = 0;
  let supportedFormat = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + size > buffer.length) throw new Error('Truncated WAV audio');
    const type = buffer.toString('ascii', offset, offset + 4);
    if (type === 'fmt ' && size >= 16) {
      bytesPerSecond = buffer.readUInt32LE(offset + 16);
      supportedFormat = buffer.readUInt16LE(offset + 8) === 1 && buffer.readUInt16LE(offset + 10) === 1 && buffer.readUInt32LE(offset + 12) === 8000 && buffer.readUInt16LE(offset + 22) === 16;
    }
    if (type === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  const duration = dataSize / bytesPerSecond;
  if (!supportedFormat) throw new Error('SIP TTS must return 8 kHz mono 16-bit PCM WAV');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error('SIP audio duration must be within 180 seconds');
  return duration;
}

export function createSipProvider(options: SipProviderOptions = {}): CallProvider {
  const directory = resolve(options.dataDir ?? '.local', 'sip');
  const calls = new Map<string, ActiveCall>();
  const endpoints = new Set<SipEndpoint>();
  let preparing = false;
  let closed = false;
  let shutdown: Promise<CheckResult> | undefined;

  function endpoint(config: AppConfig, id: string, source?: string): SipEndpoint {
    if (closed) throw new Error('SIP provider is stopped');
    const sip = config.providers.sip;
    const ep = new SipEndpoint({ executable: sip.executable || defaultSipExecutable(), directory: join(directory, id),
      username: sip.username, server: sip.server, serverPort: sip.port, password: sip.password,
      transport: sip.transport.toLowerCase() as 'udp' | 'tcp', register: true, source,
      bindAddress: /^(127\.|localhost$)/.test(sip.server) ? '127.0.0.1' : '0.0.0.0' });
    endpoints.add(ep); return ep;
  }
  async function finish(call: ActiveCall, result: CallResult): Promise<void> {
    if (call.timer) clearTimeout(call.timer);
    if (call.result.status === 'accepted') call.result = result;
    call.cleanup ??= call.endpoint.stop(true).then(() => { endpoints.delete(call.endpoint); }).catch(() => undefined);
    await call.cleanup;
  }
  function failure(message: string, rawCode: string): CallResult { return { status: 'failed', retryable: false, message, rawCode }; }

  const provider: CallProvider = {
    id: 'sip',
    async check(config, checkOptions): Promise<CheckResult> {
      let ep: SipEndpoint | undefined;
      try {
        if (closed) return { ok: false, message: 'SIP 服务已经停止。' };
        validateSipConfig(config);
        await verifySipExecutable(config.providers.sip.executable || defaultSipExecutable());
        if (!options.synthesize) return { ok: false, message: 'SIP 二进制存在，但尚未连接中文语音生成器。' };
        if (!checkOptions?.remote) return { ok: true, message: 'SIP 本地配置与二进制可用；未向服务器注册，未拨号。' };
        ep = endpoint(config, `check-${randomUUID()}`); await ep.start();
        const registered = await ep.registration(options.setupTimeoutMs ?? 10000);
        return { ok: registered, message: registered ? 'SIP 服务器注册成功；尚未拨打分机。' : 'SIP 注册未成功，请核对服务器、账号和网络。' };
      } catch { return { ok: false, message: 'SIP 配置、语音或二进制不可用；请核对地址、账号、UDP/TCP及原生构建。' }; }
      finally { if (ep) await ep.stop(true).then(() => { endpoints.delete(ep!); }).catch(() => undefined); }
    },
    async dial(request: CallRequest, config: AppConfig): Promise<CallResult> {
      if (closed) return failure('SIP 服务已经停止。', 'SIP_SHUTDOWN');
      if (preparing || [...calls.values()].some(call => call.result.status === 'accepted')) return failure('SIP 已有通话。', 'SIP_BUSY');
      if (!options.synthesize) return failure('SIP 未连接语音生成器。', 'SIP_TTS_MISSING');
      if (request.decision) return failure('SIP 本期支持语音通知；电话决策尚未开放。请在界面回复。', 'SIP_DECISION_UNSUPPORTED');
      const id = randomUUID();
      let ep: SipEndpoint | undefined;
      let submitted = false;
      let call: ActiveCall | undefined;
      preparing = true;
      try {
        validateSipConfig(config);
        const audio = await options.synthesize(request.text, config.voice.name, config.voice.rate);
        if (closed) return failure('SIP 服务已经停止，未拨号。', 'SIP_SHUTDOWN');
        const seconds = wavDuration(audio);
        const runDirectory = join(directory, id);
        await mkdir(runDirectory, { recursive: true, mode: 0o700 });
        const audioPath = join(runDirectory, 'announcement.wav');
        // Endpoint protects the directory before configuration; protect audio by writing only after start.
        ep = endpoint(config, id, audioPath); await ep.start();
        if (closed) return failure('SIP 服务已经停止，未拨号。', 'SIP_SHUTDOWN');
        await writeFile(audioPath, audio, { mode: 0o600 });
        if (!await ep.registration(options.setupTimeoutMs ?? 10000)) return failure('SIP 注册失败，未拨号。', 'SIP_REGISTER_FAILED');
        if (closed) return failure('SIP 服务已经停止，未拨号。', 'SIP_SHUTDOWN');
        call = { endpoint: ep, played: false, result: { status: 'accepted', callId: id } }; calls.set(id, call);
        if (calls.size > 100) for (const [key, value] of calls) { if (value.result.status !== 'accepted') { calls.delete(key); break; } }
        const sip = config.providers.sip;
        submitted = true;
        await ep.control.command('dial', `sip:${sip.extension}@${sip.server}:${sip.port};transport=${sip.transport.toLowerCase()}`);
        // Return the owned id while ringing so the UI can cancel before answer.
        void (async () => {
        const event = await ep!.control.waitFor(event => event.type === 'CALL_ESTABLISHED' || event.type === 'CALL_CLOSED', options.setupTimeoutMs ?? 30000);
        if (call!.result.status !== 'accepted') return;
        if (event.type !== 'CALL_ESTABLISHED') {
          await finish(call!, { ...failure('SIP 对方未接通或拒接。', 'SIP_NOT_ANSWERED'), callId: id }); return;
        }
        ep!.control.on('event', event => {
          if (event.type === 'END_OF_FILE' && call!.result.status === 'accepted') {
            call!.played = true;
            void ep!.control.command('hangup').catch(() => undefined).finally(() => finish(call!, { status: 'completed', callId: id, message: '语音文件播放结束并已挂断；不代表对方已理解汇报。' }));
          }
          if (event.type === 'AUDIO_ERROR' && call!.result.status === 'accepted') {
            void finish(call!, { ...failure('SIP 音频发送失败，已停止通话。', 'SIP_AUDIO_FAILED'), callId: id });
          }
          if (event.type === 'CALL_CLOSED' && call!.result.status === 'accepted') {
            void finish(call!, { status: call!.played ? 'completed' : 'failed', callId: id, retryable: false, message: call!.played ? '语音播放结束。' : '对方在播放结束前挂断。' });
          }
        });
        call!.timer = setTimeout(() => {
          if (call!.result.status !== 'accepted') return;
          void finish(call!, { ...failure('SIP 语音没有按时报告播放结束，已停止通话。', 'SIP_AUDIO_TIMEOUT'), callId: id });
        }, Math.ceil(seconds * 1000) + 5000);
        call!.timer.unref();
        })().catch(async () => {
          if (call!.result.status === 'accepted') await finish(call!, { status: 'unknown', callId: id, retryable: false, message: 'SIP 接通状态无法确认，已停止且不会重拨。', rawCode: 'SIP_OUTCOME_UNKNOWN' });
        });
        return { status: 'accepted', callId: id, message: 'SIP 已发起，正在等待接通；可以立即停止。' };
      } catch {
        const result: CallResult = submitted ? { status: 'unknown', callId: id, retryable: false, message: 'SIP 拨号结果未知，已尝试停止；不会自动重拨。', rawCode: 'SIP_OUTCOME_UNKNOWN' }
          : failure('SIP 启动、注册或语音生成失败，未拨号。', 'SIP_SETUP_FAILED');
        if (call) await finish(call, result);
        return result;
      } finally {
        preparing = false;
        if (!call || call.result.status !== 'accepted') { if (ep) await ep.stop(true).then(() => { endpoints.delete(ep!); }).catch(() => undefined); await rm(join(directory, id), { recursive: true, force: true }).catch(() => undefined); }
      }
    },
    async cancel(callId): Promise<CheckResult> {
      const call = calls.get(callId);
      if (!call) return { ok: false, message: 'SIP 通话不属于当前进程或已不可查询。' };
      if (call.result.status !== 'accepted') return { ok: true, message: 'SIP 通话已经结束。' };
      call.result = { status: 'failed', callId, retryable: false, message: '用户已停止 SIP 通话。', rawCode: 'CANCELED' };
      if (call.timer) clearTimeout(call.timer);
      try { await call.endpoint.control.command('hangup'); } catch { /* Stop also kills the owned subprocess. */ }
      await finish(call, call.result);
      return { ok: true, message: 'SIP 通话已停止。' };
    },
    async poll(callId): Promise<CallResult> { return calls.get(callId)?.result ?? { status: 'unknown', callId, retryable: false, message: '当前进程没有此 SIP 通话状态；不会补拨。' }; },
    shutdown(): Promise<CheckResult> {
      closed = true;
      return shutdown ??= (async () => {
        const active = [...calls.entries()].filter(([, call]) => call.result.status === 'accepted');
        const owned = [...endpoints];
        const results = await Promise.allSettled([
          ...active.map(([callId, call]) => finish(call, { status: 'failed', callId, retryable: false, rawCode: 'SIP_SHUTDOWN', message: '服务退出，SIP 通话已停止。' })),
          ...owned.map(ep => ep.stop(true)),
        ]);
        const ok = results.every(result => result.status === 'fulfilled');
        if (ok) endpoints.clear();
        return { ok, message: ok ? 'SIP 通话、准备中的连接和私密音频已停止并清理。' : '部分 SIP 资源未能完成清理，请检查本机进程。' };
      })();
    },
  };
  return provider;
}
