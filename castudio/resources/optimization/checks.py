"""Independent STEP measurements and final volume-node temperature scoring."""
import json
import sys
from pathlib import Path
import numpy as np


def final_temperature(file):
    values = np.load(file, allow_pickle=False, mmap_mode='r')
    if values.ndim != 2 or min(values.shape) < 1 or not np.isfinite(values).all():
        raise ValueError('Invalid full solid temperature field')
    return float(np.max(values[-1]))


def geometry(file, units):
    import gmsh
    if units not in ('mm', 'cm', 'm'):
        raise ValueError('Invalid geometry units')
    # OCC honors the embedded STEP units; use mm for the geometric tolerances below.
    scale = .001
    gmsh.initialize()
    try:
        gmsh.option.setNumber('General.Terminal', 0)
        gmsh.option.setString('Geometry.OCCTargetUnit', 'MM')
        gmsh.model.occ.importShapes(str(file))
        gmsh.model.occ.synchronize()
        solids = gmsh.model.getEntities(3)
        if len(solids) != 1:
            raise ValueError('Exactly one STEP solid required')
        bounds = np.array(gmsh.model.getBoundingBox(*solids[0])) * scale
        volume = gmsh.model.occ.getMass(*solids[0]) * scale ** 3
        if not np.isfinite(bounds).all() or not np.isfinite(volume) or volume <= 0:
            raise ValueError('Invalid independent STEP volume')
        holes = []
        raw_bounds = bounds / scale
        tolerance = max(float(np.ptp(raw_bounds.reshape(2, 3), axis=0).max()) * 1e-7, 1e-7)
        for dim, tag in list(gmsh.model.getEntities(2)):
            if gmsh.model.getType(dim, tag) != 'Cylinder':
                continue
            lo, hi = gmsh.model.getParametrizationBounds(dim, tag)
            uv = [(lo[0] + (hi[0] - lo[0]) * i / 4, (lo[1] + hi[1]) / 2) for i in range(4)]
            points = np.asarray([gmsh.model.getValue(dim, tag, list(pair)) for pair in uv])
            center = points.mean(axis=0)
            radius = float(np.linalg.norm(points[0, :2] - center[:2]))
            if (abs(float(hi[0] - lo[0]) - 2*np.pi) > 1e-5 or radius <= tolerance
                    or np.ptp(points[:, 2]) > tolerance
                    or np.max(abs(np.linalg.norm(points[:, :2] - center[:2], axis=1) - radius)) > tolerance):
                raise ValueError('Only independently identified vertical full-circle mounting holes are supported')
            box = np.asarray(gmsh.model.getBoundingBox(dim, tag))
            if abs((box[3]-box[0])/2-radius) > tolerance*4 or abs((box[4]-box[1])/2-radius) > tolerance*4:
                raise ValueError('Unsupported cylindrical interface')
            # Test the entire mounting passage, not merely its surviving side-wall bbox.
            probe = gmsh.model.occ.addCylinder(float(center[0]), float(center[1]), float(raw_bounds[2]-tolerance),
                0, 0, float(raw_bounds[5]-raw_bounds[2]+2*tolerance), radius-tolerance)
            copied = gmsh.model.occ.copy(solids)
            overlap, _ = gmsh.model.occ.intersect(copied, [(3, probe)])
            blocked = sum(gmsh.model.occ.getMass(d, t) for d, t in overlap if d == 3)
            if overlap:
                gmsh.model.occ.remove(overlap, recursive=True)
            gmsh.model.occ.synchronize()
            if blocked > max(volume / scale**3 * 1e-10, 1e-9):
                raise ValueError('Mounting hole is obstructed or is not a through void')
            holes.append([*(box * scale).tolist(), float(center[0]*scale), float(center[1]*scale), radius*scale, 0, 0, 1])
        return dict(bounds=bounds.tolist(), volumeM3=float(volume), holes=sorted(holes))
    finally:
        gmsh.finalize()


def validate_source(file):
    import ast
    tree = ast.parse(Path(file).read_text(encoding='utf-8-sig'))
    allowed = {'gmsh', 'math', 'json', 'pathlib', 'numpy', 'itertools', 'collections'}
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or '']
            if any(n.split('.')[0] not in allowed for n in names):
                raise ValueError('Only self-contained Gmsh and numeric standard imports are supported')
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {'exec', 'eval', '__import__', 'compile', 'input'}:
                raise ValueError('Dynamic code or external input is unsupported')
            if isinstance(node.func, ast.Attribute) and node.func.attr in {'read_text', 'read_bytes', 'load', 'loadtxt', 'genfromtxt', 'merge', 'open'}:
                raise ValueError('Geometry must not depend on external files')
    return {'selfContained': True}

