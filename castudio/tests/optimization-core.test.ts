import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePolicy,rankCandidate,bindConfig,proposalPrompt,verificationPhase} from '../server/optimization-core.js';
import type {ThermalSurface} from '../shared/thermal.js';
test('policy includes repairs in six total attempts and validates finite limits',()=>{
 const p=resolvePolicy(); assert.equal(p.maxAttempts,6);assert.equal(p.timeBudgetMs,1800000);assert.equal(p.massRatio,1.05);assert.equal(p.maxRepairsPerCandidate,1);assert.equal(p.significantImprovementC,.2);assert.equal(p.stagnationCandidates,3);assert.equal(p.verificationMeshFactor,.75);
 assert.throws(()=>resolvePolicy({maxAttempts:NaN}),/maxAttempts/);assert.throws(()=>resolvePolicy({massRatio:0}),/massRatio/);
});
test('only valid results rank, equal temperatures prefer lower mass',()=>{
 const best={maximumC:60,massKg:1};assert.equal(rankCandidate({maximumC:59,massKg:1.06},best,1,resolvePolicy()),false);
 assert.equal(rankCandidate({maximumC:60,massKg:.9},best,1,resolvePolicy()),true);assert.equal(rankCandidate({maximumC:NaN,massKg:.9},best,1,resolvePolicy()),false);
});

test('fine mesh must confirm significant cooling before accepting the design',()=>{
 assert.equal(verificationPhase(.9,.8,.2),'completed');
 assert.equal(verificationPhase(.9,.05,.2),'unverified');
 assert.equal(verificationPhase(.1,-.01,.2),'unverified');
 assert.equal(verificationPhase(.1,.05,.2),'no_improvement');
});
test('rebinding uses plane position and leaves frozen physics unchanged',async()=>{
 const cfg={base_material:{rho:2700},heat_sources:[{id:'h',watts:360,faces:[99],surface_patch:{center_m:[0,0,0],u_axis:[1,0,0],v_axis:[0,1,0],width_m:1,height_m:1}}],cooling:[],mesh_size_m:.01,ambient_C:40};
 const surface={points:[-1,-1,0,1,-1,0,0,1,0],faces:[0,1,2],face_groups:[7],groups:[{id:7,planar:true,normal:[0,0,1],center_m:[0,0,0]}]} as ThermalSurface;
 const result=await bindConfig(cfg,surface,surface,async selection=>({faces:[0],area_m2:1,kind:'rectangle',descriptor:selection}));
 assert.deepEqual((result.heat_sources as {faces:number[]}[])[0].faces,[0]);assert.equal(result.ambient_C,40);assert.deepEqual(cfg.heat_sources[0].faces,[99]);
 await assert.rejects(()=>bindConfig({...cfg,heat_sources:[{faces:[0],watts:360}]},surface,surface,async()=>{throw Error('unused');}),/矩形/);
});

test('proposal context keeps physics and history without raw surface arrays or old code',()=>{
 const t={baseline:{runId:'r',source:'base.py',sourceHash:'a',buildId:'b',code:'baseline-code',surface:{schema_version:1,source_sha256:'a',surface_sha256:'b',units:'m',kind:'step',bounds_m:[[0,0,0],[1,1,1]],points:Array(1000).fill(1),faces:Array(1000).fill(7),groups:[],face_groups:[]},config:{ambient_C:40,heat_sources:[{power_W:360,faces:Array(1000).fill(5),surface_patch:{center_m:[0,0,0]}}]},geometry:{volumeM3:1,bounds:[],holes:[]},maximumC:80,massKg:1,units:'mm'},candidates:[{id:'old',attempt:1,code:'old-code',rationale:'test',changes:[],state:'invalid',error:'failed'}],policy:resolvePolicy()} as Parameters<typeof proposalPrompt>[0];
 const p=proposalPrompt(t,2);assert.ok(p.length<5000);assert.match(p,/baseline-code/);assert.match(p,/power_W/);assert.match(p,/360/);assert.match(p,/failed/);assert.doesNotMatch(p,/old-code|"points"|"face_groups"|"faces"/);
});



test('rebinding rejects a reversed entity normal even with the same patch axes',async()=>{
 const base={points:[-1,-1,0,1,-1,0,0,1,0],faces:[0,1,2],face_groups:[0],groups:[{id:0,planar:true,normal:[0,0,1],center_m:[0,0,0]}]} as ThermalSurface;
 const flipped=structuredClone(base);flipped.groups[0].normal=[0,0,-1];
 const cfg={heat_sources:[{faces:[0],surface_patch:{center_m:[0,0,0],u_axis:[1,0,0],v_axis:[0,1,0],width_m:1,height_m:1}}]};
 await assert.rejects(()=>bindConfig(cfg,base,flipped,async s=>({faces:[0],area_m2:1,kind:'rectangle',descriptor:s})),/法向|平面/);
});

test('full-plane cooling cannot translate within the same supporting plane',async()=>{
 const base={points:[-1,-1,0,1,-1,0,0,1,0],faces:[0,1,2],face_groups:[0],groups:[{id:0,planar:true,normal:[0,0,1],u_axis:[1,0,0],v_axis:[0,1,0],center_m:[0,0,0],area_m2:2,triangles:1}]} as ThermalSurface;
 const moved=structuredClone(base);moved.points=moved.points.map((v,i)=>i%3===0?v+.01:v);moved.groups[0].center_m=[.01,0,0];
 await assert.rejects(()=>bindConfig({heat_sources:[],cooling:[{faces:[0],h:10}]},base,moved,async s=>({faces:[0],area_m2:2,kind:'face',descriptor:s})),/位置|轮廓|重心/);
});
