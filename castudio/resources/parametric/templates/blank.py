# /// script
# requires-python = ">=3.10"
# dependencies = ["cadflow"]
# [tool.castudio]
# id = "castudio-part"
# revision = "1.0.0"
# ///
import marimo

app = marimo.App(width="medium")

with app.setup:
    import cadflow as cad


@app.cell
def _():
    # ---- params: 主要尺寸 ----
    LENGTH = 100.0  # ui: slider(10, 500, step=5, label="长 mm")
    WIDTH = 60.0  # ui: slider(10, 500, step=5, label="宽 mm")
    HEIGHT = 20.0  # ui: slider(2, 200, step=1, label="高 mm")
    return LENGTH, WIDTH, HEIGHT


@app.cell
def _(LENGTH, WIDTH, HEIGHT):
    # ---- feature: 实体 (build) ----
    body = cad.make_box_rsolid(LENGTH, WIDTH, HEIGHT, bottom_face_center=(0, 0, 0))
    return (body,)


@app.cell
def _(body):
    part = cad.Part(part_id="castudio-part", body=body)
    return (part,)


if __name__ == "__main__":
    app.run()
