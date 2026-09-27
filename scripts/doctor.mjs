import { existsSync,readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const checks=[];
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
checks.push({name:'Node runtime',ok:Number(process.versions.node.split('.')[0])>=22,detail:process.version});
const db=new DatabaseSync(':memory:');checks.push({name:'SQLite',ok:db.prepare('select 1 as ok').get().ok===1});db.close();
checks.push({name:'Compiled backend',ok:existsSync(resolve('dist/server/main.js'))});
checks.push({name:'Built UI',ok:existsSync(resolve('dist/web/index.html'))});
if(process.platform==='win32'){
  const host=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Add-Type -Path './scripts/ConsoleHost.cs'; [AcbConsoleHost].FullName"],{encoding:'utf8',windowsHide:true,timeout:15000});
  checks.push({name:'Windows console launcher (.NET Framework)',ok:host.status===0&&host.stdout.includes('AcbConsoleHost'),detail:host.status===0?'Built-in compiler available':'PowerShell/.NET compile failed; check application-control policy'});
  const ps=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -match "^zh" }).Count'],{encoding:'utf8',windowsHide:true,timeout:10000});
  checks.push({name:'Windows Chinese voice',ok:ps.status===0&&Number(ps.stdout.trim())>0,detail:ps.status===0?`${ps.stdout.trim()} voice(s)`:'Voice query failed'});
}
checks.push({name:'SIP executable (optional)',ok:existsSync(resolve('native/sip/baresip.exe'))||existsSync(resolve('.tools/release/sip/baresip.exe')),optional:true});
console.log(JSON.stringify({checks,realCallTested:false,credentialsPortable:false},null,2));
if(checks.some(c=>!c.ok&&!c.optional))process.exitCode=1;
