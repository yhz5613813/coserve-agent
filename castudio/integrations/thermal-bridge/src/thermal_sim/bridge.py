"""Validate the portable request, select real thermal faces, and verify publication."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class Geometry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1)
    units: Literal["mm", "cm", "m"] | None = None
    sha256: str | None = Field(default=None, pattern="^[a-f0-9]{64}$")
    surface_sha256: str | None = Field(default=None, pattern="^[a-f0-9]{64}$")


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[1]
    device: Literal["cpu", "cuda"] = "cpu"
    geometry: Geometry
    simulation: dict


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare_request(value, base_dir=None):
    request = Request.model_validate(value).model_dump(exclude_none=True)
    source = Path(request["geometry"]["path"])
    if not source.is_absolute():
        source = Path(base_dir or Path.cwd()) / source
    source = source.resolve(strict=True)
    if source.suffix.lower() not in (".step", ".stp", ".stl") or not source.is_file():
        raise ValueError("Geometry must be a STEP/STP/STL file")
    if not 0 < source.stat().st_size <= 100 * 1024 * 1024:
        raise ValueError("Geometry must be nonempty and at most 100 MiB")
    if source.suffix.lower() == ".stl" and "units" not in request["geometry"]:
        raise ValueError("STL requires explicit mm/cm/m units")
    actual = digest(source)
    if request["geometry"].get("sha256", actual) != actual:
        raise ValueError("Geometry SHA-256 mismatch")
    simulation = request["simulation"]
    groups = [*simulation.get("heat_sources", []), *simulation.get("cooling", []),
              *(simulation.get("structural") or {}).get("supports", [])]
    if simulation.get("surface_evaluation") is not None:
        groups.append(simulation["surface_evaluation"])
    if any(group.get("faces") and not group.get("selector") for group in groups) and "sha256" not in request["geometry"]:
        raise ValueError("Explicit thermal face IDs require a supplied source SHA-256")
    if "model_id" in simulation or simulation.get("initial_from_job") is not None:
        raise ValueError("Portable requests cannot supply model_id or initial_from_job")
    request["geometry"].update(path=str(source), sha256=actual)
    return request


def resolve_config(simulation, surface, geometry_sha256):
    cfg = copy.deepcopy(simulation)
    points = np.asarray(surface["points"], dtype=float).reshape(-1, 3)
    faces = np.asarray(surface["faces"], dtype=np.int64).reshape(-1, 3)
    if not len(faces) or not np.isfinite(points).all() or faces.min() < 0 or faces.max() >= len(points):
        raise ValueError("Invalid thermal display mesh")
    triangles = points[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1)
    if np.any(lengths <= 0):
        raise ValueError("Thermal display mesh contains degenerate triangles")
    normals /= lengths[:, None]
    groups = [*cfg.get("heat_sources", []), *cfg.get("cooling", []),
              *(cfg.get("structural") or {}).get("supports", [])]
    if cfg.get("surface_evaluation") is not None:
        groups.append(cfg["surface_evaluation"])
    for group in groups:
        if "selector" in group:
            if group.get("faces") or group.get("surface_box"):
                raise ValueError("Choose selector or explicit faces/surface_box, not both")
            selector = group.pop("selector")
            if selector == "all":
                selected = np.arange(len(faces))
            elif selector in ("+x", "-x", "+y", "-y", "+z", "-z"):
                axis = "xyz".index(selector[1])
                selected = np.flatnonzero(normals[:, axis] * (1 if selector[0] == "+" else -1) >= .9)
            else:
                raise ValueError(f"Unknown surface selector: {selector!r}")
            if not len(selected):
                raise ValueError(f"Surface selector {selector} is empty on the imported thermal mesh")
            group["faces"] = selected.tolist()
        elif group.get("faces"):
            if not geometry_sha256:
                raise ValueError("Explicit thermal face IDs require a geometry SHA-256 binding")
        for face in group.get("faces", []):
            if type(face) is not int or not 0 <= face < len(faces):
                raise ValueError("Face selection does not belong to the thermal model")
    cfg["model_id"] = "model"
    return cfg


def validate_result(output, manifest, expected_hash):
    output = Path(output)
    result = manifest["result"]
    sources = list((output / "model").glob("source.*"))
    if (manifest.get("schema_version") != 1 or manifest.get("source_sha256") != expected_hash
            or len(sources) != 1 or digest(sources[0]) != expected_hash):
        raise ValueError("Published result differs from the frozen source geometry")
    surface = json.loads((output / "model/display.json").read_text(encoding="utf-8"))
    points = np.asarray(surface["points"], dtype=float).reshape(-1, 3)
    faces = np.asarray(surface["faces"], dtype=np.int64).reshape(-1, 3)
    frames, vertices = result["frames"], result["vertices"]
    if type(frames) is not int or frames < 1 or type(vertices) is not int or vertices != len(points):
        raise ValueError("Invalid temperature field dimensions")
    field = output / "job/surface.bin"
    if field.stat().st_size != frames * vertices * 4:
        raise ValueError("Temperature field size does not match geometry and frame count")
    values = np.fromfile(field, dtype="<f4").reshape(frames, vertices)
    times = np.asarray(result["times_s"], dtype=float)
    low, high = result["minimum_C"], result["maximum_C"]
    if (len(times) != frames or not np.isfinite(times).all() or np.any(np.diff(times) <= 0)
            or times[0] < 0 or len(result["stats"]) != frames
            or not all(math.isfinite(v) for v in (low, high)) or low > high
            or not np.isfinite(values).all() or values.min() < low - 1e-4 or values.max() > high + 1e-4
            or not np.isfinite(points).all() or not len(faces) or faces.min() < 0 or faces.max() >= vertices):
        raise ValueError("Invalid geometry, time history, or temperature values")
    for index, row in enumerate(result["stats"]):
        row_low, row_high, average = (row[k] for k in ("minimum_C", "maximum_C", "average_C"))
        if (not all(math.isfinite(v) for v in (row["time_s"], row_low, row_high, average))
                or abs(row["time_s"] - times[index]) > 1e-8
                or row_low > row_high or not row_low - 1e-4 <= average <= row_high + 1e-4
                or row_low < low - 1e-4 or row_high > high + 1e-4
                or values[index].min() < row_low - 1e-4 or values[index].max() > row_high + 1e-4):
            raise ValueError("Invalid temperature history row")
    if (abs(min(row["minimum_C"] for row in result["stats"]) - low) > 1e-4
            or abs(max(row["maximum_C"] for row in result["stats"]) - high) > 1e-4):
        raise ValueError("Global temperature bounds differ from the frame history")


def run_simulation(value, output):
    return _call_worker(value, output, "run")


def inspect_model(source, output, units=None):
    geometry = {"path": str(source)}
    if units is not None:
        geometry["units"] = units
    return _call_worker({"schema_version": 1, "geometry": geometry, "simulation": {}}, output, "inspect")


def _call_worker(value, output, mode):
    request = prepare_request(value)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    request_file = output / "request.json"
    request_file.write_text(json.dumps(request, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    environment = {**os.environ, "OMP_NUM_THREADS": "6", "OPENBLAS_NUM_THREADS": "6", "MKL_NUM_THREADS": "6"}
    completed = subprocess.run([sys.executable, "-I", "-X", "utf8", "-u", "-m",
                                "thermal_sim._worker", str(request_file), str(output), mode],
                               env=environment,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if completed.returncode:
        raise RuntimeError(f"ThermoForge thermal worker failed (exit {completed.returncode})")
    manifest = json.loads((output / ("manifest.json" if mode == "run" else "inspection.json")).read_text(encoding="utf-8"))
    if mode == "run":
        validate_result(output, manifest, request["geometry"]["sha256"])
    return manifest
