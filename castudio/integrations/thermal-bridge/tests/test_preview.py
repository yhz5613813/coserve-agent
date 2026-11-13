import json
from pathlib import Path

import numpy as np
import pytest
from scipy.sparse import csr_matrix, eye


def test_saved_frame_observer_preserves_the_actual_solution(tmp_path):
    from thermal_sim._backend import load
    schemas, _, solver, _, _ = load(tmp_path / "engine")
    cfg = schemas.Simulation.model_validate({
        "model_id": "model", "duration_s": 4, "dt_s": .25, "save_s": 1,
        "base_material": {"name": "software test", "k": 1, "rho": 1, "cp": 1},
        "heat_sources": [{"faces": [0], "power_W": 1, "end_s": 4}],
    }).model_dump()
    args = (eye(2, format="csr"), csr_matrix([[1., -1.], [-1., 1.]]),
            eye(2, format="csr") * .2, np.zeros(2), [np.array([1., 0.])], cfg)
    for function in (solver.integrate, solver.steady):
        reference = function(*args)
        seen = []
        actual = function(*args, frame_callback=lambda t, values: seen.append((t, values.copy())))
        assert [t for t, _ in seen] == list(actual[1])
        assert np.array_equal(actual[0], reference[0])
        assert np.allclose(np.array([v for _, v in seen]), actual[0] + cfg["initial_C"])


def surface(tmp_path):
    path = tmp_path / "surface.json"
    path.write_text(json.dumps({"points": [0, 0, 0, 1, 0, 0, 0, 1, 0], "faces": [0, 1, 2]}))
    return path


def test_preview_frames_are_immutable_and_indexed_after_their_data(tmp_path):
    from thermal_sim.preview import PreviewWriter
    writer = PreviewWriter(tmp_path / "output", "a" * 64, surface(tmp_path), 3, "transient")
    writer.publish(0, np.array([25, 25, 25]), {"minimum_C": 25, "maximum_C": 25, "average_C": 25})
    first = (tmp_path / "output/preview/frames/000000.bin").read_bytes()
    writer.publish(2, np.array([26, 27, 28]), {"minimum_C": 26, "maximum_C": 28, "average_C": 27})
    index = json.loads((tmp_path / "output/preview/index.json").read_text(encoding="utf-8"))
    assert index["source_sha256"] == "a" * 64
    assert [f["time_s"] for f in index["frames"]] == [0, 2]
    assert first == (tmp_path / "output/preview/frames/000000.bin").read_bytes()
    assert np.array_equal(np.fromfile(tmp_path / "output/preview/frames/000001.bin", dtype="<f4"), [26, 27, 28])
    assert not (tmp_path / "output/manifest.json").exists()


def test_failed_index_publication_keeps_the_previous_snapshot(tmp_path, monkeypatch):
    from thermal_sim.preview import PreviewWriter
    import thermal_sim.preview as preview
    writer = PreviewWriter(tmp_path / "output", "a" * 64, surface(tmp_path), 3, "transient")
    stats = {"minimum_C": 25, "maximum_C": 25, "average_C": 25}
    writer.publish(0, np.full(3, 25), stats)
    previous = (tmp_path / "output/preview/index.json").read_bytes()
    def failed(*args):
        raise OSError("interrupted index write")
    monkeypatch.setattr(preview, "write_json", failed)
    with pytest.raises(OSError):
        writer.publish(1, np.full(3, 25), stats)
    assert (tmp_path / "output/preview/index.json").read_bytes() == previous
