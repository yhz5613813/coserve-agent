"""Load only the pinned, local kernel, after assigning an isolated task data root."""
import importlib
import json
import os
from pathlib import Path
import sys

COMMIT = "08f0a654e8625199be14c45f2cb0b443b0774cb0"


def load(data_root, device="cpu"):
    if device not in ("cpu", "cuda"):
        raise ValueError("Thermal device must be cpu or cuda")
    configured = os.environ.get("COSERVE_THERMOFORGE_ROOT")
    if not configured:
        raise ValueError("Set COSERVE_THERMOFORGE_ROOT to the pinned, patched ThermoForge checkout")
    root = Path(configured).resolve()
    source_stamp = json.loads((root / ".coserve-source.json").read_text(encoding="utf-8-sig"))
    if source_stamp["Commit"] != COMMIT:
        raise ValueError("ThermoForge source does not match the validated bridge version")
    os.environ["THERMAL_DATA"] = str(Path(data_root).resolve())
    os.environ["THERMAL_DEVICE"] = device
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ[name] = "6"
    sys.path.insert(0, str(root))
    schemas = importlib.import_module("thermal_legacy.schemas")
    geometry = importlib.import_module("thermal_legacy.geometry")
    original_init = geometry.init_gmsh
    def init_gmsh():
        original_init()
        # Keep inspection triangle IDs stable across independent tasks while
        # allowing the volume mesher the configured six-thread CPU budget.
        geometry.gmsh.option.setNumber("General.NumThreads", 6)
        geometry.gmsh.option.setNumber("Mesh.MaxNumThreads1D", 1)
        geometry.gmsh.option.setNumber("Mesh.MaxNumThreads2D", 1)
        geometry.gmsh.option.setNumber("Mesh.MaxNumThreads3D", 6)
    geometry.init_gmsh = init_gmsh
    solver = importlib.import_module("thermal_legacy.solver")
    compute = solver.gpu_status("transient")
    host = importlib.import_module("thermal_legacy.host_geometry")
    version = importlib.import_module("forge.version").VERSION
    return schemas, geometry, solver, host, {"name": "ThermoForge Studio thermal_legacy",
            "version": version, "commit": COMMIT, "discretization": "P1 tetrahedral heat FEM",
            "device": compute["device"], "compute": compute, "cpu_threads": 6, "surface_mesh_threads": 1}
