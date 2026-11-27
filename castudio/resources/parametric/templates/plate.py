# /// script
# requires-python = ">=3.10"
# dependencies = ["cadflow"]
# [tool.castudio]
# id = "castudio-plate"
# revision = "1.0.0"
# ///
import marimo

app = marimo.App(width="medium")

with app.setup:
    import cadflow as cad


@app.cell
def _():
    # ---- params: 板 ----
    LENGTH = 200.0  # ui: slider(50, 500, step=10, label="长 mm")
    WIDTH = 100.0  # ui: slider(30, 300, step=10, label="宽 mm")
    THICKNESS = 8.0  # ui: slider(2, 30, step=1, label="厚 mm")
    return LENGTH, WIDTH, THICKNESS


@app.cell
def _():
    # ---- params: 孔阵列（行数或列数为 0 则不开孔） ----
    HOLE_COLUMNS = 3  # ui: slider(0, 8, step=1, label="每行孔数")
    HOLE_ROWS = 2  # ui: slider(0, 6, step=1, label="孔行数")
    HOLE_DIAMETER = 10.0  # ui: slider(4, 30, step=1, label="孔径 mm")
    HOLE_MARGIN = 20.0  # ui: slider(10, 50, step=1, label="边孔中心距板边 mm")
    return HOLE_COLUMNS, HOLE_ROWS, HOLE_DIAMETER, HOLE_MARGIN


@app.cell
def _(LENGTH, WIDTH, THICKNESS):
    # ---- feature: 平板毛坯 (build) ----
    blank = cad.make_box_rsolid(LENGTH, WIDTH, THICKNESS, bottom_face_center=(0, 0, 0))
    return (blank,)


@app.cell
def _(blank, LENGTH, WIDTH, THICKNESS, HOLE_COLUMNS, HOLE_ROWS, HOLE_DIAMETER, HOLE_MARGIN):
    # ---- feature: 孔阵列 (subtract) ----
    body = blank
    if HOLE_COLUMNS > 0 and HOLE_ROWS > 0:
        assert HOLE_MARGIN > HOLE_DIAMETER/2, "孔与板边距离过小"
        assert HOLE_MARGIN < min(LENGTH, WIDTH)/2, "孔分布范围超出板面"
        _dx = (LENGTH-2*HOLE_MARGIN)/(HOLE_COLUMNS-1) if HOLE_COLUMNS > 1 else 0
        _dy = (WIDTH-2*HOLE_MARGIN)/(HOLE_ROWS-1) if HOLE_ROWS > 1 else 0
        assert HOLE_COLUMNS == 1 or _dx > HOLE_DIAMETER, "相邻孔重叠"
        assert HOLE_ROWS == 1 or _dy > HOLE_DIAMETER, "相邻孔重叠"
        for _i in range(HOLE_COLUMNS):
            for _j in range(HOLE_ROWS):
                _x = (_i*_dx-(HOLE_COLUMNS-1)*_dx/2)
                _y = (_j*_dy-(HOLE_ROWS-1)*_dy/2)
                _tool = cad.make_cylinder_rsolid(HOLE_DIAMETER/2, THICKNESS+2, bottom_face_center=(_x, _y, -1))
                body = cad.cut_rsolid(body, _tool)
    return (body,)


@app.cell
def _(body):
    plate = cad.Part(part_id="castudio-plate", body=body)
    return (plate,)


if __name__ == "__main__":
    app.run()
