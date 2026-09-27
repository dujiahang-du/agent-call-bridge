import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEventInput } from '../shared/contracts.js';
export class BridgeClient {
  readonly connection:{url:string;token:string};
  constructor(connectionPath=resolve('.local','connection.json')){this.connection=JSON.parse(readFileSync(connectionPath,'utf8'));const url=new URL(this.connection.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.protocol!=='http:')throw new Error('Bridge 只允许连接本机服务');}
  async request(path:string,body?:unknown){const response=await fetch(this.connection.url+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${this.connection.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json() as any;if(!response.ok)throw new Error(data.error??'Bridge 请求失败');return data;}
  async report(event:Partial<AgentEventInput>){return this.request('/api/events',{...event,eventId:event.eventId??randomUUID(),source:process.env.CODEX_THREAD_ID?'codex-desktop':'bridge-cli',threadId:process.env.CODEX_THREAD_ID??event.threadId,sessionId:process.env.CODEX_SESSION_ID??event.sessionId});}
  async heartbeat(taskId:string,active=true){return this.request('/api/agents/heartbeat',{taskId,active,source:process.env.CODEX_THREAD_ID?'codex-desktop':'bridge-cli',threadId:process.env.CODEX_THREAD_ID,sessionId:process.env.CODEX_SESSION_ID});}
  async wait(id:string,timeoutSeconds=300,expectedTaskId?:string){const read=async()=>{const result=await this.request(`/api/decisions/${encodeURIComponent(id)}`);if(expectedTaskId&&result.taskId!==expectedTaskId)throw new Error('决定不属于原任务');if(process.env.CODEX_THREAD_ID&&result.threadId!==process.env.CODEX_THREAD_ID)throw new Error('决定不属于当前 Codex 任务');if(process.env.CODEX_SESSION_ID&&result.sessionId!==process.env.CODEX_SESSION_ID)throw new Error('决定不属于当前 Codex 会话');return result;};const end=Date.now()+Math.min(3600,Math.max(1,timeoutSeconds))*1000;while(Date.now()<end){const result=await read();if(result.status!=='pending')return result;await new Promise(r=>setTimeout(r,500));}return {...await read(),waitTimedOut:true,message:'等待结束；未回答不代表同意，已结束任务不会自动唤醒'};}
}
