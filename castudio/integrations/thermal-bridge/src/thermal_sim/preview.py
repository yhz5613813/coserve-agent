"""Immutable saved fields with an atomic index for read-only, unfinished previews."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

import numpy as np


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    for attempt in range(10):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(min(.02 * (attempt + 1), .1))


class PreviewWriter:
    def __init__(self, output, source_hash, surface, vertices, analysis_mode):
        self.folder = Path(output) / "preview"
        (self.folder / "frames").mkdir(parents=True)
        shutil.copyfile(surface, self.folder / "surface.json")
        self.index = {"schema_version": 1, "source_sha256": source_hash,
                      "analysis_mode": analysis_mode, "vertices": vertices,
                      "geometry_sha256": hashlib.sha256((self.folder / "surface.json").read_bytes()).hexdigest(),
                      "frames": []}

    def publish(self, time_s, values, stats):
        values = np.asarray(values, dtype="<f4").reshape(-1)
        if len(values) != self.index["vertices"] or not np.isfinite(values).all():
            raise ValueError("Invalid live temperature field")
        frames = self.index["frames"]
        if frames and time_s <= frames[-1]["time_s"]:
            raise ValueError("Live temperature times must increase")
        data = values.tobytes()
        target = self.folder / "frames" / f"{len(frames):06d}.bin"
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(data)
        os.replace(temporary, target)
        row = {"time_s": float(time_s), **stats, "sha256": hashlib.sha256(data).hexdigest()}
        next_index = {**self.index, "frames": [*frames, row]}
        write_json(self.folder / "index.json", next_index)
        self.index = next_index
