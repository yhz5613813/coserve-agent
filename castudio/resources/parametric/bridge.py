"""CAStudio adapter. Upstream runtime/exporter remain unmodified APIs."""
import argparse, hashlib, json, sys
from pathlib import Path


def dump(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def volume(shape):
    from OCP.GProp import GProp_GProps
    from OCP.BRepGProp import BRepGProp
    p = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, p)
    return p.Mass()


def read_step(path):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError("Cannot read STEP")
    reader.TransferRoots()
    return reader.OneShape()


def equivalent(candidate, reference):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepCheck import BRepCheck_Analyzer
    a, b = read_step(candidate), read_step(reference)
    if not BRepCheck_Analyzer(a).IsValid():
        raise ValueError("Invalid exported CAD")
    va, vb = volume(a), volume(b)
    print(f"CAStudio: CAD volumes {va:.6f} / {vb:.6f} mm3",flush=True)
    tolerance = max(abs(vb)*1e-8, 0.01)
    diffs = []
    if abs(va-vb) <= tolerance:
        for index,(left, right) in enumerate([(a,b), (b,a)],1):
            print(f"CAStudio: exact CAD difference {index}/2",flush=True)
            cut = BRepAlgoAPI_Cut(left, right)
            if not cut.IsDone():
                raise ValueError("CAD equivalence boolean failed")
            diffs.append(abs(volume(cut.Shape())))
    return dict(approved=len(diffs)==2 and max(diffs)<=tolerance,
                volume_mm3=va, reference_volume_mm3=vb,
                difference_volumes_mm3=diffs, tolerance_mm3=tolerance,
                reference_sha256=hashlib.sha256(Path(reference).read_bytes()).hexdigest(),
                reference_step_data_sha256=hashlib.sha256(Path(reference).read_bytes().split(b'DATA;',1)[1]).hexdigest())


def validate(candidate, reference, output):
    import cadflow as cad
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    sys.path.insert(0,str(Path(__file__).parent/'templates'))
    from parametric_common import boundaries, area
    check=equivalent(candidate,reference)
    if not check['approved']:
        raise ValueError('Changed CAD is not equivalent to the validated cylinder shell profile')
    shape=read_step(candidate);it=TopExp_Explorer(shape,TopAbs_SOLID);solids=[]
    while it.More():
        solids.append(TopoDS.Solid_s(it.Current()));it.Next()
    if len(solids)!=1:raise ValueError('Cylinder must be one connected CAD solid')
    groups=boundaries(cad.Solid(solids[0]),500,500)
    mapping={'interface.fixed_support':'bottom','interface.axial_load':'top','interface.external_pressure':'skin'}
    result=dict(schema_version=1,source_sha256=hashlib.sha256(Path(candidate).read_bytes()).hexdigest(),equivalence=check,
        bindings={k:dict(shell_set=mapping[k],face_count=len(v),area_mm2=sum(area(f) for f in v)) for k,v in groups.items()})
    dump(output,result)


def build(notebook, output, template, params_from, reference):
    import time
    started=time.monotonic()
    print('CAStudio: loading CAD runtime',flush=True)
    from castudio_runtime.runtime.runner import run_notebook
    from castudio_runtime.runtime.config import read_notebook_config
    from castudio_runtime.runtime.params import read_saved_params, list_parameters
    from castudio_runtime.product.packages import build_product_package, encode_product_package
    out = Path(output); out.mkdir(parents=True, exist_ok=True)
    print('CAStudio: executing notebook (cell cache disabled in stage 1)',flush=True)
    # The editor keeps its saved slider values under the original notebook's path; the frozen copy has a different path.
    saved=read_saved_params(read_notebook_config(Path(params_from)))
    # An overridden cell does not run, so a slider saved for one variable carries the cell's other parameters at their source values.
    specs=list_parameters(notebook); touched={s.cell for s in specs if s.name in saved}
    overrides={**{s.name:s.default for s in specs if s.cell in touched}, **saved}
    dump(out/'effective-parameters.json',overrides)
    run = run_notebook(Path(notebook),overrides=overrides)
    run_seconds=time.monotonic()-started
    print('CAStudio: notebook completed '+json.dumps([c.status for c in run.cells]),flush=True)
    print('CAStudio: building scene package',flush=True)
    package=build_product_package(run.product)
    print('CAStudio: encoding scene package',flush=True)
    payload = encode_product_package(package)
    (out/f"{template}.scadpkg").write_bytes(payload)
    import cadflow as cad
    v = run.values
    if template != 'cylinder':
        return build_solid(template, cad, v, run, out, notebook, overrides, started, run_seconds)
    sys.path.insert(0, str(Path(notebook).parent))
    from parametric_common import boundaries, area
    print("CAStudio: writing STEP",flush=True)
    cad.export_step(v["tagged"], str(out/"cylinder.step"))
    print("CAStudio: writing STL",flush=True)
    cad.export_stl(v["tagged"], str(out/"cylinder.stl"))
    groups = boundaries(v["tagged"], v["DIAMETER"]/2, v["HEIGHT"])
    bindings = {name: dict(face_count=len(faces), area_mm2=sum(area(f) for f in faces),
                          shell_set={"interface.fixed_support":"bottom", "interface.axial_load":"top", "interface.external_pressure":"skin"}[name])
                for name, faces in groups.items()}
    print('CAStudio: validating semantic boundaries and CAD equivalence',flush=True)
    validation = equivalent(out/"cylinder.step", reference)
    record = dict(schema_version=1, engine="cadflow 0.2.0",
        source_sha256=hashlib.sha256((out/"cylinder.step").read_bytes()).hexdigest(),
        notebook_sha256=hashlib.sha256(Path(notebook).read_bytes()).hexdigest(),
        parameters={k: x for k,x in v.items() if k.isupper() and isinstance(x,(int,float,bool))},
        bindings=bindings, equivalence=validation,parameter_overrides=overrides,
        cells=[dict(key=c.key, name=c.name, status=c.status) for c in run.cells],
        timings={"notebook_seconds":run_seconds,"total_seconds":time.monotonic()-started})
    dump(out/"cylinder.bindings.json", record)
    print("CASTUDIO_RESULT="+json.dumps(record, ensure_ascii=True), flush=True)


