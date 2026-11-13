import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const python=process.env.STUDIO_TEST_GMSH_PYTHON;
test('independent numerical scoring reads final solid frame and rejects nonfinite fields',{skip:!python},()=>{
 const result=execFileSync(python!,['-c',`import importlib.util,tempfile,pathlib,numpy as np
s=importlib.util.spec_from_file_location('checks',r'${path.resolve('resources/optimization/checks.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=pathlib.Path(tempfile.mkdtemp())/'temperatures.npy';np.save(p,np.array([[200.,150.],[40.,65.]]));assert m.final_temperature(p)==65
np.save(p,np.array([[40.,float('nan')]]))
try:m.final_temperature(p);raise AssertionError('accepted nan')
except ValueError:pass
print('ok')`],{encoding:'utf8'});assert.match(result,/ok/);
});

test('candidate validator rejects filesystem and reflection while accepting numeric Gmsh',{skip:!python},()=>{
 const script=`import importlib.util,tempfile,pathlib
s=importlib.util.spec_from_file_location('checks',r'${path.resolve('resources/optimization/checks.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=pathlib.Path(tempfile.mkdtemp())/'candidate.py'
for code in ["import gmsh\\nfrom pathlib import Path\\nPath('C:/outside').write_text('x')", "import gmsh\\nopen('C:/outside','w')", "import gmsh\\ngetattr(gmsh,'open')('outside.step')", "import gmsh\\ngmsh.write('C:/outside.step')", "import gmsh\\ngmsh.initialize(['-log','C:/outside'])", "import gmsh\\nx=gmsh.__dict__", "import gmsh\\ngmsh.model.occ.importShapes('baseline.step')", "import gmsh\\nsorted(['malicious'],key=eval)", "import gmsh\\nsorted(['C:/outside.step'],key=gmsh.write)", "import gmsh\\nsorted(['outside'],key=eval)\\neval=0", "import gmsh\\neval('outside')\\ndef eval(x):\\n return 0"]:
 p.write_text(code.replace('\\\\n','\\n'))
 try:m.validate_candidate(p);raise AssertionError('accepted '+code)
 except ValueError:pass
p.write_text("import gmsh\\nimport math\\ndef make(x):\\n return gmsh.model.occ.addBox(x,0,0,10,10,2)\\ngmsh.initialize(interruptible=False)\\nfor x in range(2):\\n make(x*10)\\ngmsh.model.occ.synchronize()\\ngmsh.write('model.step')\\ngmsh.finalize()\\n")
assert m.validate_candidate(p)['selfContained'];print('ok')`;
 assert.match(execFileSync(python!,['-c',script],{encoding:'utf8'}),/ok/);
});

test('independent STEP inspection rejects a bridge obstructing a mounting hole',{skip:!python},()=>{
 const script=`import importlib.util,tempfile,pathlib,gmsh
s=importlib.util.spec_from_file_location('checks',r'${path.resolve('resources/optimization/checks.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=pathlib.Path(tempfile.mkdtemp())
for obstruction in [False,True]:
 gmsh.initialize();gmsh.option.setNumber('General.Terminal',0)
 b=gmsh.model.occ.addBox(0,0,0,20,20,5);h=gmsh.model.occ.addCylinder(10,10,0,0,0,5,2)
 solid,_=gmsh.model.occ.cut([(3,b)],[(3,h)])
 if obstruction:
  bar=gmsh.model.occ.addBox(7,9.5,2,6,1,1);gmsh.model.occ.fuse(solid,[(3,bar)])
 gmsh.model.occ.synchronize();f=root/('blocked.step' if obstruction else 'base.step');gmsh.write(str(f));gmsh.finalize()
 if not obstruction:assert len(m.geometry(f,'mm')['holes'])==1
 else:
  try:m.geometry(f,'mm');raise AssertionError('accepted blocked mounting hole')
  except ValueError:pass
print('ok')`;
 assert.match(execFileSync(python!,['-c',script],{encoding:'utf8'}),/ok/);
});

test('orphan process check refuses a matching work UUID until the process exits',{skip:!python},()=>{
 const script=`import importlib.util,tempfile,pathlib,subprocess,sys,time,json
s=importlib.util.spec_from_file_location('checks',r'${path.resolve('resources/optimization/checks.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=pathlib.Path(tempfile.mkdtemp());work=root/'thermal-work'/'12345678-1234-1234-1234-123456789abc';request=root/'request.json';request.write_text(json.dumps([str(work)]))
p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)',str(work)])
try:
 time.sleep(.2);r=m.process_clear(request);assert not r['clear'] and p.pid in r['pids']
finally:p.terminate();p.wait()
assert m.process_clear(request)['clear'];print('ok')`;
 assert.match(execFileSync(python!,['-c',script],{encoding:'utf8'}),/ok/);
});


test('STEP embedded units determine mass independently of the STL unit selection',{skip:!python},()=>{
 const script=`import importlib.util,tempfile,pathlib,gmsh,numpy as np
s=importlib.util.spec_from_file_location('checks',r'${path.resolve('resources/optimization/checks.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temporary:
 p=pathlib.Path(temporary)/'model.step'
 gmsh.initialize();gmsh.option.setNumber('General.Terminal',0);gmsh.model.occ.addBox(0,0,0,20,20,5);gmsh.model.occ.synchronize();gmsh.write(str(p));gmsh.finalize()
 measurements=[m.geometry(p,unit) for unit in ['mm','cm','m']]
 for value in measurements:
  assert abs(value['volumeM3']-2e-6)<1e-12,value
  assert np.allclose(value['bounds'],measurements[0]['bounds'])
print('ok')`;
 assert.match(execFileSync(python!,['-c',script],{encoding:'utf8'}),/ok/);
});
