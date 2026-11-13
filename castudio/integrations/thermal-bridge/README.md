# ThermoForge bridge for CAStudio

English | [中文](README.zh.md)

This package implements CAStudio's `thermal_sim` CLI v1 and the thermal editor's inspection, selection and validation commands. It runs the pinned ThermoForge P1 solid-heat solver in an owned subprocess. CPU is the portable default; CUDA/cuDSS is explicit and never silently falls back to CPU. Geometry, meshing and matrix assembly remain on CPU.

## Install on Windows

Prerequisites: Git, Python 3.12, Node.js and an NVIDIA driver for CUDA use. The tested environment uses Python 3.12.14, CUDA 12.9 and cuDSS 0.8.0.10. `requirements-windows-tested.txt` records that environment, including test/report dependencies; it is not a cross-platform lock file. NVIDIA runtime libraries are obtained from their Python distributions, not redistributed in this repository.

From this directory, choose an engine checkout and virtual environment outside the source tree:

```powershell
$bridgeRoot = (Get-Location).Path
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'CoServeThermal'
$engineRoot = Join-Path $runtimeRoot 'ThermoForgeStudio'
$venvRoot = Join-Path $runtimeRoot 'venv'
$metadata = Get-Content .\engine.json -Raw | ConvertFrom-Json
git clone $metadata.repository $engineRoot
git -C $engineRoot checkout --detach $metadata.commit
git -C $engineRoot apply --ignore-space-change --check "$bridgeRoot\engine-compat.patch"
if ($LASTEXITCODE -ne 0) { throw 'Engine patch does not apply' }
git -C $engineRoot apply --ignore-space-change "$bridgeRoot\engine-compat.patch"
py -3.12 -m venv $venvRoot
$python = Join-Path $venvRoot 'Scripts\python.exe'
& $python -m pip install -r .\requirements-windows-tested.txt
& $python -m pip install .
& $python .\verify_engine.py $engineRoot
if ($LASTEXITCODE -ne 0) { throw 'Engine verification failed' }
$env:COSERVE_THERMOFORGE_ROOT = $engineRoot
$env:STUDIO_THERMAL_PYTHON = $python
& $python -I -X utf8 -m thermal_sim doctor --device cpu
```

The engine identity and normalized-LF hashes are in [engine.json](engine.json). The consolidated [patch](engine-compat.patch) supplies saved-frame callbacks, physical surface selection and quadrature, editor evidence, reports, and bounded Windows atomic-status retries. `verify_engine.py` checks the commit and patched files before writing `.coserve-source.json`. No engine tree, account, project history or model credentials are bundled.

Set `COSERVE_THERMOFORGE_ROOT` in the environment of the process that starts CAStudio; it is forwarded to the owned solver subprocess. An absent path or source marker produces an explicit error. Configure the absolute Python executable in CAStudio, or set `STUDIO_THERMAL_PYTHON` before starting it. Model credentials remain managed by DSH independently.

## Enable CUDA

The NVIDIA driver is installed separately. For the tested Windows runtime, copy the CUDA runtime/NVRTC DLLs supplied by the locked Python packages into an application-local directory:

```powershell
$cudaRoot = Join-Path $runtimeRoot 'cuda-12.9'
$cudaBin = Join-Path $cudaRoot 'bin'
New-Item -ItemType Directory -Force $cudaBin | Out-Null
$packages = Join-Path $venvRoot 'Lib\site-packages\nvidia'
Copy-Item -LiteralPath "$packages\cuda_runtime\bin\cudart64_12.dll" -Destination $cudaBin
Copy-Item -LiteralPath "$packages\cuda_nvrtc\bin\nvrtc64_120_0.dll" -Destination $cudaBin
Copy-Item -LiteralPath "$packages\cuda_nvrtc\bin\nvrtc-builtins64_129.dll" -Destination $cudaBin
$env:CUDA_PATH = $cudaRoot
$env:PATH = "$cudaBin;$env:PATH"
$env:THERMAL_CUDA_BACKEND = 'native_cudss'
& $python -I -X utf8 -m thermal_sim doctor --device cuda
```

Use `device: "cuda"` in the CAStudio data directory's `thermal-runtime.json`, alongside `executable`, then restart CAStudio with these environment variables. A CUDA doctor success requires compiling and executing a real kernel. Final results record the requested and actual device. This is solid conduction with prescribed cooling boundaries; it does not solve airflow or certify manufacturability.

## CLI and result integrity

`python -I -X utf8 -m thermal_sim schema|inspect|run` exposes the existing solver protocol; `python -I -X utf8 -m thermal_sim.editor schema|resolve|validate` exposes editing. `run_simulation(request, output)` is the Python entry point. Output directories must be new. STEP uses embedded units; STL requires explicit mm/cm/m. Positions and mesh sizes in requests are SI. Triangle selections bind to the imported source/surface hashes and must be recomputed after geometry changes.

The worker snapshots the geometry, validates finite full-solid temperature arrays, vertex order, times and exports, and publishes the manifest last. Saved preview frames are unfinished results with their own source/display hashes; they are not evidence of a successful completed solve. Cancellation must terminate both the bridge and its worker.

## Tests

The pure request and Windows-write tests do not require an engine:

```powershell
& $python -m pytest tests/test_contract.py tests/test_windows_status.py -q
```

The remaining tests require the pinned patched engine and numerical/report dependencies. GPU acceptance is opt-in:

```powershell
$env:COSERVE_THERMOFORGE_ROOT = $engineRoot
$env:COSERVE_TEST_GPU = '1'
& $python -m pytest tests -q
```

CAStudio numerical tests use `STUDIO_TEST_GMSH_PYTHON`; GPU workflow tests use `STUDIO_THERMAL_TEST_PYTHON` and `STUDIO_THERMAL_TEST_GPU=1`. They allocate isolated temporary projects. Missing opt-in variables are reported as skipped tests, not GPU passes. Recorded DSH model tests replay allowlisted responses without making model API calls.