# This is a deliberately small numeric CAD language, checked before Builds executes it.
def validate_candidate(file):
    import ast
    tree = ast.parse(Path(file).read_text(encoding='utf-8-sig'))
    builtins = {'range', 'len', 'print', 'min', 'max', 'sum', 'abs', 'float', 'int', 'bool', 'str', 'enumerate', 'zip', 'sorted', 'list', 'tuple', 'dict', 'set', 'round', 'all', 'any'}
    import builtins as builtin_module
    forbidden_builtins = set(vars(builtin_module)) - builtins
    cad = {'gmsh.initialize', 'gmsh.finalize', 'gmsh.clear', 'gmsh.write', 'gmsh.model.add', 'gmsh.model.getEntities', 'gmsh.model.getBoundary', 'gmsh.model.getType', 'gmsh.model.getValue', 'gmsh.model.getBoundingBox', 'gmsh.model.getNormal', 'gmsh.model.getParametrizationBounds', 'gmsh.option.setNumber', 'gmsh.option.getNumber'}
    cad.update('gmsh.model.occ.' + name for name in ('addBox', 'addCylinder', 'addSphere', 'addCone', 'addTorus', 'addWedge', 'addRectangle', 'addDisk', 'addPoint', 'addLine', 'addCircle', 'addCircleArc', 'addEllipse', 'addSpline', 'addBSpline', 'addWire', 'addCurveLoop', 'addPlaneSurface', 'addSurfaceLoop', 'addVolume', 'extrude', 'revolve', 'fuse', 'cut', 'intersect', 'fragment', 'fillet', 'chamfer', 'translate', 'rotate', 'dilate', 'mirror', 'copy', 'remove', 'removeAllDuplicates', 'synchronize', 'getMass', 'getCenterOfMass', 'getBoundingBox', 'getEntities', 'importShapes'))
    cad.update('gmsh.model.mesh.' + name for name in ('generate', 'setSize', 'clear', 'optimize', 'getNodes', 'getElements'))
    cad.update('gmsh.model.' + name for name in ('addPhysicalGroup', 'setPhysicalName', 'getPhysicalGroups', 'getEntitiesForPhysicalGroup'))
    math = {'math.' + name for name in ('sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'ceil', 'floor', 'fabs', 'pow', 'exp', 'log', 'log10', 'hypot', 'radians', 'degrees', 'isfinite', 'copysign', 'trunc', 'pi', 'e', 'tau')}
    safe = cad | math | {'json.dumps', 'json.loads'}
    methods = {'append', 'extend', 'pop', 'get', 'items', 'keys', 'values', 'count', 'index', 'reverse', 'sort'}
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    helpers = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    protected = builtins | helpers | {'gmsh', 'math', 'json'}
    declared = protected | {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)} | {n.arg for n in ast.walk(tree) if isinstance(n, ast.arg)}
    syntax = {'Starred', 'Module', 'Import', 'alias', 'FunctionDef', 'arguments', 'arg', 'Return', 'Assign', 'AnnAssign', 'AugAssign', 'Expr', 'If', 'IfExp', 'For', 'While', 'Break', 'Continue', 'Pass', 'Try', 'ExceptHandler', 'Assert', 'Raise', 'Call', 'keyword', 'Name', 'Load', 'Store', 'Constant', 'Attribute', 'Subscript', 'Slice', 'List', 'Tuple', 'Dict', 'Set', 'ListComp', 'SetComp', 'DictComp', 'GeneratorExp', 'comprehension', 'BinOp', 'UnaryOp', 'BoolOp', 'Compare', 'JoinedStr', 'FormattedValue', 'Lambda', 'Add', 'Sub', 'Mult', 'Div', 'FloorDiv', 'Mod', 'Pow', 'USub', 'UAdd', 'Not', 'And', 'Or', 'Eq', 'NotEq', 'Lt', 'LtE', 'Gt', 'GtE', 'In', 'NotIn', 'Is', 'IsNot', 'BitOr', 'BitAnd', 'BitXor', 'LShift', 'RShift', 'Invert'}
    def dotted(node):
        if isinstance(node, ast.Name): return node.id
        if isinstance(node, ast.Attribute): return dotted(node.value) + '.' + node.attr
        return ''
    for node in ast.walk(tree):
        identifier = node.id if isinstance(node, ast.Name) else node.arg if isinstance(node, ast.arg) else node.name if isinstance(node, (ast.FunctionDef, ast.ExceptHandler)) else None
        if identifier in forbidden_builtins:
            raise ValueError('Unsupported Python builtin identifier: ' + identifier)
        if type(node).__name__ not in syntax:
            raise ValueError('Unsupported candidate syntax: ' + type(node).__name__)
        if isinstance(node, ast.Import):
            if any(a.name not in {'gmsh', 'math', 'json'} or a.asname is not None for a in node.names):
                raise ValueError('Candidate imports are limited to gmsh, math and json without aliases')
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.name in builtins | {'gmsh', 'math', 'json'}):
            raise ValueError('Decorators and protected function names are unsupported')
        if isinstance(node, ast.arg) and (node.arg in protected or node.arg.startswith('_')):
            raise ValueError('Protected candidate argument name')
        if isinstance(node, ast.Name):
            if (node.id.startswith('_') and node.id != '_') or (isinstance(node.ctx, ast.Store) and node.id in protected) or (isinstance(node.ctx, ast.Load) and node.id not in declared):
                raise ValueError('Reflection and protected-name rebinding are unsupported')
        if isinstance(node, ast.Attribute):
            name = dotted(node)
            if name in {'gmsh.write', 'gmsh.model.occ.importShapes', 'gmsh.initialize', 'gmsh.option.setNumber'} and not (isinstance(parents.get(node), ast.Call) and parents[node].func is node):
                raise ValueError('Sensitive CAD operations cannot be passed as values')
            if node.attr.startswith('_') or isinstance(node.ctx, ast.Store):
                raise ValueError('Attribute mutation and reflection are unsupported')
            if not (name in safe or any(v.startswith(name + '.') for v in safe) or (node.attr in methods and dotted(node.value) not in {'gmsh', 'math', 'json'})):
                raise ValueError('Unsupported candidate attribute: ' + name)
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            if isinstance(node.func, ast.Name):
                if name not in builtins | helpers: raise ValueError('Unknown candidate call: ' + name)
            elif isinstance(node.func, ast.Attribute):
                if name not in safe and node.func.attr not in methods: raise ValueError('Unknown candidate call: ' + name)
            else: raise ValueError('Dynamic calls are unsupported')
            if name in {'gmsh.write', 'gmsh.model.occ.importShapes'}:
                if len(node.args) != 1 or node.keywords or not isinstance(node.args[0], ast.Constant) or node.args[0].value not in {'model.step', 'model.stl'}:
                    raise ValueError('Candidate geometry IO is restricted to literal model.step or model.stl')
            if name == 'gmsh.initialize' and (node.args or any(k.arg != 'interruptible' or not isinstance(k.value, ast.Constant) or k.value.value is not False for k in node.keywords)):
                raise ValueError('Candidate initialization may only set interruptible=False')
            if name == 'gmsh.option.setNumber' and (len(node.args) != 2 or node.keywords or not isinstance(node.args[0], ast.Constant) or not isinstance(node.args[0].value, str) or not node.args[0].value.startswith(('Mesh.', 'Geometry.', 'General.Terminal', 'General.NumThreads'))):
                raise ValueError('Only numeric CAD mesh options are supported')
    return {'selfContained': True}

