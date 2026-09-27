param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $taskRoot
try {
  if (-not $SkipBuild) { npm run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed' } }
  $taskVersion=(Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
  $taskName="agent-call-bridge-$taskVersion-win-x64"
  $taskRelease=Join-Path $taskRoot 'release'
  $taskBuildDir=Join-Path $taskRelease ('build-'+[guid]::NewGuid().ToString('N'))
  $taskStage=Join-Path $taskBuildDir $taskName
  New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
  $taskDownloads=Join-Path $taskRoot '.tools/downloads'
  New-Item -ItemType Directory -Path $taskDownloads -Force | Out-Null
  $taskNodeZip=Join-Path $taskDownloads 'node-v22.23.3-win-x64.zip'
  if (-not (Test-Path -LiteralPath $taskNodeZip)) { Invoke-WebRequest -Uri 'https://nodejs.org/download/release/v22.23.3/node-v22.23.3-win-x64.zip' -OutFile $taskNodeZip }
  if ((Get-FileHash -LiteralPath $taskNodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71') { throw 'Official Node archive checksum mismatch' }
  $taskNodeExtract=Join-Path $taskBuildDir 'verified-node'
  Expand-Archive -LiteralPath $taskNodeZip -DestinationPath $taskNodeExtract
  $taskNodeSource=Join-Path $taskNodeExtract 'node-v22.23.3-win-x64'
  New-Item -ItemType Directory -Path (Join-Path $taskStage 'runtime') | Out-Null
  foreach($taskFile in @('node.exe','LICENSE')) { Copy-Item -LiteralPath (Join-Path $taskNodeSource $taskFile) -Destination (Join-Path $taskStage 'runtime') }
  foreach($taskFile in @('package.json','package-lock.json','README.md','findings.md','LICENSE','SECURITY.md','THIRD_PARTY_NOTICES.md','Start.cmd','Stop.cmd','Bridge.cmd')) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskFile) -Destination $taskStage }
  foreach($taskDir in @('dist','docs')) { Copy-Item -LiteralPath (Join-Path $taskRoot $taskDir) -Destination $taskStage -Recurse }
  New-Item -ItemType Directory -Path (Join-Path $taskStage 'scripts') | Out-Null
  foreach($taskScript in @('start.ps1','stop.ps1','doctor.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $taskScript) -Destination (Join-Path $taskStage 'scripts') }
  if (Test-Path -LiteralPath (Join-Path $taskRoot '.tools/release/sip/baresip.exe')) {
    New-Item -ItemType Directory -Path (Join-Path $taskStage 'native') | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot '.tools/release/sip') -Destination (Join-Path $taskStage 'native/sip') -Recurse
  }
  npm ci --prefix $taskStage --omit=dev --ignore-scripts --cache (Join-Path $taskRoot '.cache/npm') --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Portable dependencies failed' }
  if (Test-Path -LiteralPath (Join-Path $taskStage '.local')) { throw 'Private data present in release' }
  $taskZip=Join-Path $taskRelease "$taskName.zip"
  if (Test-Path -LiteralPath $taskZip) { $taskZip=Join-Path $taskBuildDir "$taskName.zip" }
  & tar.exe -a -cf $taskZip -C $taskBuildDir $taskName
  if($LASTEXITCODE -ne 0) { throw 'Portable archive creation failed' }
  $taskHash=(Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$taskZip.sha256" -Value "$taskHash  $taskName.zip" -Encoding ascii
  $taskManifest=@{stage=$taskStage;zip=$taskZip;sha256=$taskHash;node='22.23.3';createdAt=(Get-Date).ToString('o')}
  $taskManifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskRoot '.local/release-manifest.json') -Encoding utf8
  Write-Output "Portable package built: $taskZip"
} finally { Pop-Location }
