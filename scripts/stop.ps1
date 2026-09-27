$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRecordPath=Join-Path $taskRoot '.local/server-process.json'
if (-not (Test-Path -LiteralPath $taskRecordPath)) { Write-Output 'No managed process record; no process was stopped.'; exit 0 }
$taskRecord=Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json
$taskPid=[int]$taskRecord.pid
$taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
if (-not $taskProcess) { Write-Output 'Bridge is already stopped.'; exit 0 }
if ($taskProcess.ExecutablePath -ne $taskRecord.executable -or $taskProcess.CreationDate.ToUniversalTime().Ticks.ToString() -ne $taskRecord.created -or $taskRecord.main -ne (Join-Path $taskRoot 'dist/server/main.js')) { throw 'Process identity mismatch; no process was stopped.' }
$taskConnection=Get-Content -LiteralPath (Join-Path $taskRoot '.local/connection.json') -Raw | ConvertFrom-Json
$taskEndpoint=[uri]$taskConnection.url
if ($taskEndpoint.Scheme -ne 'http' -or $taskEndpoint.Host -ne '127.0.0.1') { throw 'Unexpected local endpoint; no request sent.' }
$taskResult=Invoke-RestMethod -Method Post -Uri "$($taskConnection.url)/api/shutdown" -Headers @{Authorization="Bearer $($taskConnection.token)"} -ContentType 'application/json' -Body '{"confirmation":"\u5173\u95ed\u672c\u673a\u670d\u52a1\u5e76\u505c\u6b62\u540e\u7eed\u901a\u77e5"}' -TimeoutSec 45 -MaximumRedirection 0
for($taskAttempt=0;$taskAttempt -lt 90;$taskAttempt++) {
  $taskRemaining=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
  if(-not $taskRemaining -or $taskRemaining.CreationDate.ToUniversalTime().Ticks.ToString() -ne $taskRecord.created) { Write-Output 'Bridge stopped gracefully.'; exit 0 }
  Start-Sleep -Milliseconds 500
}
throw 'Graceful shutdown did not finish. No forced termination was performed; inspect the private log.'