def process_clear(file):
    """Read-only orphan detection; do not launch another solver on unknown ownership."""
    import os
    import subprocess
    targets = [str(Path(p).resolve()).replace('\\', '/').lower() for p in json.loads(Path(file).read_text(encoding='utf-8-sig'))]
    rows = []
    if os.name == 'nt':
        command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode != 0:
            raise ValueError('Cannot confirm prior process exit: CIM query failed')
        rows = json.loads(result.stdout.decode('utf-8-sig'))
        if not isinstance(rows, list): rows = [rows]
    elif sys.platform.startswith('linux'):
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                command = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf-8', errors='replace')
                name = (entry / 'comm').read_text().strip()
            except FileNotFoundError:
                continue
            except PermissionError:
                raise ValueError('Cannot confirm prior process exit: process command line inaccessible')
            rows.append(dict(ProcessId=int(entry.name), Name=name, CommandLine=command))
    else:
        raise ValueError('Orphan process confirmation is unsupported on this platform')
    matching = []
    for row in rows:
        if row['ProcessId'] == os.getpid(): continue
        command = row.get('CommandLine')
        if not command and 'python' in (row.get('Name') or '').lower():
            raise ValueError('Cannot confirm prior Python process ownership')
        normalized = (command or '').replace('\\', '/').lower()
        if any(target in normalized for target in targets): matching.append(row['ProcessId'])
    return dict(clear=not matching, pids=matching)

if __name__ == '__main__':
    action, file, *args = sys.argv[1:]
    result = geometry(Path(file), args[0]) if action == 'geometry' else process_clear(file) if action == 'processes' else validate_candidate(file) if action == 'candidate' else validate_source(file) if action == 'source' else dict(maximumC=final_temperature(Path(file)))
    print('OPTIMIZATION_RESULT=' + json.dumps(result, allow_nan=False))
