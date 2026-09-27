param([Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$taskRecordPath = Join-Path $ProjectRoot '.local/server-process.json'
if (-not (Test-Path -LiteralPath $taskRecordPath)) { return $false }
$taskRecord = Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json
if (($taskRecord.pid -isnot [int] -and $taskRecord.pid -isnot [long]) -or $taskRecord.pid -le 0 -or $taskRecord.pid -gt [int]::MaxValue) { throw 'Invalid owner record.' }
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRecord.pid)"
if (-not $taskProcess) { return $false }
# Only the old background launcher omitted launcherPid. Never take over a modern window.
if ($taskRecord.PSObject.Properties.Name -contains 'launcherPid') { throw 'Existing window must be closed first.' }
$taskMain = Join-Path $ProjectRoot 'dist/server/main.js'
if ($taskRecord.main -ne $taskMain -or $taskProcess.ExecutablePath -ne $taskRecord.executable -or $taskProcess.CreationDate.ToUniversalTime().Ticks.ToString() -ne $taskRecord.created) { throw 'Old process identity mismatch.' }
$taskArguments = [AcbConsoleHost]::ParseArguments($taskProcess.CommandLine)
if ($taskArguments.Count -ne 2 -or [IO.Path]::GetFullPath($taskArguments[0]) -ne $taskProcess.ExecutablePath -or [IO.Path]::GetFullPath($taskArguments[1]) -ne $taskMain) { throw 'Old process command mismatch.' }
$taskConnection = Get-Content -LiteralPath (Join-Path $ProjectRoot '.local/connection.json') -Raw | ConvertFrom-Json
$taskUri = [uri]$taskConnection.url
if ($taskUri.Port -lt 1024 -or $taskUri.Port -gt 65535 -or $taskConnection.url -cne "http://127.0.0.1:$($taskUri.Port)") { throw 'Unexpected old service endpoint.' }
$taskListeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $taskUri.Port -State Listen -ErrorAction Stop)
if ($taskListeners.Count -ne 1 -or $taskListeners[0].OwningProcess -ne $taskProcess.ProcessId) { throw 'Old endpoint ownership mismatch.' }
$taskHealth = Invoke-RestMethod -Uri "$($taskConnection.url)/health" -TimeoutSec 3 -MaximumRedirection 0
if ($taskHealth.service -ne 'agent-call-bridge') { throw 'Unexpected old service.' }
$taskStatus = Invoke-RestMethod -Uri "$($taskConnection.url)/api/status" -Headers @{Authorization="Bearer $($taskConnection.token)"} -TimeoutSec 3 -MaximumRedirection 0
if ($taskStatus.paused -isnot [bool] -or $taskStatus.realCallsEnabled -isnot [bool]) { throw 'Old service status is invalid.' }
Write-Host '发现已核实的旧版后台服务，正在正常关闭并切换到本窗口。'
# stop.ps1 independently checks process identity again. No force kill or lock deletion.
& (Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ProjectRoot 'scripts/stop.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Old service did not stop normally.' }
$taskRemaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskRecord.pid)"
if ($taskRemaining -and $taskRemaining.CreationDate.ToUniversalTime().Ticks.ToString() -eq $taskRecord.created) { throw 'Old service is still running.' }
# v0.1.2 shutdown persisted a pause without the newer resume marker.
return (-not $taskStatus.paused)
