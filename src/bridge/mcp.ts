import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeClient } from './client.js';
const server=new McpServer({name:'agent-call-bridge',version:'0.1.0'},{instructions:'仅向本人汇报任务。turn_finished不是任务验收。report_and_wait只返回预先列出的低风险选项，不能替代系统审批或唤醒已结束任务。默认Mock；凭据保存不授权真实电话。'});
function client(){return new BridgeClient(process.env.ACB_CONNECTION);}
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const shape={taskId:z.string(),type:z.enum(['task_completed','task_failed','task_stalled','retry_exhausted','decision_required','turn_finished']),summary:z.string().max(800),eventId:z.string().optional(),evidence:z.object({kind:z.enum(['agent_report','verified']),description:z.string()}).optional(),decision:z.object({question:z.string(),options:z.array(z.object({id:z.string(),label:z.string()})).min(2).max(9),expiresInSeconds:z.number().optional()}).optional()};
server.tool('ping','检查本机 Bridge；不拨打电话',{},async()=>result(await client().request('/api/status')));
server.tool('heartbeat','显式注册活跃任务并更新心跳；仅该任务适用无进展提醒',{taskId:z.string(),active:z.boolean().optional()},async({taskId,active})=>result(await client().heartbeat(taskId,active)));
server.tool('report_event','汇报任务事件；只在明确完成/失败/需决定时使用',shape,async input=>result(await client().report(input)));
server.tool('report_and_wait','发出明确选择请求并等待；回复不会授权任意命令',{...shape,timeoutSeconds:z.number().min(1).max(330).optional()},async({timeoutSeconds,...input})=>{const c=client();const report=await c.report(input);if(!report.decision)throw new Error('需要 decision_required 和选项');return result(await c.wait(report.decision.id,timeoutSeconds??300,input.taskId));});
server.tool('get_decision','读取未过期请求的结果',{decisionId:z.string()},async({decisionId})=>result(await client().request(`/api/decisions/${encodeURIComponent(decisionId)}`)));
await server.connect(new StdioServerTransport());
