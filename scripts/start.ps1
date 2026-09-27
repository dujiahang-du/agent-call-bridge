param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot '.local'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskNode = Join-Path $taskRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = (Get-Command node -ErrorAction Stop).Source }
$taskMain = Join-Path $taskRoot 'dist/server/main.js'
if (-not (Test-Path -LiteralPath $taskMain)) { throw 'Application is not built. Run npm ci and npm run build, or use the portable release.' }
$taskPort = if ($env:ACB_PORT) { [int]$env:ACB_PORT } else { 17860 }
$taskUrl = "http://127.0.0.1:$taskPort"
$taskRunning = $false
try { $taskHealth = Invoke-RestMethod -Uri "$taskUrl/health" -TimeoutSec 2; $taskRunning = $taskHealth.service -eq 'agent-call-bridge' } catch {}
if (-not $taskRunning) {
  $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('"'+$taskMain+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'server.stdout.log') -RedirectStandardError (Join-Path $taskData 'server.stderr.log') -PassThru
  $taskIdentity=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.Id)"
  if (-not $taskIdentity) { throw 'Cannot verify the new Bridge process' }
  @{pid=$taskProcess.Id;executable=$taskIdentity.ExecutablePath;created=$taskIdentity.CreationDate.ToUniversalTime().Ticks.ToString();main=$taskMain} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData 'server-process.json') -Encoding utf8
  for ($taskAttempt=0; $taskAttempt -lt 40; $taskAttempt++) {
    if ($taskProcess.HasExited) { throw 'Bridge stopped during startup. See .local/server.stderr.log.' }
    try { $taskHealth = Invoke-RestMethod -Uri "$taskUrl/health" -TimeoutSec 1; if ($taskHealth.service -eq 'agent-call-bridge') { $taskRunning=$true; break } } catch {}
    Start-Sleep -Milliseconds 250
  }
}
if (-not $taskRunning) { throw 'Bridge did not become ready; check the port and private startup log.' }
$taskConnection = Get-Content -LiteralPath (Join-Path $taskData 'connection.json') -Raw | ConvertFrom-Json
if ($taskConnection.url -ne $taskUrl) { throw 'Connection port mismatch. No browser was opened.' }
Invoke-RestMethod -Uri "$taskUrl/api/status" -Headers @{Authorization="Bearer $($taskConnection.token)"} -TimeoutSec 3 | Out-Null
if (-not $NoBrowser) { Start-Process "$taskUrl/#token=$($taskConnection.token)" }
Write-Output 'Bridge ready. Credentials stay in the private runtime directory.'
