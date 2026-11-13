import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import gmsh
import numpy as np
import pytest


def invoke(*args, cwd=None):
    return subprocess.run([sys.executable, "-I", "-X", "utf8", "-m", "thermal_sim", *map(str, args)],
                          cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=180)


def body(completed):
    assert completed.returncode == 0, completed.stdout + completed.stderr
    return json.loads(next(line[15:] for line in completed.stdout.splitlines()
                           if line.startswith("THERMAL_RESULT=")))


def test_doctor_and_schema_from_an_unrelated_directory(tmp_path):
    doctor = body(invoke("doctor", cwd=tmp_path))
    assert doctor["ok"] is True and doctor["schema_version"] == 1
    assert doctor["backend"]["commit"] == "08f0a654e8625199be14c45f2cb0b443b0774cb0"
    schema = body(invoke("schema", cwd=tmp_path))
    assert "simulation" in schema["properties"]
    assert list(tmp_path.iterdir()) == []


@pytest.fixture
def plate(tmp_path):
    source = tmp_path / "plate.step"
    gmsh.initialize(interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("plate")
        gmsh.model.occ.addBox(0, 0, 0, 80, 50, 8)
        gmsh.model.occ.synchronize()
        gmsh.write(str(source))
    finally:
        gmsh.finalize()
    return source


def example(source, mode="transient"):
    return {"schema_version": 1, "device": "cpu",
            "geometry": {"path": str(source), "units": "mm",
                         "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
            "simulation": {"name": "Software verification only", "analysis_mode": mode,
                           "base_material": {"name": "illustrative aluminum", "k": 205,
                                             "rho": 2700, "cp": 900},
                           "initial_C": 25, "ambient_C": 25, "default_h": 10,
                           "duration_s": 6, "dt_s": 1, "save_s": 2,
                           "mesh_size_m": .008, "air_gap_enabled": False,
                           "heat_sources": [{"name": "top 5 W", "power_W": 5,
                                             "start_s": 0, "end_s": 6, "selector": "+z"}]}}


@pytest.mark.parametrize("failure", ["__init__", "publish"])
def test_preview_io_failure_does_not_lose_a_real_solver_result(tmp_path, plate, failure):
    request = tmp_path / "request.json"
    request.write_text(json.dumps(example(plate)), encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    # Production owns one worker process per task; isolate imported engine paths too.
    script = '''
import sys
from thermal_sim._worker import execute
from thermal_sim.preview import PreviewWriter
def unavailable(*args, **kwargs):
    raise OSError("preview storage unavailable")
setattr(PreviewWriter, sys.argv[3], unavailable)
execute(sys.argv[1], sys.argv[2], "run")
'''
    completed = subprocess.run([sys.executable, "-I", "-X", "utf8", "-c", script, str(request), str(output), failure],
                               capture_output=True, timeout=180)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["result"]["maximum_C"] > 25
    assert (output / "job/report.pdf").read_bytes().startswith(b"%PDF-")
    assert not (output / "preview/index.json").exists()


def test_inspected_rectangular_heat_and_cooling_reach_real_solver_and_reports(tmp_path,plate):
    inspection=body(invoke('inspect',plate,'--units','mm','--output',tmp_path/'inspection'))
    surface=json.loads((tmp_path/'inspection/selection-surface.json').read_text(encoding="utf-8"))
    points=np.asarray(surface['points']).reshape(-1,3);faces=np.asarray(surface['faces']).reshape(-1,3)
    centers=points[faces].mean(axis=1);seed=int(np.argmin(np.linalg.norm(centers-[.04,.025,.008],axis=1)))
    selection_file=tmp_path/'selection.json'
    selection_file.write_text(json.dumps({'kind':'rectangle','face':seed,'center_m':[.04,.025,.008],'width_m':.02,'height_m':.02}))
    selected=body(subprocess.run([sys.executable,'-I','-X','utf8','-m','thermal_sim.editor','resolve',
        '--surface',str(tmp_path/'inspection/selection-surface.json'),'--request',str(selection_file)],
        capture_output=True,text=True,encoding='utf-8',timeout=60))
    request=example(plate);request['geometry']['surface_sha256']=inspection['surface_sha256']
    request['simulation']['heat_sources']=[{'name':'test patch','power_W':5,'start_s':0,'end_s':3,'faces':selected['faces'],'surface_patch':selected['surface_patch']}]
    request['simulation']['cooling']=[{'name':'patch cooling','h':20,'ambient_C':25,'faces':selected['faces'],'surface_patch':selected['surface_patch']}]
    request['simulation']['mesh_size_m']=.004
    request_file=tmp_path/'request-patch.json';request_file.write_text(json.dumps(request))
    manifest=body(invoke('run',request_file,'--output',tmp_path/'output-patch'))
    audit=json.loads((tmp_path/'output-patch/job/audit.json').read_text(encoding="utf-8"))
    assert np.isclose(audit['heat_sources'][0]['power_W'],5,rtol=1e-10)
    assert np.isclose(audit['heat_sources'][0]['mapped_area_m2'],.02*.02,rtol=1e-5)
    assert np.isclose(audit['cooling_regions'][0]['effective_area_m2'],.02*.02,rtol=1e-5)
    assert manifest['result']['maximum_C']>25
    assert (tmp_path/'output-patch/job/report.pdf').is_file()
    assert '矩形贴片' in (tmp_path/'output-patch/job/report.md').read_text(encoding='utf-8')


@pytest.mark.parametrize("mode", ["steady", "transient"])
@pytest.mark.parametrize("device", ["cpu", pytest.param("cuda", marks=pytest.mark.skipif(
    os.environ.get("COSERVE_TEST_GPU") != "1", reason="GPU acceptance requires COSERVE_TEST_GPU=1"))])
def test_real_temperature_fields_and_reports_follow_the_v1_contract(tmp_path, plate, mode, device):
    request = tmp_path / "request.json"
    value = example(plate, mode)
    value["device"] = device
    request.write_text(json.dumps(value), encoding="utf-8")
    output = tmp_path / "result"
    manifest = body(invoke("run", request, "--output", output, cwd=tmp_path))
    result = manifest["result"]
    assert manifest["backend"]["device"] == device
    audit = json.loads((output / "job/audit.json").read_text(encoding="utf-8"))
    assert audit["device"]["device"] == device
    surface = json.loads((output / "model/display.json").read_text(encoding="utf-8"))
    points = np.asarray(surface["points"]).reshape(-1, 3)
    assert np.allclose(np.ptp(points, axis=0), [.08, .05, .008], atol=1e-6)
    assert manifest["source_sha256"] == hashlib.sha256(plate.read_bytes()).hexdigest()
    field = np.fromfile(output / "job/surface.bin", dtype="<f4").reshape(result["frames"], result["vertices"])
    assert field.shape[1] == len(points)
    preview = json.loads((output / "preview/index.json").read_text(encoding="utf-8"))
    assert [row["time_s"] for row in preview["frames"]] == result["times_s"]
    live_fields = np.stack([np.fromfile(output / "preview/frames" / f"{i:06d}.bin", dtype="<f4")
                            for i in range(result["frames"])])
    assert np.max(np.abs(live_fields - field)) <= 1e-4
    assert np.isfinite(field).all() and result["maximum_C"] > 25
    assert result["analysis_mode"] == mode
    assert len(result["times_s"]) == result["frames"] == len(result["stats"])
    assert (output / "job/report.pdf").read_bytes().startswith(b"%PDF-")
    assert (output / "job/result.zip").is_file()
    assert not (output / "_engine").exists()
    assert invoke("run", request, "--output", output).returncode != 0
    # Re-run the pinned upstream solver directly, bypassing the adapter CLI,
    # on the identical frozen model, FE mesh and physical configuration. Reuse
    # the actual mesh because multithreaded Gmsh remeshing is not deterministic.
    reference = tmp_path / "upstream"
    script = r'''
import json, os, pathlib, shutil, sys, numpy as np
source, root = map(pathlib.Path, sys.argv[1:])
os.environ['THERMAL_DATA'] = str(root)
os.environ['THERMAL_DEVICE'] = 'cpu'
sys.path.insert(0, os.environ['COSERVE_THERMOFORGE_ROOT'])
from thermal_legacy import solver
solver.build_mesh = lambda *args: dict(np.load(source / 'job/mesh.npz'))
shutil.copytree(source / 'model', root / 'models/model')
job = root / 'jobs/reference'
job.mkdir()
shutil.copyfile(source / 'job/config.json', job / 'config.json')
solver.solve_job(job)
'''
    direct = subprocess.run([sys.executable, "-I", "-X", "utf8", "-c", script,
                             str(output), str(reference)], capture_output=True, text=True,
                            encoding="utf-8", timeout=180)
    assert direct.returncode == 0, direct.stdout + direct.stderr
    expected = np.fromfile(reference / "jobs/reference/surface.bin", dtype="<f4")
    assert expected.size == field.size
    assert np.max(np.abs(expected - field.ravel())) <= 1e-4
    upstream = json.loads((reference / "jobs/reference/result.json").read_text(encoding="utf-8"))
    assert upstream["times_s"] == result["times_s"]


def test_cleanup_failure_cannot_publish_a_success_marker(tmp_path, plate):
    value = example(plate, "steady")
    request = tmp_path / "request.json"
    request.write_text(json.dumps(value), encoding="utf-8")
    output = tmp_path / "interrupted-publication"
    output.mkdir()
    script = r'''
import pathlib, runpy, shutil, sys
original = shutil.rmtree
def interrupted(path, *args, **kwargs):
    if pathlib.Path(path).name == '_engine':
        raise OSError('Simulated failure before final publication')
    return original(path, *args, **kwargs)
shutil.rmtree = interrupted
sys.argv = ['thermal_sim._worker', *sys.argv[1:], 'run']
runpy.run_module('thermal_sim._worker', run_name='__main__')
'''
    failed = subprocess.run([sys.executable, "-I", "-X", "utf8", "-c", script,
                             str(request), str(output)], capture_output=True, text=True,
                            encoding="utf-8", timeout=180)
    assert failed.returncode != 0
    assert not (output / "manifest.json").exists()
    assert json.loads((output / "job/status.json").read_text(encoding="utf-8"))["phase"] == "failed"


def test_inspect_and_empty_selector_failure_leave_no_success_manifest(tmp_path, plate):
    inspection = body(invoke("inspect", plate, "--output", tmp_path / "inspection"))
    assert inspection["geometry"]["sha256"] == hashlib.sha256(plate.read_bytes()).hexdigest()
    value = example(plate)
    value["simulation"]["heat_sources"][0]["selector"] = "not-a-direction"
    request = tmp_path / "invalid.json"
    request.write_text(json.dumps(value))
    output = tmp_path / "failed"
    assert invoke("run", request, "--output", output).returncode != 0
    assert not (output / "manifest.json").exists()


def test_optional_structural_null_is_supported():
    from thermal_sim.bridge import resolve_config
    assert resolve_config({"structural": None}, {"points": [0, 0, 0, 1, 0, 0, 0, 1, 0],
                                                "faces": [0, 1, 2]}, "a" * 64)["structural"] is None


def test_repeated_inspection_preserves_triangle_ids_and_cpu_budget(tmp_path, plate):
    a = body(invoke("inspect", plate, "--output", tmp_path / "a"))
    b = body(invoke("inspect", plate, "--output", tmp_path / "b"))
    assert (tmp_path / "a/model/display.json").read_bytes() == (tmp_path / "b/model/display.json").read_bytes()
    assert a["backend"]["cpu_threads"] == b["backend"]["cpu_threads"] == 6


def test_explicit_face_request_requires_a_supplied_source_hash(tmp_path, plate):
    from thermal_sim.bridge import prepare_request
    value = example(plate)
    value["geometry"].pop("sha256")
    value["simulation"]["heat_sources"] = [{"faces": [0], "power_W": 5}]
    with pytest.raises(ValueError, match="SHA-256"):
        prepare_request(value)


def test_stl_units_and_open_solid_are_checked(tmp_path):
    import trimesh
    source = tmp_path / "box.stl"
    source.write_bytes(trimesh.creation.box(extents=[10, 20, 30]).export(file_type="stl"))
    for units, scale in (("mm", .001), ("cm", .01)):
        output = tmp_path / units
        value = body(invoke("inspect", source, "--units", units, "--output", output))
        assert np.allclose(value["geometry"]["metadata"]["dimensions_m"], np.array([10, 20, 30]) * scale)
    mesh = trimesh.creation.box()
    mesh.update_faces(np.arange(len(mesh.faces) - 1))
    source = tmp_path / "open.stl"
    source.write_bytes(mesh.export(file_type="stl"))
    assert invoke("inspect", source, "--units", "mm", "--output", tmp_path / "bad-solid").returncode != 0
    assert not (tmp_path / "bad-solid/inspection.json").exists()


@pytest.mark.parametrize("mutation", [
    lambda c: c.update(unknown_physics=123),
    lambda c: c["base_material"].update(k=-1),
    lambda c: c["heat_sources"][0].update(selector=None),
])
def test_invalid_physics_never_produces_success(tmp_path, plate, mutation):
    value = example(plate)
    mutation(value["simulation"])
    request = tmp_path / "request.json"
    request.write_text(json.dumps(value))
    output = tmp_path / "failed"
    assert invoke("run", request, "--output", output).returncode != 0
    assert not (output / "manifest.json").exists()
