[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $projectRoot '.tools\sip-src'
$releaseRoot = Join-Path $projectRoot '.tools\release\sip'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere)) { throw '需要已安装的 Visual Studio 2022 C++ 工具链；本脚本不会安装系统组件。' }
$vs = & $vswhere -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (!$vs) { throw '未找到 Visual Studio 2022 C++ 工具链。' }
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (!(Test-Path -LiteralPath $cmake)) { throw '未找到 Visual Studio CMake。' }
New-Item -ItemType Directory -Force -Path $sourceRoot,$releaseRoot | Out-Null
$sources = @(
    @{ Name='re'; Commit='ceefe9ff499aa1bcfb6255aff1737434dd385322' },
    @{ Name='baresip'; Commit='3d30821f099925d24167f8a99e93ba4d1be98599' }
)
foreach ($source in $sources) {
    $path = Join-Path $sourceRoot $source.Name
    if (!(Test-Path -LiteralPath $path)) {
        & git clone --depth 1 --branch v4.11.0 "https://github.com/baresip/$($source.Name).git" $path
        if ($LASTEXITCODE) { throw "下载 $($source.Name) 失败。" }
    }
    $actual = & git -C $path rev-parse HEAD
    if ($actual -ne $source.Commit) { throw "$($source.Name) 源码版本不符，保留现场，不自动覆盖。" }
    if (& git -C $path status --porcelain --untracked-files=no) { throw "$($source.Name) 源码有本机修改，停止构建。" }
}
$re = Join-Path $sourceRoot 're'
$baresip = Join-Path $sourceRoot 'baresip'
$common = @('-G','Visual Studio 17 2022','-A','x64','-DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON','-DUSE_OPENSSL=OFF','-DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON','-DUSE_MBEDTLS=OFF','-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
& $cmake -S $re -B "$re/build" @common '-DLIBRE_BUILD_SHARED=OFF'
if ($LASTEXITCODE) { throw 'libre 配置失败。' }
& $cmake --build "$re/build" --config Release --parallel 4 --target re
if ($LASTEXITCODE) { throw 'libre 编译失败。' }
$modules = 'account;aufile;ausine;g711;menu;ctrl_tcp;debug_cmd;auconv;auresamp;rtcpsummary'
& $cmake -S $baresip -B "$baresip/build" @common '-DSTATIC=ON' "-DMODULES=$modules" "-DRE_LIBRARY=$re/build/Release/re-static.lib" "-DRE_INCLUDE_DIR=$re/include" "-Dre_DIR=$re/cmake" "-DCMAKE_PROJECT_INCLUDE=$PSScriptRoot/build-sip-overlay.cmake"
if ($LASTEXITCODE) { throw 'baresip 配置失败。' }
& $cmake --build "$baresip/build" --config Release --parallel 4 --target baresip_exe
if ($LASTEXITCODE) { throw 'baresip 编译失败。' }
Copy-Item -LiteralPath "$baresip/build/Release/baresip.exe" -Destination "$releaseRoot/baresip.exe"
Copy-Item -LiteralPath "$baresip/LICENSE" -Destination "$releaseRoot/LICENSE.baresip.txt"
Copy-Item -LiteralPath "$re/LICENSE" -Destination "$releaseRoot/LICENSE.libre.txt"
$manifest = [ordered]@{ baresip=$sources[1].Commit; libre=$sources[0].Commit; modules=$modules; platform='win-x64'; entrypoint='acb-cwd-only-v1'; tls=$false; runtime='static MSVC'; sha256=(Get-FileHash -LiteralPath "$releaseRoot/baresip.exe" -Algorithm SHA256).Hash.ToLowerInvariant() }
[IO.File]::WriteAllText("$releaseRoot/build-manifest.json", ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "SIP 实验性二进制已生成：$releaseRoot（UDP/TCP，无 TLS/SRTP）。"
