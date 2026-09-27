param([switch]$NoBrowser, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
$taskHost = $null
$taskLock = $null
$taskExit = 0
$taskFailure = $null
function Fail-Launch([string]$Message) { $script:taskFailure = $Message; throw 'Launcher failed.' }
try {
  $taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $taskData = Join-Path $taskRoot '.local'
  New-Item -ItemType Directory -Path $taskData -Force | Out-Null
  # Protect logs and the owner record before the server has started.
  $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $taskData /inheritance:r /grant:r "*$($taskSid):(OI)(CI)F" /grant:r '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail-Launch '无法保护私密数据目录，已停止启动。' }
  try { $taskLock = [IO.File]::Open((Join-Path $taskData 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { Fail-Launch '此项目已有启动窗口，请使用原窗口；关闭本窗口不会停止原服务。' }
  $taskNode = Join-Path $taskRoot 'runtime/node.exe'
  if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
  $taskMain = Join-Path $taskRoot 'dist/server/main.js'
  if (-not (Test-Path -LiteralPath $taskMain)) { Fail-Launch '程序尚未构建。请下载完整发行包，或先运行 npm ci 和 npm run build。' }
  $taskPort = if ($env:ACB_PORT) { [int]$env:ACB_PORT } else { 17860 }
  if ($taskPort -lt 1024 -or $taskPort -gt 65535) { Fail-Launch '端口无效，请使用 1024–65535。' }
  $taskUrl = "http://127.0.0.1:$taskPort"
  Write-Host 'Agent Call Bridge' -ForegroundColor Cyan
  Write-Host '正在启动，请保留这个黑窗口。'
  Write-Host '关闭窗口或按 Ctrl+C 即停止本机服务；下次双击即可重新启动。'
  Add-Type -Path (Join-Path $PSScriptRoot 'ConsoleHost.cs')
  try { $taskResumeMigrated = & (Join-Path $PSScriptRoot 'legacy-service.ps1') -ProjectRoot $taskRoot }
  catch { Fail-Launch '无法安全迁移旧服务。请用原目录的 Stop.cmd 正常停止；未结束其他进程或删除实例锁。' }
  $taskHost = [AcbConsoleHost]::new($taskNode, (Join-Path $PSScriptRoot 'managed-server.mjs'), $taskRoot, $taskData)
  $taskIdentity = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskHost.Pid)"
  if (-not $taskIdentity) { Fail-Launch '无法核对本次服务进程，已停止启动。' }
  $taskRunning = $false
  for ($taskAttempt=0; $taskAttempt -lt 60; $taskAttempt++) {
    if ($taskHost.HasExited) { Fail-Launch '启动未完成。请检查是否有旧版服务、端口占用，以及 .local/server.stderr.log。' }
    # Require a connection file written by this worker, not another process on this port.
    $taskConnectionPath = Join-Path $taskData 'connection.json'
    if ((Test-Path -LiteralPath $taskConnectionPath) -and (Get-Item -LiteralPath $taskConnectionPath).LastWriteTimeUtc -ge $taskIdentity.CreationDate.ToUniversalTime()) {
      try {
        $taskConnection = Get-Content -LiteralPath $taskConnectionPath -Raw | ConvertFrom-Json
        if ($taskConnection.url -eq $taskUrl) {
          $taskStatus = Invoke-RestMethod -Uri "$taskUrl/api/status" -Headers @{Authorization="Bearer $($taskConnection.token)"} -TimeoutSec 1
          $taskRunning = $true
          break
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $taskRunning) { Fail-Launch '服务启动超时，请检查端口与 .local/server.stderr.log。' }
  # A failed replacement must not overwrite the stop record of a running older version.
  @{pid=$taskHost.Pid;executable=$taskIdentity.ExecutablePath;created=$taskIdentity.CreationDate.ToUniversalTime().Ticks.ToString();main=$taskMain;launcherPid=$PID;consoleWindow=$taskHost.ConsoleWindow} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData 'server-process.json') -Encoding utf8
  if ($taskResumeMigrated) {
    if ($taskStatus.realCallsEnabled) { Fail-Launch '新服务状态异常，已停止启动。' }
    $null = Invoke-RestMethod -Method Post -Uri "$taskUrl/api/pause" -Headers @{Authorization="Bearer $($taskConnection.token)"} -ContentType 'application/json' -Body '{"paused":false}' -TimeoutSec 3 -MaximumRedirection 0
  }
  if (-not $NoBrowser) { Start-Process "$taskUrl/#token=$($taskConnection.token)" }
  Write-Host "已启动：$taskUrl" -ForegroundColor Green
  Write-Host '真实电话仍需在工作台明确授权。关闭网页不会停止服务，关闭本窗口才会停止。'
  $taskHost.Wait()
  if ($taskHost.ExitCode -ne 0 -and -not $taskHost.StopRequested) { Fail-Launch '服务意外退出，请检查 .local/server.stderr.log。' }
} catch {
  $taskExit = 1
  # Show only our fixed messages; never print runtime exception arguments.
  $taskMessage = if ($taskFailure) { $taskFailure } else { '启动失败，请检查完整安装包、端口及 Windows PowerShell/.NET 可用性。' }
  if ($null -ne $taskHost -and $taskHost.StopRequested) { $taskExit = 0 }
  else { Write-Host $taskMessage -ForegroundColor Red }
} finally {
  if ($null -ne $taskHost) { $taskHost.Dispose() }
  if ($null -ne $taskLock) { $taskLock.Dispose() }
}
if ($taskExit -ne 0 -and $Interactive) { Read-Host '按回车关闭窗口' | Out-Null }
exit $taskExit
