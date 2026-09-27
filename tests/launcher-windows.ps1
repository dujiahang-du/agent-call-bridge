param([string]$NodePath='',[string]$ProjectRoot='')
$ErrorActionPreference='Stop'
if($env:OS -ne 'Windows_NT'){throw 'This test requires Windows; native console/Job coverage cannot be simulated.'}
$taskRepository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRoot=if($ProjectRoot){[IO.Path]::GetFullPath($ProjectRoot)}else{$taskRepository}
$taskRun=Join-Path $taskRepository ('.local/launcher-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskRun | Out-Null
$taskEvidence=[ordered]@{startedAt=(Get-Date).ToString('o');projectRoot=$taskRoot;runDirectory=$taskRun;checks=@();cases=@();realCalls=0;ok=$false}
$taskOwned=New-Object System.Collections.ArrayList
$taskWindows=New-Object System.Collections.ArrayList
$taskWindowsPS=Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskEnvironment=@{ACB_PORT=$env:ACB_PORT;ACB_CALLBACK_PORT=$env:ACB_CALLBACK_PORT;ACB_DATA_DIR=$env:ACB_DATA_DIR}
if(-not ('AcbLauncherTestWindows' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AcbLauncherTestWindows {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@}
function Assert-Launcher([bool]$Condition,[string]$Name){if(-not $Condition){throw "FAILED: $Name"};$script:taskEvidence.checks += $Name}
function Wait-Launcher([scriptblock]$Condition,[string]$Name,[int]$Milliseconds=20000){
  $taskUntil=[DateTime]::UtcNow.AddMilliseconds($Milliseconds)
  do{if(& $Condition){return};Start-Sleep -Milliseconds 70}while([DateTime]::UtcNow -lt $taskUntil)
  throw "Timed out: $Name"
}
function Register-Owned([int]$ProcessId,[int]$ExpectedParent=0){
  $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
  if(-not $taskProcess){throw 'Owned process disappeared before identity was recorded.'}
  if($ExpectedParent -and $taskProcess.ParentProcessId -ne $ExpectedParent){throw 'Child process ownership mismatch.'}
  $taskIdentity=@{pid=$ProcessId;created=$taskProcess.CreationDate.ToUniversalTime().Ticks.ToString();executable=$taskProcess.ExecutablePath}
  [void]$script:taskOwned.Add($taskIdentity)
  return $taskIdentity
}
function Test-OwnedAlive($Identity){
  if(-not $Identity){return $false}
  $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.pid)"
  return [bool]($taskProcess -and $taskProcess.CreationDate.ToUniversalTime().Ticks.ToString() -eq $Identity.created -and $taskProcess.ExecutablePath -eq $Identity.executable)
}
function New-LauncherPort(){
  $taskListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $taskListener.Start();$taskPort=$taskListener.LocalEndpoint.Port;$taskListener.Stop();return $taskPort
}
function Test-LauncherPort([int]$Port){
  $taskClient=New-Object Net.Sockets.TcpClient
  try{$taskConnect=$taskClient.ConnectAsync('127.0.0.1',$Port);return ($taskConnect.Wait(250) -and $taskClient.Connected)}catch{return $false}finally{$taskClient.Dispose()}
}
function New-LauncherCase([string]$Name,[switch]$Stubborn){
  $taskCaseRoot=Join-Path $taskRun $Name
  New-Item -ItemType Directory -Path (Join-Path $taskCaseRoot 'scripts'),(Join-Path $taskCaseRoot 'runtime') | Out-Null
  foreach($taskFile in @('start.ps1','stop.ps1','ConsoleHost.cs','managed-server.mjs')){Copy-Item -LiteralPath (Join-Path $taskRoot "scripts/$taskFile") -Destination (Join-Path $taskCaseRoot 'scripts')}
  foreach($taskFile in @('package.json','Start.cmd','Stop.cmd')){Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskCaseRoot}
  Copy-Item -LiteralPath (Join-Path $taskRoot 'dist') -Destination $taskCaseRoot -Recurse
  New-Item -ItemType Junction -Path (Join-Path $taskCaseRoot 'node_modules') -Target (Join-Path $taskRoot 'node_modules') | Out-Null
  Copy-Item -LiteralPath $NodePath -Destination (Join-Path $taskCaseRoot 'runtime/node.exe')
  if($Stubborn){Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/launcher-stubborn.mjs') -Destination (Join-Path $taskCaseRoot 'scripts/managed-server.mjs') -Force}
  $taskCase=@{root=$taskCaseRoot;port=(New-LauncherPort);callbackPort=(New-LauncherPort)}
  $script:taskEvidence.cases += @{name=$Name;root=$taskCaseRoot;port=$taskCase.port;stubborn=[bool]$Stubborn}
  return $taskCase
}
function Open-Launcher($Case,[string]$Label,[switch]$Entry){
  $env:ACB_PORT=[string]$Case.port;$env:ACB_CALLBACK_PORT=[string]$Case.callbackPort
  Remove-Item Env:ACB_DATA_DIR -ErrorAction SilentlyContinue
  $taskProbe=Join-Path $taskRun ($Label+'-window.json')
  $taskFixture=Join-Path $PSScriptRoot 'fixtures/launcher-console.ps1'
  if($Entry){
    # Explicit entry-point coverage needs a visible, separate window, just like double-clicking Start.cmd.
    $taskEntryFixture=Join-Path $PSScriptRoot 'fixtures/launcher-entry.cmd'
    $taskArguments='/d /c ""'+$taskEntryFixture+'" "'+$Case.root+'" "'+$taskProbe+'""'
    $taskProcess=Start-Process -FilePath $env:ComSpec -ArgumentList $taskArguments -WindowStyle Normal -PassThru
  }else{
    $taskArguments='-NoProfile -ExecutionPolicy Bypass -File "'+$taskFixture+'" -ProjectRoot "'+$Case.root+'" -ProbePath "'+$taskProbe+'"'
    $taskProcess=Start-Process -FilePath $taskWindowsPS -ArgumentList $taskArguments -WindowStyle Hidden -PassThru
  }
  $taskIdentity=Register-Owned $taskProcess.Id
  Wait-Launcher {Test-Path -LiteralPath $taskProbe} 'owned console window probe'
  $taskWindow=Get-Content -LiteralPath $taskProbe -Raw | ConvertFrom-Json
  Assert-Launcher (($Entry -or $taskWindow.pid -eq $taskProcess.Id) -and $taskWindow.window -ne 0) 'Console HWND belongs to the new test launcher'
  if($Entry){Assert-Launcher ([AcbLauncherTestWindows]::IsWindowVisible([IntPtr]$taskWindow.window)) 'Real Start.cmd entry owns a visible console window'}
  $taskHandle=@{window=[long]$taskWindow.window;owner=$taskIdentity;label=$Label}
  [void]$script:taskWindows.Add($taskHandle)
  return @{identity=$taskIdentity;window=$taskHandle;case=$Case;entry=[bool]$Entry}
}
function Close-Launcher($Launcher){
  Assert-Launcher (Test-OwnedAlive $Launcher.identity) 'Window close targets a still-owned launcher instance'
  Assert-Launcher ([AcbLauncherTestWindows]::IsWindow([IntPtr]$Launcher.window.window)) 'Owned console HWND is valid before WM_CLOSE'
  Assert-Launcher ([AcbLauncherTestWindows]::PostMessage([IntPtr]$Launcher.window.window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)) 'WM_CLOSE successfully posted to owned console'
}
function Connect-Launcher($Launcher){
  $taskData=Join-Path $Launcher.case.root '.local'
  Wait-Launcher {
    try{
      $taskRecord=Get-Content -LiteralPath (Join-Path $taskData 'server-process.json') -Raw | ConvertFrom-Json
      if($Launcher.entry){
        $taskEntryHost=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRecord.launcherPid)"
        if(-not $taskEntryHost -or $taskEntryHost.ParentProcessId -ne $Launcher.identity.pid){return $false}
      }elseif($taskRecord.launcherPid -ne $Launcher.identity.pid){return $false}
      $taskConnection=Get-Content -LiteralPath (Join-Path $taskData 'connection.json') -Raw | ConvertFrom-Json
      $null=Invoke-RestMethod -Uri "$($taskConnection.url)/api/status" -Headers @{Authorization="Bearer $($taskConnection.token)"} -TimeoutSec 1
      return $true
    }catch{return $false}
  } 'authenticated server readiness'
  $taskRecord=Get-Content -LiteralPath (Join-Path $taskData 'server-process.json') -Raw | ConvertFrom-Json
  Assert-Launcher ($taskRecord.consoleWindow -eq $Launcher.window.window) 'Application records the correct owning console HWND'
  $taskHostPid=$Launcher.identity.pid
  if($Launcher.entry){$Launcher.host=Register-Owned $taskRecord.launcherPid $Launcher.identity.pid;$taskHostPid=$Launcher.host.pid}
  $Launcher.worker=Register-Owned $taskRecord.pid $taskHostPid
  $Launcher.connection=Get-Content -LiteralPath (Join-Path $taskData 'connection.json') -Raw | ConvertFrom-Json
}
function Request-Launcher($Launcher,[string]$Path,[string]$Method='Get',$Body=$null){
  $taskRequest=@{Uri=$Launcher.connection.url+$Path;Method=$Method;Headers=@{Authorization="Bearer $($Launcher.connection.token)"};TimeoutSec=5}
  if($null -ne $Body){$taskRequest.ContentType='application/json';$taskRequest.Body=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 15))}
  return Invoke-RestMethod @taskRequest
}
function Check-Mock($Launcher){
  $taskStatus=Request-Launcher $Launcher '/api/status'
  Assert-Launcher ($taskStatus.mode -eq 'mock' -and -not $taskStatus.realCallsEnabled) 'Real call authorization remains false'
  Assert-Launcher (-not $taskStatus.paused) 'Normal startup or reopen is ready without manually resuming notifications'
  $taskTest=Request-Launcher $Launcher '/api/test' 'Post' @{}
  Wait-Launcher {@(Request-Launcher $Launcher '/api/notifications' | Where-Object {$_.id -eq $taskTest.notification.id -and $_.status -eq 'completed' -and $_.provider -eq 'mock'}).Count -eq 1} 'Mock notification completion' 8000
  Assert-Launcher $true 'Mock notification completed through the launched backend'
}
function Wait-LauncherStopped($Launcher){
  Wait-Launcher {-not (Test-OwnedAlive $Launcher.identity)} 'launcher exit' 12000
  if($Launcher.host){Wait-Launcher {-not (Test-OwnedAlive $Launcher.host)} 'entry PowerShell host exit' 12000}
  if($Launcher.worker){Wait-Launcher {-not (Test-OwnedAlive $Launcher.worker)} 'owned Node exit' 12000}
  Wait-Launcher {-not (Test-LauncherPort $Launcher.case.port)} 'service port closed' 5000
  Assert-Launcher $true 'Launcher, owned Node and listening port are stopped'
}
try{
  if(-not $NodePath){foreach($taskCandidate in @('runtime/node.exe','.tools/node-runtime/node-v22.23.3-win-x64/node.exe')){if(Test-Path -LiteralPath (Join-Path $taskRoot $taskCandidate)){$NodePath=Join-Path $taskRoot $taskCandidate;break}}}
  if(-not $NodePath){$NodePath=(Get-Command node -ErrorAction Stop).Source}
  $NodePath=[IO.Path]::GetFullPath($NodePath)
  Assert-Launcher (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/server/main.js')) 'Compiled application is available'
  $taskCase=New-LauncherCase '主程序 保存 重开'
  $taskFirst=Open-Launcher $taskCase 'first' -Entry;Connect-Launcher $taskFirst;Check-Mock $taskFirst
  $taskConfig=Request-Launcher $taskFirst '/api/config';$taskConfig.voice.rate=1
  $null=Request-Launcher $taskFirst '/api/config' 'Put' $taskConfig
  $taskSecond=Open-Launcher $taskCase 'duplicate' -Entry
  Start-Sleep -Milliseconds 1200
  $taskUnchanged=Get-Content -LiteralPath (Join-Path $taskCase.root '.local/server-process.json') -Raw | ConvertFrom-Json
  Assert-Launcher ($taskUnchanged.pid -eq $taskFirst.worker.pid -and $taskSecond.window.window -ne $taskFirst.window.window) 'Duplicate window does not replace the original owner'
  Close-Launcher $taskSecond
  Wait-Launcher {-not (Test-OwnedAlive $taskSecond.identity)} 'duplicate window exit' 10000
  Assert-Launcher ((Test-OwnedAlive $taskFirst.worker) -and (Test-LauncherPort $taskCase.port)) 'Closing the duplicate leaves the original server running'
  Close-Launcher $taskFirst;Wait-LauncherStopped $taskFirst
  $taskReopened=Open-Launcher $taskCase 'reopened';Connect-Launcher $taskReopened
  Assert-Launcher ((Request-Launcher $taskReopened '/api/config').voice.rate -eq 1) 'Configuration survives console X and reopen'
  Check-Mock $taskReopened
  & (Join-Path $taskCase.root 'Stop.cmd')
  Assert-Launcher ($LASTEXITCODE -eq 0) 'Stop.cmd reports a graceful shutdown'
  Wait-LauncherStopped $taskReopened
  $taskCtrlC=Open-Launcher $taskCase 'ctrl-c' -Entry;Connect-Launcher $taskCtrlC
  $taskControlFixture=Join-Path $PSScriptRoot 'fixtures/launcher-control.ps1'
  $taskControlArguments='-NoProfile -ExecutionPolicy Bypass -File "'+$taskControlFixture+'" -TargetProcessId '+$taskCtrlC.identity.pid+' -ExpectedCreated '+$taskCtrlC.identity.created
  $taskSignalHelper=Start-Process -FilePath $taskWindowsPS -ArgumentList $taskControlArguments -WindowStyle Hidden -PassThru
  $taskSignalIdentity=Register-Owned $taskSignalHelper.Id
  Wait-Launcher {-not (Test-OwnedAlive $taskSignalIdentity)} 'CTRL_C helper exit' 10000
  $taskSignalHelper.Refresh()
  Assert-Launcher ($taskSignalHelper.ExitCode -eq 0) 'Dedicated helper sends CTRL_C only to the owned console'
  Wait-Launcher {-not (Test-OwnedAlive $taskCtrlC.worker) -and -not (Test-LauncherPort $taskCase.port)} 'CTRL_C shuts down Node and port' 12000
  Assert-Launcher $true 'Actual Start.cmd CTRL_C stops the service before any follow-up window close'
  if(Test-OwnedAlive $taskCtrlC.identity){Close-Launcher $taskCtrlC}
  Wait-LauncherStopped $taskCtrlC
  $taskEarlyCase=New-LauncherCase '提前 关闭'
  $taskEarly=Open-Launcher $taskEarlyCase 'early'
  Assert-Launcher (-not (Test-LauncherPort $taskEarlyCase.port)) 'Early X happens before application readiness'
  Close-Launcher $taskEarly;Wait-LauncherStopped $taskEarly
  Start-Sleep -Milliseconds 1200
  Assert-Launcher (-not (Test-LauncherPort $taskEarlyCase.port)) 'Early-close startup cannot open a delayed listening port'
  $taskConflictCase=New-LauncherCase '端口 冲突'
  $taskSentinelPath=Join-Path $taskConflictCase.root '.local/server-process.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $taskSentinelPath) | Out-Null
  $taskSentinel=@{sentinel=[guid]::NewGuid().ToString();pid=-1;created='sentinel'} | ConvertTo-Json
  Set-Content -LiteralPath $taskSentinelPath -Value $taskSentinel -Encoding utf8
  $taskSentinelHash=(Get-FileHash -LiteralPath $taskSentinelPath).Hash
  $taskOccupied=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$taskConflictCase.port)
  $taskOccupied.Start()
  try{
    $taskConflict=Open-Launcher $taskConflictCase 'port-conflict'
    Wait-Launcher {
      $taskErrorFile=Join-Path $taskConflictCase.root '.local/server.stderr.log'
      if(-not (Test-Path -LiteralPath $taskErrorFile)){return $false}
      return ((Get-Content -LiteralPath $taskErrorFile -Raw) -match 'EADDRINUSE')
    } 'worker reports the deliberately occupied port'
    Wait-Launcher {@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($taskConflict.identity.pid)" | Where-Object {$_.ExecutablePath -like '*\node.exe'}).Count -eq 0} 'failed worker exit'
    Assert-Launcher ((Get-FileHash -LiteralPath $taskSentinelPath).Hash -eq $taskSentinelHash) 'Port-conflict startup preserves the existing owner-record sentinel'
    Assert-Launcher ((Test-OwnedAlive $taskConflict.identity) -and (Test-LauncherPort $taskConflictCase.port)) 'Error window remains usable and test-owned occupied port is unaffected'
    Close-Launcher $taskConflict
    Wait-Launcher {-not (Test-OwnedAlive $taskConflict.identity)} 'port-conflict error window exit' 10000
    Assert-Launcher $true 'Port-conflict startup leaves no child Node worker'
  }finally{$taskOccupied.Stop()}
  $taskControl=Start-Process -FilePath $NodePath -ArgumentList @('"'+(Join-Path $PSScriptRoot 'fixtures/launcher-stubborn.mjs')+'"','child') -WindowStyle Hidden -PassThru
  $taskControlIdentity=Register-Owned $taskControl.Id
  $taskStubbornCase=New-LauncherCase '强制 兜底' -Stubborn
  $taskStubborn=Open-Launcher $taskStubbornCase 'stubborn';Connect-Launcher $taskStubborn
  $taskStubbornStatePath=Join-Path $taskStubbornCase.root '.local/stubborn-state.json'
  $taskState=Get-Content -LiteralPath $taskStubbornStatePath -Raw | ConvertFrom-Json
  Assert-Launcher ($taskState.workerPid -eq $taskStubborn.worker.pid) 'Stubborn worker identity matches its launcher'
  $taskGrandchild=Register-Owned $taskState.childPid $taskStubborn.worker.pid
  $taskStartedClosing=[DateTime]::UtcNow
  Close-Launcher $taskStubborn;Wait-LauncherStopped $taskStubborn
  Wait-Launcher {-not (Test-OwnedAlive $taskGrandchild)} 'Job-owned stubborn grandchild exit' 5000
  $taskState=Get-Content -LiteralPath $taskStubbornStatePath -Raw | ConvertFrom-Json
  Assert-Launcher ($taskState.stopReceived -ge 1) 'Noncooperative worker received ACB_STOP and deliberately stayed alive'
  Assert-Launcher (([DateTime]::UtcNow-$taskStartedClosing).TotalMilliseconds -ge 2500) 'Forced Job cleanup occurred after the graceful stop interval'
  Assert-Launcher (Test-OwnedAlive $taskControlIdentity) 'External control process is unaffected by owned Job cleanup'
  $taskEvidence.ok=$true
}catch{
  $taskEvidence.error=$_.Exception.Message
  $taskEvidence.stack=$_.ScriptStackTrace
}finally{
  # Never kill by image name or traverse the node_modules junction. Keep fixtures and logs for diagnosis.
  foreach($taskWindow in $taskWindows){if((Test-OwnedAlive $taskWindow.owner) -and [AcbLauncherTestWindows]::IsWindow([IntPtr]$taskWindow.window)){[void][AcbLauncherTestWindows]::PostMessage([IntPtr]$taskWindow.window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)}}
  Start-Sleep -Milliseconds 500
  for($taskIndex=$taskOwned.Count-1;$taskIndex -ge 0;$taskIndex--){$taskIdentity=$taskOwned[$taskIndex];if(Test-OwnedAlive $taskIdentity){Stop-Process -Id $taskIdentity.pid -ErrorAction Continue}}
  $taskEvidence.cleanupSurvivors=@($taskOwned | Where-Object {Test-OwnedAlive $_} | ForEach-Object {$_.pid})
  if($taskEvidence.cleanupSurvivors.Count){$taskEvidence.ok=$false}
  foreach($taskKey in $taskEnvironment.Keys){[Environment]::SetEnvironmentVariable($taskKey,$taskEnvironment[$taskKey],'Process')}
  $taskEvidence.finishedAt=(Get-Date).ToString('o')
  $taskEvidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskRun 'evidence.json') -Encoding utf8
  $taskEvidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $taskRepository '.local/launcher-evidence.json') -Encoding utf8
}
[pscustomobject]@{ok=$taskEvidence.ok;checks=$taskEvidence.checks.Count;evidence=(Join-Path $taskRun 'evidence.json');error=$taskEvidence.error} | ConvertTo-Json -Compress
if(-not $taskEvidence.ok){exit 1}
