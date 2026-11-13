"""CoServe thermal-sim v1 command line. Only actual kernel results are published."""
import argparse
import copy
import json
from pathlib import Path
import tempfile
import traceback

from . import __version__
from ._backend import load
from .bridge import Request, inspect_model, prepare_request, run_simulation


def portable_schema(simulation):
    schema = Request.model_json_schema()
    simulation = copy.deepcopy(simulation)
    schema.setdefault("$defs", {}).update(simulation.pop("$defs", {}))
    simulation["properties"].pop("model_id", None)
    simulation["properties"].pop("initial_from_job", None)
    simulation["required"] = [name for name in simulation.get("required", []) if name != "model_id"]
    for name in ("Heat", "Cooling", "StructuralSupport", "SurfaceEvaluation"):
        group = schema["$defs"][name]
        group["properties"]["selector"] = {"enum": ["all", "+x", "-x", "+y", "-y", "+z", "-z"]}
        group["required"] = [key for key in group.get("required", []) if key != "faces"]
    schema["properties"]["simulation"] = simulation
    return schema


def main():
    parser = argparse.ArgumentParser(prog="python -m thermal_sim")
    actions = parser.add_subparsers(dest="command", required=True)
    doctor = actions.add_parser("doctor")
    doctor.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    actions.add_parser("schema")
    inspect = actions.add_parser("inspect")
    inspect.add_argument("source")
    inspect.add_argument("--units", choices=["mm", "cm", "m"])
    inspect.add_argument("--output", required=True)
    run = actions.add_parser("run")
    run.add_argument("request")
    run.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command in ("doctor", "schema"):
        with tempfile.TemporaryDirectory(prefix="coserve-thermal-doctor-") as scratch:
            schemas, _, solver, _, backend = load(scratch, getattr(args, "device", "cpu"))
            if args.command == "doctor":
                import h5py, meshio, reportlab, skfem
                result = {"schema_version": 1, "ok": True, "version": __version__,
                          "backend": backend, "compute": solver.gpu_status("transient")}
            else:
                result = portable_schema(schemas.Simulation.model_json_schema())
    elif args.command == "inspect":
        result = inspect_model(args.source, args.output, args.units)
    else:
        source = Path(args.request).resolve()
        request = prepare_request(json.loads(source.read_text(encoding="utf-8-sig")), source.parent)
        result = run_simulation(request, args.output)
    print("THERMAL_RESULT=" + json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
