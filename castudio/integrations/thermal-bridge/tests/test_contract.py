import copy
import hashlib
import json
import struct
from pathlib import Path

import pytest

from thermal_sim.bridge import prepare_request, resolve_config, validate_result


def request_for(path):
    return {"schema_version": 1, "device": "cpu",
            "geometry": {"path": str(path), "units": "mm"},
            "simulation": {"name": "test", "heat_sources": [{"selector": "+z"}]}}


def test_request_freezes_identity_and_resolves_relative_paths(tmp_path):
    model = tmp_path / "model.stl"
    model.write_bytes(b"solid example\nendsolid example")
    request = request_for(Path("model.stl"))
    resolved = prepare_request(request, tmp_path)
    assert resolved["geometry"]["path"] == str(model)
    assert resolved["geometry"]["sha256"] == hashlib.sha256(model.read_bytes()).hexdigest()
    assert "sha256" not in request["geometry"]


@pytest.mark.parametrize("mutation", [
    lambda r: r.update(unrecognized=True),
    lambda r: r.update(device="invalid-device"),
    lambda r: r["geometry"].update(sha256="0" * 64),
    lambda r: r["geometry"].update(units="inch"),
    lambda r: r["geometry"].pop("units"),
    lambda r: r["simulation"].update(initial_from_job="outside"),
    lambda r: r["simulation"].update(model_id="outside"),
])
def test_invalid_portable_requests_are_rejected_before_output(tmp_path, mutation):
    model = tmp_path / "model.stl"
    model.write_bytes(b"solid example\nendsolid example")
    request = request_for(model)
    mutation(request)
    with pytest.raises(ValueError):
        prepare_request(request, tmp_path)
    assert list(tmp_path.iterdir()) == [model]


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_request_preserves_explicit_compute_device(tmp_path, device):
    model = tmp_path / "model.stl"
    model.write_bytes(b"solid example\nendsolid example")
    request = request_for(model)
    request["device"] = device
    assert prepare_request(request)["device"] == device


@pytest.fixture
def surface():
    return {"points": [0, 0, 1, 1, 0, 1, 0, 1, 1,
                       0, 0, 0, 0, 1, 0, 1, 0, 0,
                       1, 0, 0, 1, 1, 0, 1, 0, 1],
            "faces": list(range(9))}


def test_directional_selection_uses_thermal_triangle_normals(surface):
    cfg = {"heat_sources": [{"selector": "+z"}], "cooling": [{"selector": "-z"}],
           "structural": {"supports": [{"selector": "+x"}]},
           "surface_evaluation": {"selector": "all"}}
    original = copy.deepcopy(cfg)
    result = resolve_config(cfg, surface, "a" * 64)
    assert result["model_id"] == "model"
    assert result["heat_sources"][0]["faces"] == [0]
    assert result["cooling"][0]["faces"] == [1]
    assert result["structural"]["supports"][0]["faces"] == [2]
    assert result["surface_evaluation"]["faces"] == [0, 1, 2]
    assert cfg == original


@pytest.mark.parametrize("group", [{"selector": "+y"}, {"selector": "top"},
    {"faces": [-1]}, {"faces": [3]}, {"faces": [True]},
    {"selector": "+z", "faces": [1]}])
def test_empty_or_ambiguous_selection_is_not_silently_replaced(surface, group):
    with pytest.raises(ValueError):
        resolve_config({"heat_sources": [group]}, surface, "a" * 64)


def test_explicit_faces_require_geometry_binding(surface):
    with pytest.raises(ValueError):
        resolve_config({"heat_sources": [{"faces": [0]}]}, surface, None)


def output_fixture(tmp_path):
    (tmp_path / "model").mkdir()
    (tmp_path / "job").mkdir()
    source = b"source geometry"
    (tmp_path / "model/source.step").write_bytes(source)
    (tmp_path / "model/display.json").write_text(json.dumps(
        {"points": [0, 0, 0, 1, 0, 0, 0, 1, 0], "faces": [0, 1, 2]}))
    (tmp_path / "job/surface.bin").write_bytes(struct.pack("<6f", 25, 26, 27, 28, 29, 30))
    digest = hashlib.sha256(source).hexdigest()
    result = {"schema_version": 1, "source_sha256": digest, "engine_version": "test",
              "result": {"vertices": 3, "frames": 2, "times_s": [0, 2],
                         "minimum_C": 25, "maximum_C": 30,
                         "stats": [{"time_s": 0, "minimum_C": 25, "maximum_C": 27, "average_C": 26},
                                   {"time_s": 2, "minimum_C": 28, "maximum_C": 30, "average_C": 29}]}}
    return result, digest


@pytest.mark.parametrize("row", [
    {"time_s": 0, "minimum_C": 90, "maximum_C": 10, "average_C": 1e9},
    {"time_s": 0, "minimum_C": 25, "maximum_C": 27, "average_C": 1e9},
    {"time_s": float("nan"), "minimum_C": 25, "maximum_C": 27, "average_C": 26},
    {"time_s": float("inf"), "minimum_C": 25, "maximum_C": 27, "average_C": 26},
    {"time_s": 0, "minimum_C": 25, "maximum_C": 25, "average_C": 25},
    {"time_s": 0, "minimum_C": -5, "maximum_C": 27, "average_C": 26},
    {"time_s": 0, "minimum_C": 25, "maximum_C": 50, "average_C": 26},
])
def test_impossible_history_cannot_be_published(tmp_path, row):
    manifest, source_hash = output_fixture(tmp_path)
    manifest["result"]["stats"][0] = row
    with pytest.raises(ValueError):
        validate_result(tmp_path, manifest, source_hash)


def test_history_allows_volume_extrema_beyond_the_visible_surface(tmp_path):
    manifest, source_hash = output_fixture(tmp_path)
    result = manifest["result"]
    result.update(minimum_C=10, maximum_C=40)
    result["stats"][0].update(minimum_C=10, maximum_C=35, average_C=27)
    result["stats"][1].update(minimum_C=20, maximum_C=40, average_C=31)
    validate_result(tmp_path, manifest, source_hash)


def test_surface_layout_and_geometry_identity_are_verified(tmp_path):
    manifest, digest = output_fixture(tmp_path)
    validate_result(tmp_path, manifest, digest)
    (tmp_path / "job/surface.bin").write_bytes(b"short")
    with pytest.raises(ValueError):
        validate_result(tmp_path, manifest, digest)


@pytest.mark.parametrize("mutation", [
    lambda m: m.update(source_sha256="0" * 64),
    lambda m: m["result"].update(times_s=[2, 0]),
    lambda m: m["result"].update(frames=3),
    lambda m: m["result"].update(maximum_C=float("nan")),
])
def test_corrupt_results_cannot_be_published(tmp_path, mutation):
    manifest, digest = output_fixture(tmp_path)
    mutation(manifest)
    with pytest.raises(ValueError):
        validate_result(tmp_path, manifest, digest)
