# CAStudio 的 ThermoForge 桥接程序

[English](README.md) | 中文

本包实现 CAStudio 的 `thermal_sim` CLI v1，以及热编辑器的检查、选区和验证命令。它在受管理的子进程中运行固定版本的 ThermoForge P1 固体热求解器。CPU 是可移植的默认设备；CUDA/cuDSS 必须明确启用，失败时不会静默回退 CPU。几何处理、网格生成和矩阵组装仍在 CPU 上执行。

## 在 Windows 上安装

前置条件：Git、Python 3.12、Node.js；使用 CUDA 时还需要 NVIDIA 驱动。已测试环境使用 Python 3.12.14、CUDA 12.9 和 cuDSS 0.8.0.10。`requirements-windows-tested.txt` 记录该环境及测试、报告依赖，并非跨平台锁文件。NVIDIA 运行库通过对应的 Python 发行包获取，本仓库不重新分发这些库。

在当前目录执行以下命令，将引擎和虚拟环境安装到源码树之外：

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

引擎身份和归一化为 LF 后的文件摘要记录在 [engine.json](engine.json) 中。合并后的[补丁](engine-compat.patch) 提供已保存帧回调、物理表面选区及积分、编辑器证据、报告和 Windows 原子状态写入的有限重试。`verify_engine.py` 校验提交和补丁文件后才写入 `.coserve-source.json`。不包含引擎目录、账户、项目历史或模型凭据。

在启动 CAStudio 的进程环境中设置 `COSERVE_THERMOFORGE_ROOT`，该值会传递给受管理的求解子进程。缺少路径或源码标记时会明确报错。在 CAStudio 中设置 Python 可执行文件的绝对路径，或在启动前设置 `STUDIO_THERMAL_PYTHON`。模型凭据由 DSH 独立管理。

## 启用 CUDA

NVIDIA 驱动需要单独安装。对于已测试的 Windows 运行环境，将锁定版本 Python 包提供的 CUDA runtime/NVRTC DLL 复制到应用本地目录：

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

在 CAStudio 数据目录的 `thermal-runtime.json` 中设置 `device: "cuda"` 和 `executable`，随后携带这些环境变量重启 CAStudio。CUDA doctor 成功必须实际编译并运行一个内核。最终结果记录请求和实际使用的设备。本功能求解具有指定冷却边界的固体导热，不求解空气流场，也不提供制造认证。

## CLI 与结果完整性

`python -I -X utf8 -m thermal_sim schema|inspect|run` 提供现有求解器协议；`python -I -X utf8 -m thermal_sim.editor schema|resolve|validate` 提供编辑功能。Python 入口为 `run_simulation(request, output)`。输出目录必须是新目录。STEP 使用文件内置单位；STL 必须明确指定 mm/cm/m。请求中的位置和网格尺寸使用 SI 单位。三角面选区绑定导入源文件和表面摘要，几何变化后必须重新计算。

工作进程保存几何快照，检查完整实体温度数组中的有限数值、顶点顺序、时间和导出文件，最后发布清单。已保存的预览帧属于未完成结果，具有独立的源文件和显示摘要，不能证明求解成功完成。取消操作必须结束桥接程序和其工作进程。

## 测试

纯请求测试和 Windows 写入测试无需引擎：

```powershell
& $python -m pytest tests/test_contract.py tests/test_windows_status.py -q
```

其他测试需要固定版本且应用补丁后的引擎，以及数值计算和报告依赖。GPU 验收需要明确启用：

```powershell
$env:COSERVE_THERMOFORGE_ROOT = $engineRoot
$env:COSERVE_TEST_GPU = '1'
& $python -m pytest tests -q
```

CAStudio 数值测试使用 `STUDIO_TEST_GMSH_PYTHON`；GPU 流程测试使用 `STUDIO_THERMAL_TEST_PYTHON` 和 `STUDIO_THERMAL_TEST_GPU=1`。测试创建隔离的临时项目。缺少启用变量时报告跳过，不记作 GPU 通过。DSH 录制测试重放经过筛选的响应，不调用模型 API。
