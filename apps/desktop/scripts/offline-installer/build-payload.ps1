# Maintainer build: stage and verify the offline runtimes for the installer.
# Output: F:\code\CADFlow\build\payload\runtime\{python,calculix,thermal}.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Must($what) { if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $what"; exit 1 } }
function Copy-Tree($from, $to) { robocopy $from $to /MIR /NFL /NDL /NJH /NJS /NP /XD '._*' /XF '._*' '.DS_Store' | Out-Null; if ($LASTEXITCODE -ge 8) { Write-Host "FAILED: copy $from"; exit 1 } }
$Src = 'F:\code\CADFlow\cadflow-test'
$Runtime = 'F:\code\CADFlow\build\payload\runtime'
New-Item -ItemType Directory -Force $Runtime | Out-Null

Copy-Tree "$Src\python" "$Runtime\python"
Copy-Tree "$Src\structural-addon\calculix" "$Runtime\calculix"
Copy-Tree "$Src\thermal-addon\thermal" "$Runtime\thermal"
$py = "$Runtime\python\python.exe"
$env:PYTHONUTF8 = '1'; $env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
# The test install linked structural_sim to a source checkout; CAStudio runs it from the app's own sources (cwd).
& $py -m pip show -q cadflow-structural-sim 2>$null
if ($LASTEXITCODE -eq 0) { & $py -m pip uninstall -y cadflow-structural-sim; Must 'uninstall editable structural_sim' }
Get-ChildItem "$Runtime\python" -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force

& $py -I -c "import cadflow as c; m=c.Model(); assert abs(m.box(2,3,4).volume-24)<1e-6; import marimo, gmsh; print('CORE_OK', c.__version__)"; Must 'core self-test'
Push-Location "$Src\castudio\resources\structural-sim"
& $py -m structural_sim doctor; Must 'structural doctor'
Pop-Location
$tpy = "$Runtime\thermal\python\python.exe"
$env:COSERVE_THERMOFORGE_ROOT = "$Runtime\thermal\engine"; $env:CUDA_PATH = "$Runtime\thermal\cuda"; $env:THERMAL_CUDA_BACKEND = 'native_cudss'
Push-Location $env:TEMP
& $tpy -I -X utf8 -m thermal_sim doctor --device cpu; Must 'thermal doctor'
Pop-Location
Get-ChildItem "$Runtime\python", "$Runtime\thermal" -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
Write-Host 'BUILD_PAYLOAD_OK'
