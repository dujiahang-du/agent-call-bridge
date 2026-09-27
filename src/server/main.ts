import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from './app.js';
import { createTwilioCallbackApp } from '../providers/twilio-callback.js';
const dataDir=resolve(process.env.ACB_DATA_DIR??'.local');mkdirSync(dataDir,{recursive:true,mode:0o700});
if(process.platform==='win32'){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true,timeout:10000});
  const sid=result.stdout?.trim();if(result.status!==0||!/^S-1-/.test(sid??''))throw new Error('无法核对私密目录访问权限');
  const acl=spawnSync('icacls.exe',[dataDir,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'/grant:r','*S-1-5-18:(OI)(CI)F'],{windowsHide:true,timeout:10000});if(acl.status!==0)throw new Error('私密目录权限设置失败，已停止启动');
}
const app=await createApp({dataDir,onShutdown:()=>process.exit(0)});const port=Number(process.env.ACB_PORT??17860);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口必须为 1024–65535');
const callbackPort=Number(process.env.ACB_CALLBACK_PORT??17862);if(!Number.isInteger(callbackPort)||callbackPort<1024||callbackPort>65535||callbackPort===port)throw new Error('回调端口需为不同的 1024–65535 端口');const callback=await createTwilioCallbackApp({getConfig:()=>app.acb.config.read(),findCallById:id=>app.acb.findCallById(id),updateCall:(id,result)=>app.acb.updateCall(id,result),respondDecision:input=>app.acb.respondDecision(input)});app.callbackState.port=callbackPort;try{await callback.listen({host:'127.0.0.1',port:callbackPort});app.callbackState.ready=true;}catch{console.error('独立回调监听器不可用，请检查端口；管理界面仍可配置，真实双向电话暂不可用。');}app.addHook('onClose',async()=>callback.close());
await app.listen({host:'127.0.0.1',port});writeFileSync(join(dataDir,'connection.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,token:app.localToken}),{mode:0o600});
console.log(`Agent Call Bridge 已启动：http://127.0.0.1:${port}（默认 Mock；请通过启动器进入已认证界面）`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
