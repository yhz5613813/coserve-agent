import test from 'node:test';
import assert from 'node:assert/strict';
import {rectangleOverlay} from '../src/thermal/patch-geometry.js';
import type {ThermalSurface} from '../shared/thermal.js';

test('visible rectangle clips to selected thermal faces and computes the physical area',()=>{
  const surface={points:[-.01,-.01,0,.01,-.01,0,.01,.01,0,-.01,.01,0],faces:[0,1,2,0,2,3]} as ThermalSurface;
  const patch={center_m:[.009,0,0] as [number,number,number],u_axis:[1,0,0] as [number,number,number],v_axis:[0,1,0] as [number,number,number],width_m:.01,height_m:.008};
  const overlay=rectangleOverlay(surface,[0,1],patch);
  assert.ok(Math.abs(overlay.area_m2-.006*.008)<1e-12);
  assert.ok(overlay.points.every(Number.isFinite));
  assert.equal(rectangleOverlay(surface,[],patch).area_m2,0);
  assert.equal(rectangleOverlay(surface,[0,1],{...patch,center_m:[1,0,0]}).points.length,0);
});
