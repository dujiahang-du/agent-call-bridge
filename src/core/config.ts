import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../shared/contracts.js';

export const defaults: AppConfig = {
  mode: 'mock', recipient: { countryCode: '+86', number: '', consent: false }, voice: { name: '', rate: 0 },
  notification: { enabled: true, types: ['task_completed','task_failed','task_stalled','retry_exhausted','decision_required'], cooldownSeconds: 300, maxPerHour: 3, maxPerDay: 10, stallMinutes: 15, maxRetries: 2 },
  providers: { twilio: { accountSid: '', authToken: '', from: '', callbackBaseUrl: '' }, aliyun: { accessKeyId: '', accessKeySecret: '', ttsCode: '', regionId: 'cn-hangzhou' }, pushplus: { token: '', secretKey: '' }, ihuyi: { apiId: '', apiKey: '', templateId: '' }, ronglian: { accountSid: '', authToken: '', appId: '', templateText: '' }, sip: { server: '', username: '', password: '', extension: '', port: 5060, transport: 'udp', executable: '' } }, controlPin: '',
};
const secretPaths = ['providers.twilio.accountSid','providers.twilio.authToken','providers.twilio.from','providers.aliyun.accessKeyId','providers.aliyun.accessKeySecret','providers.pushplus.token','providers.pushplus.secretKey','providers.ihuyi.apiId','providers.ihuyi.apiKey','providers.ronglian.accountSid','providers.ronglian.authToken','providers.ronglian.appId','providers.sip.password','controlPin'];
function get(obj: any, path: string) { return path.split('.').reduce((v,k) => v?.[k], obj); }
function set(obj: any, path: string, value: unknown) { const parts = path.split('.'); const key = parts.pop()!; const target = parts.reduce((v,k) => v[k], obj); target[key] = value; }
export function mergeConfig(current: AppConfig, patch: any): AppConfig {
  patch=structuredClone(patch);delete patch.secretConfigured;if(patch.recipient){delete patch.recipient.hasNumber;delete patch.recipient.display;if(patch.recipient.number==='')delete patch.recipient.number;else if(patch.recipient.number===null)patch.recipient.number='';}
  const out = structuredClone(current);
  function merge(a: any, b: any) { for (const [key,value] of Object.entries(b ?? {})) { if (!Object.hasOwn(a,key)) throw new Error(`未知配置字段: ${key}`); if (value && typeof value === 'object' && !Array.isArray(value)) { if (!a[key] || typeof a[key] !== 'object') throw new Error('配置类型错误'); merge(a[key],value); } else a[key] = value; } }
  merge(out,patch);
  for (const path of secretPaths) { const value = get(patch,path); if (value === '' || value === undefined) set(out,path,get(current,path)); else if (value === null) set(out,path,''); }
  if (!['mock','twilio','aliyun','pushplus','ihuyi','ronglian','sip'].includes(out.mode)) throw new Error('电话服务无效');
  if (!/^\+[1-9]\d{0,3}$/.test(out.recipient.countryCode) || !/^\d{0,15}$/.test(out.recipient.number)) throw new Error('请填写有效区号和数字号码');
  if (typeof out.recipient.consent !== 'boolean' || typeof out.notification.enabled !== 'boolean') throw new Error('开关格式错误');
  if (!Array.isArray(out.notification.types) || out.notification.types.some(x => !['task_completed','task_failed','task_stalled','retry_exhausted','decision_required','turn_finished'].includes(x))) throw new Error('通知条件无效');
  for (const [key,min,max] of [['cooldownSeconds',1,86400],['maxPerHour',1,100],['maxPerDay',1,1000],['stallMinutes',1,1440],['maxRetries',0,5]] as const) { const v = out.notification[key]; if (!Number.isInteger(v) || v < min || v > max) throw new Error(`通知参数无效: ${key}`); }
  if (!Number.isInteger(out.voice.rate) || out.voice.rate < -10 || out.voice.rate > 10) throw new Error('语速范围为 -10 到 10');
  if (typeof out.voice.name !== 'string' || out.voice.name.length > 200) throw new Error('语音名称无效');
  if (!Number.isInteger(out.providers.sip.port) || out.providers.sip.port < 1 || out.providers.sip.port > 65535) throw new Error('SIP 端口无效');
  for (const group of Object.values(out.providers)) for (const [key,value] of Object.entries(group)) if (key !== 'port' && (typeof value !== 'string' || value.length > 4096)) throw new Error('服务配置类型无效');
  if (out.controlPin && !/^\d{6,12}$/.test(out.controlPin)) throw new Error('控制 PIN 需为 6–12 位数字');
  return out;
}
export class ConfigStore {
  private value: AppConfig;
  private path: string;
  constructor(readonly dataDir: string, private testMode = false) {
    mkdirSync(dataDir,{recursive:true,mode:0o700}); this.path = join(dataDir,'config.enc');
    // 补齐新通道默认值，保留旧凭据；只读启动不重写原加密文件。
    this.value = existsSync(this.path) ? mergeConfig(defaults,JSON.parse(this.crypt('decrypt',readFileSync(this.path,'utf8')))) : structuredClone(defaults);
  }
  private crypt(operation: 'encrypt'|'decrypt', input: string): string {
    if (process.platform === 'win32' && !this.testMode) {
      const script = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $data=[Console]::In.ReadToEnd(); " + (operation === 'encrypt' ? "$bytes=[Text.Encoding]::UTF8.GetBytes($data); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))" : "$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)");
      const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
      if (result.status !== 0) throw new Error('Windows 本地凭据加密失败，请检查当前用户权限'); return result.stdout.trim();
    }
    const keyPath = join(this.dataDir,'local.key'); if (!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32),{mode:0o600}); const key = readFileSync(keyPath);
    if (operation === 'encrypt') { const iv=randomBytes(12); const c=createCipheriv('aes-256-gcm',key,iv); const result=Buffer.concat([c.update(input,'utf8'),c.final()]); return Buffer.concat([iv,c.getAuthTag(),result]).toString('base64'); }
    const data=Buffer.from(input,'base64'); const d=createDecipheriv('aes-256-gcm',key,data.subarray(0,12)); d.setAuthTag(data.subarray(12,28)); return Buffer.concat([d.update(data.subarray(28)),d.final()]).toString('utf8');
  }
  read() { return structuredClone(this.value); }
  masked() { const out:any=this.read(); out.secretConfigured={}; for(const path of secretPaths) {out.secretConfigured[path]=Boolean(get(out,path));set(out,path,'');} out.recipient.hasNumber=Boolean(out.recipient.number);out.recipient.display=out.recipient.number?`${out.recipient.countryCode} *** ${out.recipient.number.slice(-4)}`:'';out.recipient.number='';return out; }
  update(patch: unknown) { const next=mergeConfig(this.value,patch); const temp=this.path+'.tmp';writeFileSync(temp,this.crypt('encrypt',JSON.stringify(next)),{mode:0o600});renameSync(temp,this.path);this.value=next;return this.masked(); }
}
