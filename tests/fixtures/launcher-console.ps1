param([string]$ProjectRoot,[Parameter(Mandatory=$true)][string]$ProbePath,[switch]$ProbeOnly)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AcbLauncherTestProbe {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
@{pid=$PID;window=[AcbLauncherTestProbe]::GetConsoleWindow().ToInt64()} | ConvertTo-Json | Set-Content -LiteralPath $ProbePath -Encoding utf8
if($ProbeOnly){exit 0}
& (Join-Path $ProjectRoot 'scripts/start.ps1') -NoBrowser -Interactive
exit $LASTEXITCODE
