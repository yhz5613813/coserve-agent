# Maintainer build (needs network): build the portable CoServe AI Windows app directory from a source archive.
# Input: F:\code\CADFlow\build\coserve-src.tgz (git ls-files -co snapshot of coserve-agent). Output: win-unpacked under F:\code\CADFlow\build\src\apps\desktop.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Must($what) { if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $what"; exit 1 } }
Set-Location F:\code\CADFlow\build
# Pinned Node, Python and Electron archives live outside src so a fresh unpack keeps them; the build host may not reach nodejs.org or GitHub.
$env:DSH_DESKTOP_PACKAGE_CACHE_DIR = 'F:\code\CADFlow\build\cache'
$oldDownloads = 'F:\code\CADFlow\build\src\apps\desktop\.desktop-build\downloads'
if ((Test-Path $oldDownloads) -and -not (Test-Path "$env:DSH_DESKTOP_PACKAGE_CACHE_DIR\downloads")) {
  New-Item -ItemType Directory -Force $env:DSH_DESKTOP_PACKAGE_CACHE_DIR | Out-Null
  Move-Item $oldDownloads "$env:DSH_DESKTOP_PACKAGE_CACHE_DIR\downloads"
}
if (Test-Path F:\code\CADFlow\build\src) { cmd /c rmdir /s /q F:\code\CADFlow\build\src }
New-Item -ItemType Directory -Force F:\code\CADFlow\build\src | Out-Null
tar.exe -xzf F:\code\CADFlow\build\coserve-src.tgz -C F:\code\CADFlow\build\src; Must 'unpack'
$env:npm_config_registry = 'https://registry.npmmirror.com'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:CI = '1'
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm install -g pnpm@11.28.5; Must 'install pnpm' }
$env:PATH = "$env:APPDATA\npm;$env:PATH"
Set-Location F:\code\CADFlow\build\src
pnpm install --frozen-lockfile; Must 'pnpm install'
# The desktop build stamps the commit id; a source archive has no .git, so record it as a local snapshot commit.
if (-not (Test-Path .git)) {
  git init -q; Must 'git init'
  git add -A 2>$null; Must 'git add'
  git -c user.name=build -c user.email=build@localhost commit -q -m 'build snapshot'; Must 'git commit'
}
$env:DSH_DESKTOP_PORTABLE = '1'
pnpm --dir apps/desktop run package:win:x64:unsigned --dir; Must 'package'
Write-Host 'BUILD_APP_OK'
