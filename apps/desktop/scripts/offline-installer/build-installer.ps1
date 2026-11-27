# Maintainer build: compile the single-file offline installer after build-app.ps1 and build-payload.ps1.
# Needs Inno Setup 7 at F:\code\CADFlow\tools\inno and the files of apps/desktop/installer/offline copied to F:\code\CADFlow\build\installer.
# Output: F:\code\CADFlow\build\dist\CoServe-AI-<version>-win-x64-offline-unsigned.exe and its .sha256.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Must($what) { if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $what"; exit 1 } }
$Build = 'F:\code\CADFlow\build'
$Payload = "$Build\payload"
$unpacked = "$Build\src\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked"
foreach ($f in 'CoServe AI.exe', 'coserve-portable', 'resources\castudio') { if (-not (Test-Path (Join-Path $unpacked $f))) { Write-Host "FAILED: win-unpacked lacks $f"; exit 1 } }
foreach ($f in 'runtime\python\python.exe', 'runtime\calculix\ccx.exe', 'runtime\thermal\python\python.exe') { if (-not (Test-Path (Join-Path $Payload $f))) { Write-Host "FAILED: payload lacks $f"; exit 1 } }
robocopy $unpacked "$Payload\app" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { Write-Host 'FAILED: stage app'; exit 1 }
# The payload Python was staged once; refresh castudio_runtime from this app build so editor fixes ship.
robocopy "$Payload\app\resources\castudio\resources\castudio-runtime\castudio_runtime" "$Payload\runtime\python\Lib\site-packages\castudio_runtime" /MIR /NFL /NDL /NJH /NJS /NP /XD '__pycache__' | Out-Null; if ($LASTEXITCODE -ge 8) { Write-Host 'FAILED: refresh castudio_runtime'; exit 1 }
Copy-Item "$Build\tools\vc_redist.x64.exe" "$Payload\vc_redist.x64.exe" -Force
$version = (Get-Content "$Build\src\apps\desktop\package.json" -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force "$Build\dist" | Out-Null
& 'F:\code\CADFlow\tools\inno\ISCC.exe' /Q "/DAppVersion=$version" "/DPayload=$Payload" "/O$Build\dist" "$Build\installer\coserve-ai.iss"; Must 'ISCC'
$setup = Get-Item "$Build\dist\CoServe-AI-$version-win-x64-offline-unsigned.exe"
'{0}  {1}' -f (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLower(), $setup.Name | Set-Content "$($setup.FullName).sha256" -Encoding ASCII
'{0} {1:N0} MB' -f $setup.Name, ($setup.Length / 1MB)
Write-Host "BUILD_INSTALLER_OK $version"
