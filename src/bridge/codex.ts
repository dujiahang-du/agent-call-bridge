import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEventInput } from '../shared/contracts.js';
export function mapCodexEvent(message:any,owned:Map<string,string>):AgentEventInput|null{
  const p=message.params??{};const taskId=owned.get(p.threadId);if(!taskId)return null;
  const base={eventId:randomUUID(),taskId,source:'codex-managed',threadId:p.threadId};
  if(message.method==='turn/completed'){if(p.turn?.status==='failed')return {...base,type:'task_failed',summary:'受管 Codex 任务轮次失败，请回到界面查看原因'};if(p.turn?.status==='completed')return {...base,type:'turn_finished',summary:'Codex 本轮已结束；不等于整个任务通过验收'};}
  if(message.method==='error'&&!p.willRetry)return {...base,type:'task_failed',summary:'受管 Codex 报告不可继续的错误'};
  return null;
}
/** Owns only the child it starts. No Desktop private databases or existing thread takeover. */
export class ManagedCodex {
  private child?:ChildProcessWithoutNullStreams;private sequence=0;private pending=new Map<number,{resolve:(x:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  readonly owned=new Map<string,string>();readonly questions=new Map<string|number,any>();private buffer='';
  constructor(readonly dataDir:string,private onEvent:(event:AgentEventInput)=>void,private onQuestion:(question:any)=>void=()=>{}){}
  async connect(){if(this.child)return {connected:true};const home=join(this.dataDir,'codex-home');mkdirSync(home,{recursive:true,mode:0o700});let command='codex',args=['app-server','--stdio'];
    if(process.platform==='win32'){const script=join(process.env.APPDATA??'','npm','node_modules','@openai','codex','bin','codex.js');if(!existsSync(script))throw new Error('未发现兼容 Codex CLI；请安装后重试，不会代改系统配置');command=process.execPath;args=[script,...args];}
    this.child=spawn(command,args,{env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});this.child.stdout.on('data',data=>this.receive(data.toString()));this.child.stderr.resume();this.child.on('error',()=>this.fail(new Error('Codex 启动失败')));this.child.on('close',()=>{this.child=undefined;this.fail(new Error('Codex 连接已关闭'));});
    try{const result=await this.rpc('initialize',{clientInfo:{name:'agent_call_bridge',title:'Agent Call Bridge',version:'0.1.0'}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');return {connected:true,version:result.userAgent??null,isolatedHome:true,modelCalled:false};}catch(error){this.close();throw error;}
  }
  private fail(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  private receive(data:string){this.buffer+=data;if(this.buffer.length>4*1024*1024){this.close();return;}let index;while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line.trim())continue;let message:any;try{message=JSON.parse(line);}catch{this.close();return;}
      if(message.id!==undefined&&!message.method){const pending=this.pending.get(message.id);if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(new Error('Codex 请求未成功')):pending.resolve(message.result);}continue;}
      if(message.method==='serverRequest/resolved'){this.questions.delete(message.params?.requestId);continue;}
      if(message.method==='turn/completed'){for(const [id,q] of this.questions)if(q.threadId===message.params?.threadId&&q.turnId===message.params?.turn?.id)this.questions.delete(id);}
      if(message.method==='item/tool/requestUserInput'&&this.owned.has(message.params?.threadId)){this.questions.set(message.id,{...message.params,expiresAt:Date.now()+Math.min(message.params.autoResolutionMs??300000,300000)});this.onQuestion({requestId:message.id,...message.params});continue;}
      // Permissions remain with the human. Never translate a phone reply into approval.
      if(message.method?.endsWith('/requestApproval')&&this.owned.has(message.params?.threadId)){this.onQuestion({requestId:message.id,...message.params,requiresLocalApproval:true});continue;}
      const mapped=mapCodexEvent(message,this.owned);if(mapped)this.onEvent(mapped);
    }}
  rpc(method:string,params:unknown){if(!this.child)throw new Error('Codex 未连接');const id=++this.sequence;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex 请求超时'));},15000);this.pending.set(id,{resolve,reject,timer});this.child!.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  async start(taskId:string,cwd:string,prompt:string,modelExecutionExplicitlyAuthorized=false){if(!modelExecutionExplicitlyAuthorized)throw new Error('尚未授权真实模型执行；握手与 Mock 仍可测试');const r=await this.rpc('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'on-request'});this.owned.set(r.thread.id,taskId);await this.rpc('turn/start',{threadId:r.thread.id,input:[{type:'text',text:prompt}]});return r.thread.id;}
  async stop(threadId:string,turnId:string){if(!this.owned.has(threadId))throw new Error('只能停止本产品创建的任务');return this.rpc('turn/interrupt',{threadId,turnId});}
  answer(requestId:string|number,answers:Record<string,{answers:string[]}>){const question=this.questions.get(requestId);if(!question||!this.child||question.expiresAt<=Date.now()||!this.owned.has(question.threadId))throw new Error('原决定已失效');if(!answers||Object.keys(answers).length!==question.questions.length||!question.questions.every((q:any)=>Object.hasOwn(answers,q.id)))throw new Error('必须回答全部原问题');for(const [id,value] of Object.entries(answers)){const q=question.questions.find((x:any)=>x.id===id);if(!q||!Array.isArray(value?.answers)||value.answers.length!==1||value.answers.some(x=>!q.options?.some((o:any)=>o.label===x)))throw new Error('仅能返回原问题的一个允许选项');}this.child.stdin.write(JSON.stringify({id:requestId,result:{answers}})+'\n');this.questions.delete(requestId);}
  close(){this.child?.kill();this.child=undefined;this.questions.clear();this.fail(new Error('Codex 连接已关闭'));}
}
