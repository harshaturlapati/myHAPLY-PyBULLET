# Build every example on Windows with the Visual Studio C++ compiler (MSVC) + Ninja.
# Usage (from the repo folder):   powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1 [-Config Release|Debug] [-Target name]
# Executables land in build\  (e.g. build\100-Haply-basics_01_read_fbk.exe)
param(
    [string]$Config = "Release",
    [string]$Target = ""
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# 1. Find Visual Studio (any edition, including Build Tools and Preview/Insiders) with the C++ workload
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "Visual Studio not found. Install 'Desktop development with C++' (Visual Studio or Build Tools)." }
$vs = & $vswhere -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "No Visual Studio with the C++ compiler found. Add the 'Desktop development with C++' workload." }
Write-Host "Using Visual Studio at $vs"

# 2. Load the x64 compiler environment (cl.exe, and the CMake + Ninja that ship with Visual Studio)
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { throw "cmake not found: install CMake or the 'C++ CMake tools for Windows' component." }
$gen = if (Get-Command ninja -ErrorAction SilentlyContinue) { 'Ninja' } else { 'NMake Makefiles' }

# 3. Configure and build
$build = Join-Path $repo 'build'
cmake -S $repo -B $build -G $gen "-DCMAKE_BUILD_TYPE=$Config"
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }
if ($Target) { cmake --build $build --parallel --target $Target } else { cmake --build $build --parallel }
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
Write-Host "`nBuilt. Executables are in $build"
