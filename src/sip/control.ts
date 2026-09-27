import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface SipEvent { event?: boolean; type?: string; id?: string; param?: string; [key: string]: unknown }
interface Response { response?: boolean; ok?: boolean; data?: string; token?: string }
const MAX_FRAME = 64 * 1024;

/** Baresip's documented ctrl_tcp protocol: byte-counted JSON netstrings. */
export class SipControl extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0);
  private socket?: Socket;
  private pending = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly events: SipEvent[] = [];

  async connect(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      this.socket = socket;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('SIP control connection timeout')); }, 1500);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.on('error', () => this.rejectPending('SIP control connection failed'));
      socket.on('close', () => { this.rejectPending('SIP control disconnected'); this.emit('disconnected'); });
      socket.on('data', data => {
        try { this.feed(data); } catch { this.rejectPending('Invalid SIP control frame'); socket.destroy(); }
      });
    });
  }

  private feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_FRAME * 2) throw new Error('Oversized frame');
    while (this.buffer.length) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) { if (this.buffer.length > 8) throw new Error('Invalid length'); return; }
      const lengthText = this.buffer.subarray(0, colon).toString('ascii');
      if (!/^\d{1,6}$/.test(lengthText)) throw new Error('Invalid length');
      const length = Number(lengthText);
      if (length > MAX_FRAME) throw new Error('Oversized frame');
      if (this.buffer.length < colon + length + 2) return;
      if (this.buffer[colon + length + 1] !== 44) throw new Error('Missing comma');
      const message = JSON.parse(this.buffer.subarray(colon + 1, colon + length + 1).toString('utf8')) as SipEvent & Response;
      this.buffer = this.buffer.subarray(colon + length + 2);
      if (message.response && message.token) {
        const pending = this.pending.get(message.token);
        if (pending) {
          this.pending.delete(message.token); clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.data ?? '');
          else pending.reject(new Error('SIP command rejected'));
        }
      } else if (message.event) {
        this.events.push(message);
        if (this.events.length > 100) this.events.shift();
        this.emit('event', message);
      }
    }
  }

  command(command: string, params = '', timeoutMs = 3000): Promise<string> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('SIP control unavailable'));
    if (!/^[a-z_]+$/.test(command) || /[\r\n\0]/.test(params)) return Promise.reject(new Error('Invalid SIP command'));
    const token = randomUUID();
    const body = Buffer.from(JSON.stringify({ command, params, token }));
    if (body.length > MAX_FRAME) return Promise.reject(new Error('SIP command too long'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(token); reject(new Error('SIP command outcome unknown')); }, timeoutMs);
      this.pending.set(token, { resolve, reject, timer });
      this.socket!.write(Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(',')]));
    });
  }

  waitFor(predicate: (event: SipEvent) => boolean, timeoutMs = 10000): Promise<SipEvent> {
    const previous = this.events.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const listener = (event: SipEvent) => { if (predicate(event)) { cleanup(); resolve(event); } };
      const disconnected = () => { cleanup(); reject(new Error('SIP control disconnected')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('SIP event timeout')); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('event', listener); this.off('disconnected', disconnected); };
      this.on('event', listener); this.on('disconnected', disconnected);
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
  }
  close(): void { this.rejectPending('SIP control closed'); this.socket?.destroy(); }
}
