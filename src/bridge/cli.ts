import { readFileSync } from 'node:fs';
import { BridgeClient } from './client.js';
const args=process.argv.slice(2);const command=args.shift();const values:Record<string,string>={};for(let i=0;i<args.length;i++){if(args[i]==='--stdin'){values.stdin='true';continue;}if(!args[i].startsWith('--')||!args[i+1])throw new Error('参数格式错误');values[args[i].slice(2)]=args[++i];}
try{
  const client=new BridgeClient(values.connection);
  if(command==='ping'){const result=await client.request('/api/status');console.log(JSON.stringify({ok:true,mode:result.mode,desktopWakeFinishedTask:false}));}
  else if(command==='heartbeat'){if(!values['task-id'])throw new Error('心跳需要 task-id');console.log(JSON.stringify(await client.heartbeat(values['task-id'],values.active!=='false')));}
  else if(command==='report'||command==='report-and-wait'){
    const input=values.stdin?JSON.parse(readFileSync(0,'utf8')):{eventId:values['event-id'],taskId:values['task-id'],type:values.type,summary:values.summary,...(values['decision-json']?{decision:JSON.parse(values['decision-json'])}:{}),...(values.evidence?{evidence:{kind:'agent_report',description:values.evidence}}:{})};
    const result=await client.report(input);console.log(JSON.stringify({eventId:result.event.eventId,notificationId:result.notification?.id,decisionId:result.decision?.id,duplicate:result.duplicate}));
    if(command==='report-and-wait'){if(!result.decision)throw new Error('等待命令需要 decision_required 及允许选项');const answer=await client.wait(result.decision.id,Number(values.timeout??300),input.taskId);console.log(JSON.stringify(answer));if(answer.status!=='answered')process.exitCode=2;}
  }else throw new Error('用法：bridge ping | report | report-and-wait，支持 --connection、--stdin、--type、--task-id、--summary、--decision-json、--timeout');
}catch(e){console.error(JSON.stringify({error:(e as Error).message}));process.exitCode=1;}
