$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'MSVC x64 tools are required.' }
$devCommand = Join-Path $vsRoot 'Common7/Tools/VsDevCmd.bat'
$devEnvironment = & $env:ComSpec /d /c "call `"$devCommand`" -arch=x64 -host_arch=x64 >nul && set"
foreach ($entry in $devEnvironment) { if ($entry -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
$output = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $output
try {
 & cl.exe /nologo /std:c++20 /EHsc /O2 /MT /utf-8 /DWIN32_LEAN_AND_MEAN /DNOMINMAX /D_WIN32_WINNT=0x0A00 (Join-Path $PSScriptRoot 'media-bridge.cpp') /Fe:RelinkMediaBridge.exe /link windowsapp.lib crypt32.lib
 if ($LASTEXITCODE -ne 0) { throw 'Media bridge build failed.' }
} finally { Pop-Location }