def build_solid(template, cad, v, run, out, notebook, overrides, started, run_seconds):
    """Templates without shell-model boundaries (plate, blank): the notebook's `body` is published as STEP, STL and a build record, after a validity and single-solid check."""
    import time
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    step = out/f"{template}.step"
    print("CAStudio: writing STEP",flush=True)
    cad.export_step(v["body"], str(step))
    print("CAStudio: writing STL",flush=True)
    cad.export_stl(v["body"], str(out/f"{template}.stl"))
    print(f'CAStudio: checking exported {template}',flush=True)
    shape = read_step(step)
    if not BRepCheck_Analyzer(shape).IsValid():
        raise ValueError("Invalid exported CAD")
    it = TopExp_Explorer(shape, TopAbs_SOLID); solids = 0
    while it.More():
        solids += 1; it.Next()
    if solids != 1:
        raise ValueError(f"{template} body must be one connected CAD solid")
    record = dict(schema_version=1, template=template, engine="cadflow 0.2.0",
        source_sha256=hashlib.sha256(step.read_bytes()).hexdigest(),
        notebook_sha256=hashlib.sha256(Path(notebook).read_bytes()).hexdigest(),
        parameters={k: x for k,x in v.items() if k.isupper() and isinstance(x,(int,float,bool))},
        volume_mm3=volume(shape), parameter_overrides=overrides,
        cells=[dict(key=c.key, name=c.name, status=c.status) for c in run.cells],
        timings={"notebook_seconds":run_seconds,"total_seconds":time.monotonic()-started})
    dump(out/f"{template}.build.json", record)
    print("CASTUDIO_RESULT="+json.dumps(record, ensure_ascii=True), flush=True)


def serve(workspace, port, parent, entry):
    print('CAStudio: loading parametric CAD editor runtime',flush=True)
    # The migrated editor lives inside CAStudio; reject cross-site HTTP/WS writes.
    from castudio_runtime.editor import server
    original = server.create_app
    class LocalOnly:
        def __init__(self, app): self.app = app
        async def __call__(self, scope, receive, send):
            if scope['type'] in ('http', 'websocket'):
                headers = dict(scope.get('headers', []))
                origin = headers.get(b'origin', b'').decode()
                host = headers.get(b'host', b'').decode()
                valid_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
                allowed = {f'http://127.0.0.1:{port}', f'http://localhost:{port}', parent}
                if host not in valid_hosts or (origin and origin not in allowed):
                    if scope['type']=='websocket': await send({'type':'websocket.close', 'code':1008})
                    else:
                        await send({'type':'http.response.start','status':403,'headers':[]})
                        await send({'type':'http.response.body','body':b'Local CAStudio requests only'})
                    return
            await self.app(scope,receive,send)
    def create_app(state):
        from starlette.responses import JSONResponse
        from starlette.routing import Route
        from castudio_runtime.runtime.params import read_saved_params
        async def settled(request):
            expected = await request.json()
            if expected.get('notebook') != entry or not state.notebook or state.notebook.name != entry:
                return JSONResponse({'ready': False, 'error': f'请切回 {entry} 后发布'}, status_code=409)
            current = {c['id']: c for c in state.cells}
            checks = [current.get(c['id'], {}).get('code', '').strip() == c['code'].strip() for c in expected.get('cells', [])]
            values = state.snapshot()['parameters']
            checks.extend(values.get(k) == v for k,v in expected.get('parameters', {}).items())
            for item in expected.get('modules', []):
                target = (state.workspace/item['path']).resolve()
                if not target.is_relative_to(state.workspace.resolve()):
                    return JSONResponse({'ready': False, 'error': 'Invalid module'}, status_code=400)
                checks.append(target.read_text(encoding='utf-8') == item['code'])
            busy = state._rebuild_inflight or bool(state._pending_params) or any(c.get('status') in ('running','queued') for c in current.values())
            return JSONResponse({'ready': bool(current) and all(checks) and not busy})
        app = original(state)
        app.router.routes.insert(0, Route('/api/castudio/settled', settled, methods=['POST']))
        return LocalOnly(app)
    server.create_app = create_app
    return server.serve_workspace(Path(workspace), host="127.0.0.1", port=port, open_browser=False,
                                  notebook=Path(workspace)/entry)


if __name__ == '__main__':
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='op',required=True)
    s=sub.add_parser('serve');s.add_argument('workspace');s.add_argument('port',type=int);s.add_argument('parent');s.add_argument('entry')
    b=sub.add_parser('build');b.add_argument('notebook');b.add_argument('output');b.add_argument('template',choices=['cylinder','plate','blank']);b.add_argument('params_from');b.add_argument('--reference')
    v=sub.add_parser('validate');v.add_argument('candidate');v.add_argument('reference');v.add_argument('output')
    a=p.parse_args()
    if a.op=='serve': serve(a.workspace,a.port,a.parent,a.entry)
    elif a.op=='build': build(a.notebook,a.output,a.template,a.params_from,a.reference)
    else: validate(a.candidate,a.reference,a.output)
