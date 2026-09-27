import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes,timingSafeEqual,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { Engine,safeMessage } from '../core/engine.js';
import { listVoices,synthesize,synthesizeTelephony } from '../core/voice.js';
import { integrationStatus,installIntegration,uninstallIntegration } from '../bridge/integration.js';
import { ManagedCodex } from '../bridge/codex.js';
import { createProviders } from '../providers/index.js';
import { createSipProvider } from '../sip/index.js';
import type { CallProvider,ProviderId } from '../shared/contracts.js';
export interface AppOptions {dataDir?:string;providers?:Record<ProviderId,CallProvider>;testMode?:boolean;projectRoot?:string;}
declare module 'fastify' {interface FastifyInstance {acb:Engine;localToken:string;}}
export async function createApp(options:AppOptions={}){
  const projectRoot=resolve(options.projectRoot??process.cwd()),dataDir=resolve(options.dataDir??join(projectRoot,'.local'));mkdirSync(dataDir,{recursive:true,mode:0o700});
  const tokenPath=join(dataDir,'api-token');const token=existsSync(tokenPath)?readFileSync(tokenPath,'utf8').trim():randomBytes(32).toString('hex');if(!existsSync(tokenPath))writeFileSync(tokenPath,token,{mode:0o600});
  const app=Fastify({logger:false,bodyLimit:64*1024,requestTimeout:30000});const engine=new Engine(dataDir,options.providers??createProviders({sip:createSipProvider({dataDir,synthesize:synthesizeTelephony})}),options.testMode);app.decorate('acb',engine);app.decorate('localToken',token);
  app.addHook('onRequest',async(request,reply)=>{
    const host=request.headers.host??'localhost';if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))return reply.code(403).send({error:'仅允许本机访问'});
    if(request.headers.origin&&request.headers.origin!==`http://${host}`)return reply.code(403).send({error:'拒绝跨来源请求'});
    if(request.url.split('?')[0].includes('%'))return reply.code(400).send({error:'拒绝非规范请求路径'});
    if(request.routeOptions.url?.startsWith('/api/')){const incoming=Buffer.from((request.headers.authorization??'').replace(/^Bearer /,''));const expected=Buffer.from(token);if(incoming.length!==expected.length||!timingSafeEqual(incoming,expected))return reply.code(401).send({error:'本地访问凭据无效，请从启动器打开界面'});}
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  });
  app.setErrorHandler((error,request,reply)=>{const err=error as Error&{validation?:unknown;statusCode?:number};reply.code(err.statusCode&&err.statusCode>=400&&err.statusCode<500?err.statusCode:400).send({error:err.name==='ZodError'?'事件格式无效，请检查事件类型、摘要和选择项':safeMessage(err.message)});});
  app.get('/health',async()=>({ok:true,service:'agent-call-bridge'}));
  app.get('/api/status',async()=>engine.status());app.get('/api/config',async()=>engine.config.masked());
  app.put('/api/config',async request=>engine.updateConfig(request.body));
  app.get('/api/events',async()=>engine.events());app.get('/api/notifications',async()=>engine.notifications());app.get('/api/decisions',async()=>engine.decisions());
  app.post('/api/events',async request=>engine.accept(request.body));app.post('/api/agents/heartbeat',async request=>engine.heartbeat(request.body));
  app.get<{Params:{id:string}}>('/api/decisions/:id',async(request,reply)=>{const result=engine.decision(request.params.id);return result??reply.code(404).send({error:'决定不存在'});});
  app.post<{Params:{id:string};Body:{optionId:string}}>('/api/decisions/:id/respond',async request=>{if(typeof request.body?.optionId!=='string')throw new Error('缺少允许选项');await engine.respondDecision({decisionId:request.params.id,optionId:request.body.optionId});return engine.decision(request.params.id);});
  app.post<{Body:{paused:boolean}}>('/api/pause',async request=>{if(typeof request.body?.paused!=='boolean')throw new Error('暂停状态无效');return engine.pause(request.body.paused);});
  app.post('/api/test',async()=>engine.accept({eventId:randomUUID(),taskId:'mock-test',source:'mock-ui',type:'task_completed',summary:'这是一条演示汇报。模拟任务已完成，没有拨打真实电话。',evidence:{kind:'agent_report',description:'由界面触发的 Mock 演示，不是真实 Agent 验收'}},true));
  app.post<{Body:{provider:ProviderId;remote?:boolean}}>('/api/providers/check',async request=>{const provider=engine.providers[request.body?.provider];if(!provider)throw new Error('电话服务不存在');if(request.body.remote)throw new Error('本入口只进行不计费的本地配置检查');return provider.check(engine.config.read(),{remote:false});});
  app.get('/api/voices',async()=>listVoices());
  app.post<{Body:{text?:string;voice?:string;rate?:number}}>('/api/voice/preview',async(request,reply)=>{const cfg=engine.config.read();const audio=await synthesize(request.body?.text??'你好，这是 Agent Call Bridge 的中文语音测试。',request.body?.voice??cfg.voice.name,request.body?.rate??cfg.voice.rate);return reply.type('audio/wav').send(audio);});
  app.post<{Params:{id:string}}>('/api/notifications/:id/preview',async(request,reply)=>{const row=engine.store.get('SELECT request FROM notifications WHERE id=?',request.params.id);if(!row)return reply.code(404).send({error:'通知不存在'});const call=JSON.parse(row.request);const cfg=engine.config.read();const audio=await synthesize(`这是本地模拟通话，没有拨打真实电话。${call.text}`,cfg.voice.name,cfg.voice.rate);return reply.type('audio/wav').send(audio);});
  app.get('/api/integration',async()=>integrationStatus(projectRoot));app.post('/api/integration/install',async()=>installIntegration(projectRoot,dataDir));app.post('/api/integration/uninstall',async()=>uninstallIntegration(projectRoot));
  app.post('/api/integration/codex-check',async()=>{const codex=new ManagedCodex(dataDir,()=>{});try{const result=await codex.connect();engine.store.setMeta('codexHandshakeAt',new Date().toISOString());return {...result,capability:'仅验证独立进程协议握手；未调用模型，不代表已实现托管任务界面'};}finally{codex.close();}});
  app.post<{Params:{id:string};Body:{confirmation:string}}>('/api/notifications/:id/authorize',async request=>engine.authorize(request.params.id,request.body?.confirmation));
  app.post<{Body:{confirmation:string}}>('/api/real-calls/enable',async request=>engine.enableReal(request.body?.confirmation));app.post('/api/real-calls/disable',async()=>engine.disableReal());
  app.addHook('onClose',async()=>engine.close());
  const web=join(projectRoot,'dist','web');if(existsSync(join(web,'index.html'))){await app.register(fastifyStatic,{root:web,prefix:'/',wildcard:false});app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));}else app.get('/',async()=>({message:'界面尚未构建。请运行 npm run build 后重新启动。'}));
  return app;
}
