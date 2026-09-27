import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AgentEventInput, AppConfig, CallProvider, CallRequest, CallResult, ProviderId } from '../shared/contracts.js';
import { ConfigStore } from './config.js';
import { Store } from './store.js';
import { canonicalDestination } from './destination.js';

const eventSchema=z.object({eventId:z.string().min(1).max(200),taskId:z.string().min(1).max(200),source:z.string().min(1).max(100),type:z.enum(['task_completed','task_failed','task_stalled','retry_exhausted','decision_required','turn_finished']),summary:z.string().min(1).max(800),occurredAt:z.string().datetime().optional(),threadId:z.string().max(200).optional(),sessionId:z.string().max(200).optional(),evidence:z.object({kind:z.enum(['agent_report','verified']),description:z.string().max(1000)}).optional(),decision:z.object({question:z.string().min(1).max(300),options:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),label:z.string().min(1).max(100)})).min(2).max(9),expiresInSeconds:z.number().int().min(15).max(3600).optional()}).optional()}).strict();
export function safeMessage(value: unknown): string {return String(value ?? '').slice(0,500).replace(/\b(?:sk-|AC)[A-Za-z0-9_-]{16,}\b/g,'[已隐藏]').replace(/\+?\d[\d -]{8,}\d/g,'[号码已隐藏]');}
function equal(a:string,b:string) {const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function canonical(value:any):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
async function bounded<T>(operation:Promise<T>,milliseconds:number):Promise<T>{let timeout:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('服务响应超时')),milliseconds);timeout.unref();})]);}finally{if(timeout)clearTimeout(timeout);}}
export class Engine {
  readonly config:ConfigStore; readonly store:Store;
  private busy=false; private closed=false; private timer:ReturnType<typeof setInterval>;
  private closing?:Promise<void>;
  private shutdownStarted=false;
  realCallsEnabled=false; private activeId?:string;
  constructor(readonly dataDir:string,readonly providers:Record<ProviderId,CallProvider>,readonly testMode=false){
    this.config=new ConfigStore(dataDir,testMode);this.store=new Store(dataDir);
    // Authorization is a live user decision, never restored from a prior process.
    this.store.run("UPDATE notifications SET authorized=0,status='awaiting_authorization' WHERE provider!='mock' AND status='queued'");
    this.timer=setInterval(()=>{void this.drain();},250);this.timer.unref();
  }
  get paused(){return this.store.meta('paused','false')==='true';}
  get stopping(){return this.shutdownStarted;}
  private ensureRunning(){if(this.shutdownStarted||this.closed)throw new Error('服务正在关闭，拒绝新操作');}
  beginShutdown(){if(this.shutdownStarted)return;this.shutdownStarted=true;this.store.setMeta('paused','true');this.disableReal();this.store.run("UPDATE decisions SET status='cancelled' WHERE status='pending'");}
  updateConfig(patch:unknown){this.ensureRunning();const result=this.config.update(patch);this.disableReal();return result;}
  enableReal(confirmation:string){this.ensureRunning();if(confirmation!=='我确认线路可用并同意受限自动外呼及可能费用')throw new Error('需要明确确认线路、费用和自动外呼');const c=this.config.read();if(c.mode==='mock'||!canonicalDestination(c)||!c.recipient.consent)throw new Error('请先设置真实服务、本人号码或 SIP 分机目标及接听同意');this.realCallsEnabled=true;return this.status();}
  status(){const events=this.store.all('SELECT data,created_at FROM events ORDER BY created_at DESC LIMIT 100');const sources=new Map<string,any>();for(const row of events){const e=JSON.parse(row.data);if(e.source!=='mock-ui'&&!sources.has(e.threadId??e.source))sources.set(e.threadId??e.source,{source:e.source,threadId:e.threadId,sessionId:e.sessionId,lastSeen:new Date(row.created_at).toISOString()});}return {mode:this.config.read().mode,paused:this.paused,realCallsEnabled:this.realCallsEnabled,connectedAgents:[...sources.values()],lastEventAt:events[0]?new Date(events[0].created_at).toISOString():null,capabilities:{desktopBridge:true,mcp:true,desktopWakeFinishedTask:false,managedCodex:'protocol-adapter-unverified-model',realCalls:'requires-explicit-authorization',sip:'see-provider-check',stallMonitoring:'explicit-heartbeat-only'},activeMonitors:this.store.get('SELECT COUNT(*) AS n FROM task_monitors WHERE active=1').n};}
  heartbeat(input:unknown){this.ensureRunning();const h=z.object({taskId:z.string().min(1).max(200),source:z.string().min(1).max(100),threadId:z.string().max(200).optional(),sessionId:z.string().max(200).optional(),active:z.boolean().default(true)}).strict().parse(input);const old=this.store.get('SELECT * FROM task_monitors WHERE task_id=?',h.taskId);if(old&&(old.thread_id!==(h.threadId??null)||old.session_id!==(h.sessionId??null)))throw new Error('心跳任务已绑定其他会话');this.store.run('INSERT INTO task_monitors(task_id,source,thread_id,session_id,last_seen,active,notified) VALUES(?,?,?,?,?,?,0) ON CONFLICT(task_id) DO UPDATE SET last_seen=excluded.last_seen,active=excluded.active,notified=0',h.taskId,h.source,h.threadId??null,h.sessionId??null,Date.now(),h.active?1:0);return {ok:true,taskId:h.taskId,active:h.active,scope:'显式注册的任务；心跳超时仅表示疑似无进展'};}
  private checkMonitors(){const cutoff=Date.now()-this.config.read().notification.stallMinutes*60000;for(const row of this.store.all('SELECT * FROM task_monitors WHERE active=1 AND notified=0 AND last_seen<=?',cutoff)){this.store.run('UPDATE task_monitors SET notified=1 WHERE task_id=?',row.task_id);this.accept({eventId:`stall:${row.task_id}:${row.last_seen}`,taskId:row.task_id,source:row.source,threadId:row.thread_id??undefined,sessionId:row.session_id??undefined,type:'task_stalled',summary:'已注册任务的心跳超过设置时长未更新，疑似无进展；可能仍在执行耗时工作，请核对。'});}}
  events(){return this.store.all('SELECT data,created_at FROM events ORDER BY created_at DESC LIMIT 500').map(r=>({...JSON.parse(r.data),createdAt:new Date(r.created_at).toISOString()}));}
  notifications(){return this.store.all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 500').map(r=>this.notificationView(r));}
  private notificationView(r:any){if(!r)return null;const request=JSON.parse(r.request);request.to=request.to?`***${request.to.slice(-4)}`:'';return {id:r.id,eventId:r.event_id,taskId:r.task_id,provider:r.provider,status:r.status,attempts:r.attempts,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),nextAttemptAt:new Date(r.next_at).toISOString(),callId:r.call_id,message:r.message,request};}
  decisions(){this.expire();return this.store.all('SELECT * FROM decisions ORDER BY created_at DESC LIMIT 500').map(r=>this.decisionView(r));}
  private decisionView(r:any){if(!r)return null;const options=JSON.parse(r.options);return {id:r.id,eventId:r.event_id,taskId:r.task_id,threadId:r.thread_id,sessionId:r.session_id,status:r.status,question:r.question,options,createdAt:new Date(r.created_at).toISOString(),expiresAt:new Date(r.expires_at).toISOString(),optionId:r.option_id,answer:options.find((o:any)=>o.id===r.option_id)??null};}
  decision(id:string){this.expire();return this.decisionView(this.store.get('SELECT * FROM decisions WHERE id=?',id));}
  private expire(){this.store.run("UPDATE decisions SET status='expired' WHERE status='pending' AND expires_at<=?",Date.now());}
  accept(input:unknown,forceMock=false,requireAuthorization=false){
    this.ensureRunning();
    const event=eventSchema.parse(input) as AgentEventInput;
    if(event.type==='decision_required'&&!event.decision)throw new Error('待决定事件需要问题和允许选项');
    if(event.decision&&event.type!=='decision_required')throw new Error('仅待决定事件可带选择');
    if(event.decision&&new Set(event.decision.options.map(x=>x.id)).size!==event.decision.options.length)throw new Error('选项 ID 不能重复');
    if(event.type==='task_completed'&&!event.evidence)event.evidence={kind:'agent_report',description:'Agent 报告完成；未提供独立验收证据'};
    const existing=this.store.get('SELECT data FROM events WHERE id=?',event.eventId);
    if(existing){const old=JSON.parse(existing.data);if(canonical(old)!==canonical(JSON.parse(JSON.stringify(event))))throw new Error('事件 ID 已绑定其他内容或线程');return {event:old,notification:this.notificationView(this.store.get('SELECT * FROM notifications WHERE event_id=?',event.eventId)),decision:this.decisionView(this.store.get('SELECT * FROM decisions WHERE event_id=?',event.eventId)),duplicate:true};}
    const config=this.config.read(),now=Date.now();const mode=forceMock?'mock':config.mode;
    let notification:any=null,decision:any=null;
    this.store.transaction(()=>{
      this.store.run('INSERT INTO events(id,task_id,type,data,created_at) VALUES(?,?,?,?,?)',event.eventId,event.taskId,event.type,JSON.stringify(event),now);
      if(['task_completed','task_failed','retry_exhausted','decision_required'].includes(event.type))this.store.run('UPDATE task_monitors SET active=0 WHERE task_id=? AND (thread_id IS ?)',event.taskId,event.threadId??null);
      if(event.decision){const id=randomUUID();this.store.run('INSERT INTO decisions(id,event_id,task_id,thread_id,session_id,status,question,options,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,event.eventId,event.taskId,event.threadId??null,event.sessionId??null,'pending',event.decision.question,JSON.stringify(event.decision.options),now,now+(event.decision.expiresInSeconds??300)*1000);decision=this.decisionView(this.store.get('SELECT * FROM decisions WHERE id=?',id));}
      const id=randomUUID();const request:CallRequest={notificationId:id,eventId:event.eventId,eventType:event.type,taskId:event.taskId,to:canonicalDestination(config),text:`${event.type==='task_completed'&&event.evidence?.kind!=='verified'?'Agent 报告完成，尚未独立验收。':''}${event.summary}`,...(decision?{decision:{id:decision.id,question:decision.question,options:decision.options}}:{})};
      const enabled=forceMock||requireAuthorization||(config.notification.enabled&&config.notification.types.includes(event.type));
      const authorized=!requireAuthorization&&(mode==='mock'||this.realCallsEnabled);
      const status=!enabled?'suppressed':authorized?'queued':'awaiting_authorization';
      this.store.run('INSERT INTO notifications(id,event_id,task_id,provider,status,next_at,created_at,updated_at,authorized,request) VALUES(?,?,?,?,?,?,?,?,?,?)',id,event.eventId,event.taskId,mode,status,now,now,now,authorized?1:0,JSON.stringify(request));notification=this.notificationView(this.store.get('SELECT * FROM notifications WHERE id=?',id));
    });
    void this.drain();return {event,notification,decision,duplicate:false};
  }
  authorize(id:string,confirmation:string){this.ensureRunning();if(confirmation!=='拨打本次真实电话')throw new Error('请明确确认本次真实拨号及可能费用');const row=this.store.get('SELECT * FROM notifications WHERE id=?',id);if(!row||row.status!=='awaiting_authorization')throw new Error('通知不在待授权状态');const config=this.config.read();const destination=canonicalDestination(config);if(!config.recipient.consent||!destination||config.mode!==row.provider||JSON.parse(row.request).to!==destination)throw new Error('请核对接听目标、同意和服务商；目标变化后需创建新通知');this.store.run("UPDATE notifications SET authorized=1,status='queued',next_at=?,updated_at=? WHERE id=?",Date.now(),Date.now(),id);void this.drain();return this.notificationView(this.store.get('SELECT * FROM notifications WHERE id=?',id));}
  disableReal(){this.realCallsEnabled=false;this.store.run("UPDATE notifications SET authorized=0,status=CASE WHEN status='queued' THEN 'awaiting_authorization' ELSE status END WHERE provider!='mock' AND status IN ('queued','dialing','accepted')");return this.status();}
  async pause(value:boolean){if(!value)this.ensureRunning();const stopResults:{provider:string;ok:boolean;message:string}[]=[];this.store.setMeta('paused',String(value));if(value){this.disableReal();for(const row of this.store.all("SELECT * FROM notifications WHERE status IN ('dialing','accepted') AND call_id IS NOT NULL")){try{const result=await bounded(this.providers[row.provider as ProviderId].cancel(row.call_id,this.config.read()),this.testMode?300:5000);stopResults.push({provider:row.provider,ok:result.ok,message:safeMessage(result.message)});this.store.run('UPDATE notifications SET message=?,updated_at=? WHERE id=?',safeMessage(result.message),Date.now(),row.id);}catch{stopResults.push({provider:row.provider,ok:false,message:'未确认现有通话已停止，请到服务商核对；后续拨号已暂停'});}}}return {...this.status(),stopResults};}
  async respondDecision(input:{decisionId:string;optionId:string;callId?:string;pin?:string}){
    this.ensureRunning();
    this.expire();const row=this.store.get('SELECT * FROM decisions WHERE id=?',input.decisionId);if(!row||row.status!=='pending')throw new Error('决定已过期或已处理');
    if(input.callId){const binding=this.findCallById(input.callId);if(!binding||binding.request.decision?.id!==input.decisionId||binding.request.taskId!==row.task_id)throw new Error('通话与任务不匹配');const pin=this.config.read().controlPin;if(!pin||!input.pin||!equal(pin,input.pin))throw new Error('控制 PIN 无效');}
    if(!JSON.parse(row.options).some((o:any)=>o.id===input.optionId))throw new Error('回复不在允许选项中');
    const r=this.store.run("UPDATE decisions SET status='answered',option_id=?,responded_at=? WHERE id=? AND status='pending' AND expires_at>?",input.optionId,Date.now(),input.decisionId,Date.now());if(r.changes!==1)throw new Error('决定已被处理');return true;
  }
  findCallById(callId:string){const row=this.store.get('SELECT * FROM notifications WHERE call_id=?',callId);if(!row)return undefined;const request=JSON.parse(row.request) as CallRequest;const decision=request.decision?this.decision(request.decision.id):null;return {request,expiresAt:decision?.expiresAt??new Date(row.created_at+300000).toISOString(),consumed:decision?decision.status!=='pending':false};}
  updateCall(callId:string,result:CallResult){const row=this.store.get('SELECT * FROM notifications WHERE call_id=?',callId);if(row&&['accepted','dialing'].includes(row.status))this.store.run('UPDATE notifications SET status=?,message=?,updated_at=? WHERE id=?',result.status,safeMessage(result.message),Date.now(),row.id);}
  private limitReason(request:CallRequest,c:AppConfig){const now=Date.now();const last=this.store.get('SELECT MAX(created_at) AS at FROM attempts WHERE recipient=?',request.to)?.at;if(last&&now-last<c.notification.cooldownSeconds*1000)return '号码冷却中，本次通知未拨打';const hour=this.store.get('SELECT COUNT(*) AS n FROM attempts WHERE recipient=? AND created_at>?',request.to,now-3600000).n;const day=this.store.get('SELECT COUNT(*) AS n FROM attempts WHERE recipient=? AND created_at>?',request.to,now-86400000).n;return hour>=c.notification.maxPerHour?'已达到每小时限额':day>=c.notification.maxPerDay?'已达到每日限额':null;}
  async drain(){if(this.busy||this.closed||this.shutdownStarted)return;this.busy=true;try{
    this.expire();this.checkMonitors();const active=this.store.get("SELECT * FROM notifications WHERE status='accepted' ORDER BY created_at LIMIT 1");
    if(active){if(Date.now()-active.created_at>600000){this.updateCall(active.call_id,{status:'unknown',message:'通话结果等待超过十分钟，停止自动处理；请人工核对'});return;}if(active.next_at>Date.now())return;const provider=this.providers[active.provider as ProviderId];this.store.run('UPDATE notifications SET next_at=? WHERE id=?',Date.now()+10000,active.id);if(provider.poll&&active.call_id){try{const result=await bounded(provider.poll(active.call_id,this.config.read(),new Date(active.created_at).toISOString()),this.testMode?300:15000);this.updateCall(active.call_id,result);}catch{this.store.run('UPDATE notifications SET message=? WHERE id=?','查询暂不可用，等待下一次有界查询，不会重拨',active.id);}}return;}
    if(this.paused)return;const row=this.store.get("SELECT * FROM notifications WHERE status='queued' AND next_at<=? ORDER BY created_at LIMIT 1",Date.now());if(!row)return;
    const config=this.config.read();const request=JSON.parse(row.request) as CallRequest;const real=row.provider!=='mock';
    if(real&&(!row.authorized||!config.recipient.consent||config.mode!==row.provider||!canonicalDestination(config)||request.to!==canonicalDestination(config))){this.store.run("UPDATE notifications SET status='awaiting_authorization',authorized=0 WHERE id=?",row.id);return;}
    if(real){const reason=this.limitReason(request,config);if(reason){this.store.run("UPDATE notifications SET status='suppressed',message=?,updated_at=? WHERE id=?",reason,Date.now(),row.id);return;}}
    this.store.transaction(()=>{this.store.run("UPDATE notifications SET status='dialing',attempts=attempts+1,updated_at=? WHERE id=?",Date.now(),row.id);if(real)this.store.run('INSERT INTO attempts(notification_id,recipient,created_at) VALUES(?,?,?)',row.id,request.to,Date.now());});this.activeId=row.id;
    let result:CallResult;let timeout:ReturnType<typeof setTimeout>|undefined;
    try{result=await Promise.race([this.providers[row.provider as ProviderId].dial(request,config),new Promise<CallResult>(resolve=>{timeout=setTimeout(()=>resolve({status:'unknown',message:'服务响应超时；是否已受理未知，禁止自动重拨'}),this.testMode?300:30000);timeout.unref();})]);}catch{result={status:'unknown',message:'服务异常，受理状态未知；未自动重拨'};}finally{if(timeout)clearTimeout(timeout);}
    if(result.status==='accepted'&&!result.callId)result={status:'unknown',message:'服务未返回通话标识，不能确认受理状态；不重拨'};
    const current=this.store.get('SELECT authorized FROM notifications WHERE id=?',row.id);
    const retryAuthorized=!real||current?.authorized===1;
    let status:string=result.status;let next=Date.now()+2000;if(result.status==='failed'&&result.retryable&&row.attempts<config.notification.maxRetries&&!this.paused&&!this.shutdownStarted&&retryAuthorized){status='queued';next=Date.now()+Math.max(real?config.notification.cooldownSeconds*1000:1000,1000*2**row.attempts);}
    else if(result.status==='failed'&&result.retryable&&real&&!retryAuthorized)result={...result,message:'当前通话尝试失败，重试许可已撤销；未自动重拨'};
    this.store.run('UPDATE notifications SET status=?,call_id=?,message=?,next_at=?,updated_at=? WHERE id=?',status,result.callId??null,safeMessage(result.message),next,Date.now(),row.id);
    if(this.paused&&result.callId)await bounded(this.providers[row.provider as ProviderId].cancel(result.callId,config),this.testMode?300:5000).catch(()=>undefined);
  }finally{this.busy=false;this.activeId=undefined;}}
  close(){if(this.closing)return this.closing;this.beginShutdown();this.closing=(async()=>{await this.pause(true);this.closed=true;clearInterval(this.timer);for(const provider of Object.values(this.providers)){if(provider.shutdown)await bounded(provider.shutdown(),this.testMode?300:5000).catch(()=>undefined);}const deadline=Date.now()+(this.testMode?2000:40000);while(this.busy&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));this.store.close();})();return this.closing;}
}
