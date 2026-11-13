import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createApp} from '../server/app.js';
import {jsonWrite} from '../server/storage.js';

async function fixture(python?: string) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gmsh-build-'));
  const services=await createApp(root), project=await services.store.createProject('Gmsh build');
  // A Gmsh build must use its explicitly configured environment, not this CAD interpreter.
  await jsonWrite(path.join(root,'runtime.json'),{executable:path.join(root,'unavailable-cad-python.exe')});
  if(python) await jsonWrite(path.join(root,'thermal-runtime.json'),{executable:python,device:'cuda'});
  const server=createServer(services.app); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/builds`;
  const source='model.py', expectedSource='print("engine selection")\n';
  await fs.writeFile(path.join(services.store.workspace(project.id),source),expectedSource);
  return {root,...services,project,base,source,expectedSource,
    post:(url:string,body:unknown)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    close:async()=>{await services.builds.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}};
}

test('unsupported build engines and unconfigured Gmsh runtime fail before creating a job',async()=>{
  const f=await fixture();try {
    const input={source:f.source,expectedSource:f.expectedSource};
    assert.equal((await f.post(f.base,{...input,engine:'unknown'})).status,400);
    assert.equal((await f.post(f.base,{...input,engine:'gmsh'})).status,422);
    assert.deepEqual(await f.builds.list(f.project.id),[]);
  } finally {await f.close();}
});

test('explicit Gmsh build exports and publishes a verified plate with a through hole',
  {skip:!process.env.STUDIO_TEST_GMSH_PYTHON},async()=>{
  const f=await fixture(process.env.STUDIO_TEST_GMSH_PYTHON);try {
    const script=`import gmsh, json, math\nfrom pathlib import Path\ngmsh.initialize(interruptible=False)\ntry:\n gmsh.model.add('perforated plate')\n box=gmsh.model.occ.addBox(0,0,0,80,50,8)\n hole=gmsh.model.occ.addCylinder(40,25,-1,0,0,10,5)\n gmsh.model.occ.cut([(3,box)],[(3,hole)])\n gmsh.model.occ.synchronize()\n solids=gmsh.model.getEntities(3)\n volume=sum(gmsh.model.occ.getMass(d,t) for d,t in solids)\n assert len(solids)==1 and abs(volume-(80*50*8-math.pi*25*8))<1e-5\n gmsh.write('plate.step')\n gmsh.clear()\n gmsh.model.occ.importShapes('plate.step')\n gmsh.model.occ.synchronize()\n reopened=sum(gmsh.model.occ.getMass(d,t) for d,t in gmsh.model.getEntities(3))\n assert abs(reopened-volume)<1e-5\n Path('geometry.json').write_text(json.dumps({'engine':'gmsh','volume_mm3':volume,'reopened_volume_mm3':reopened}))\nfinally:\n gmsh.finalize()\n`;
    await fs.writeFile(path.join(f.store.workspace(f.project.id),f.source),script);
    const response=await f.post(f.base,{source:f.source,expectedSource:script,engine:'gmsh'});
    assert.equal(response.status,202);const started=await response.json();
    let run=started;const deadline=Date.now()+30000;
    while(['preparing','running'].includes(run.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,100));run=await f.builds.read(f.project.id,started.id);}
    assert.equal(run.state,'succeeded',run.log);assert.equal(run.engine,'gmsh');
    assert.equal(run.executable,process.env.STUDIO_TEST_GMSH_PYTHON);
    const saved=await f.post(`${f.base}/${run.id}/publish`,{});assert.equal(saved.status,200);
    const output=path.join(f.store.workspace(f.project.id),(await saved.json()).path);
    assert.match(await fs.readFile(path.join(output,'plate.step'),'utf8'),/ISO-10303-21/);
    const geometry=JSON.parse(await fs.readFile(path.join(output,'geometry.json'),'utf8'));
    assert(Math.abs(geometry.volume_mm3-(32000-Math.PI*200))<1e-5);
    const manifest=JSON.parse(await fs.readFile(path.join(output,'studio-build-manifest.json'),'utf8'));
    assert.equal(manifest.engine,'gmsh');
    assert.equal(await fs.readFile(path.join(f.store.workspace(f.project.id),f.source),'utf8'),script);
  } finally {await f.close();}
});
