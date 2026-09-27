param([Parameter(Mandatory=$true)][int]$TargetProcessId,[Parameter(Mandatory=$true)][string]$ExpectedCreated)
$ErrorActionPreference='Stop'
$taskTarget=Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId"
if(-not $taskTarget -or $taskTarget.CreationDate.ToUniversalTime().Ticks.ToString() -ne $ExpectedCreated){throw 'Owned target process identity changed.'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AcbLauncherControlTest {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint control, uint processGroup);
}
'@
# This dedicated helper detaches its own new console, never the test runner/Codex console.
[void][AcbLauncherControlTest]::FreeConsole()
if(-not [AcbLauncherControlTest]::AttachConsole([uint32]$TargetProcessId)){throw 'Cannot attach to the owned test console.'}
try{
  if(-not [AcbLauncherControlTest]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)){throw 'Cannot protect control helper.'}
  if(-not [AcbLauncherControlTest]::GenerateConsoleCtrlEvent(0,0)){throw 'Cannot send CTRL_C to the owned console.'}
  Start-Sleep -Milliseconds 200
}finally{[void][AcbLauncherControlTest]::FreeConsole()}
