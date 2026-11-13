"""One owned subprocess, one isolated legacy-kernel dataset, one final publication."""
import json
from pathlib import Path
import shutil
import sys
import threading
import time
import traceback

import numpy as np

from . import __version__
from ._backend import load
from .bridge import digest, resolve_config, validate_result
from .preview import PreviewWriter, write_json


def execute(request_file, output, mode):
    output = Path(output).resolve()
    request = json.loads(Path(request_file).read_text(encoding="utf-8"))
    engine_data = output / "_engine"
    schemas, geometry, solver, host, backend = load(engine_data, request.get("device", "cpu"))
    model = engine_data / "models/model"
    job = engine_data / "jobs/job"
    model.mkdir()
    job.mkdir()
    (output / "job").mkdir()
    source = Path(request["geometry"]["path"])
    snapshot = model / ("source" + source.suffix.lower())
    shutil.copyfile(source, snapshot)
    if digest(snapshot) != request["geometry"]["sha256"]:
        raise ValueError("Geometry changed while freezing the task input")
    metadata = {"id": "model", "name": source.name, "source": snapshot.name,
                "kind": "stl" if snapshot.suffix == ".stl" else "step",
                "units": request["geometry"].get("units", "mm"), "scale_factor": 1,
                "step_scale": 1, "state": "processing", "created_at": time.time()}
    write_json(model / "metadata.json", metadata)
    current = [model / "status.json"]
    stopped = threading.Event()

    def relay():
        last = None
        while not stopped.wait(.15):
            try:
                status = json.loads(current[0].read_text(encoding="utf-8"))
                signature = (str(current[0]), status.get("phase"), status.get("progress"), status.get("detail"))
                if signature != last:
                    write_json(output / "job/status.json", status)
                    print(json.dumps({"event": "progress", **status}, ensure_ascii=False), flush=True)
                    last = signature
            except (OSError, ValueError):
                pass  # A kernel status file is not available until its first atomic write.

    monitor = threading.Thread(target=relay, daemon=True)
    monitor.start()
    try:
        geometry.prepare_model(model, include_surface_groups=True)
        metadata = json.loads((model / "metadata.json").read_text(encoding="utf-8"))
        if metadata.get("state") != "ready" or not metadata.get("mesh_ready"):
            raise ValueError(metadata.get("warning") or "Geometry is not a valid closed solid")
        points, faces, outer, topology = host.surface(model)
        surface = {"points": points.ravel().tolist(), "faces": faces.ravel().tolist(),
                   "is_outer": outer.astype(int).tolist()}
        if not topology.get("orientation_verified"):
            raise ValueError("Thermal surface orientation could not be verified")
        from .selection import surface_evidence, validate_config
        evidence = surface_evidence(model,points,faces,outer,request['geometry']['sha256'])
        expected_surface=request['geometry'].get('surface_sha256')
        if expected_surface and expected_surface!=evidence['surface_sha256']:
            raise ValueError('热表面已变化，请重新确认热源和散热选区')
        write_json(output/'selection-surface.json',evidence)
        if mode == "inspect":
            stopped.set()
            monitor.join()
            shutil.copytree(model, output / "model")
            inspection = {"schema_version": 1, "geometry": {"sha256": digest(snapshot),
                          "units": "m", "metadata": metadata}, "backend": backend,
                          "display": "model/display.json", "topology": topology,
                          "surface_sha256": evidence['surface_sha256'],"selection_surface":"selection-surface.json"}
        else:
            cfg = schemas.Simulation.model_validate(resolve_config(
                request["simulation"], surface, request["geometry"]["sha256"])).model_dump()
            validate_config(cfg,evidence,schemas,strict_positions=bool(expected_surface))
            if not cfg["heat_sources"] and not cfg["environment_only"]:
                raise ValueError("Provide heat input or explicitly select environment_only")
            if max(metadata["dimensions_m"]) / cfg["mesh_size_m"] > 130:
                raise ValueError("Mesh size must be at least the longest model dimension / 130")
            write_json(job / "config.json", cfg)
            current[0] = job / "status.json"
            preview = None
            try:
                preview = PreviewWriter(output, request["geometry"]["sha256"], model / "display.json",
                                        len(points), cfg["analysis_mode"])
            except OSError as error:
                print(json.dumps({"event": "preview_warning", "detail": str(error)}), flush=True)
            def saved_frame(t, values, stats):
                nonlocal preview
                if preview is None:
                    return
                try:
                    preview.publish(t, values, stats)
                except (OSError, ValueError) as error:
                    print(json.dumps({"event": "preview_warning", "detail": str(error)}), flush=True)
                    preview = None
            solver.solve_job(job, frame_callback=saved_frame)
            status = json.loads((job / "status.json").read_text(encoding="utf-8"))
            if status.get("phase") != "completed":
                raise ValueError("Kernel did not complete its calculation and exports")
            stopped.set()
            monitor.join()
            shutil.copytree(model, output / "model")
            for item in job.iterdir():
                if item.name != "status.json":
                    if item.is_dir():
                        shutil.copytree(item, output / "job" / item.name)
                    else:
                        shutil.copyfile(item, output / "job" / item.name)
            result = json.loads((job / "result.json").read_text(encoding="utf-8"))
            manifest = {"schema_version": 1, "source_sha256": request["geometry"]["sha256"],
                        "engine_version": f"coserve-bridge/{__version__}; ThermoForge/{backend['version']}; P1",
                        "backend": backend, "geometry": metadata, "result": result}
            for required in ("report.pdf", "report.md", "history.csv", "result.zip", "audit.json", "assessment.json"):
                if not (output / "job" / required).is_file():
                    raise ValueError(f"Kernel export is missing: {required}")
            validate_result(output, manifest, request["geometry"]["sha256"])
            write_json(output / "job/status.json", status)
        if engine_data.resolve().parent != output or engine_data.name != "_engine":
            raise ValueError("Unexpected scratch directory")
        shutil.rmtree(engine_data)
        # Publish only after all work, including cleanup, has completed.
        write_json(output / ("inspection.json" if mode == "inspect" else "manifest.json"),
                   inspection if mode == "inspect" else manifest)
    finally:
        stopped.set()
        monitor.join()


if __name__ == "__main__":
    try:
        execute(*sys.argv[1:])
    except Exception as error:
        traceback.print_exc()
        target = Path(sys.argv[2]) / "job"
        target.mkdir(exist_ok=True)
        write_json(target / "status.json", {"phase": "failed", "progress": 0, "detail": str(error)})
        raise SystemExit(1)
