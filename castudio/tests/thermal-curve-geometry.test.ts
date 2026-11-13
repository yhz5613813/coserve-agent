import test from 'node:test';
import assert from 'node:assert/strict';
import {plotPoint,insertPowerPoint} from '../src/thermal/curve-geometry.js';

test('power curve drag respects centered SVG letterboxing in a wide panel',()=>{
  const matrix={a:1.25,b:0,c:0,d:1.25,e:723,f:600};
  const start=plotPoint(723+278*1.25,600+37.5*1.25,matrix);
  const moved=plotPoint(723+278*1.25,600+57.5*1.25,matrix);
  assert.deepEqual(start,{x:278,y:37.5});
  assert.equal(moved.x,start.x);
  assert.equal(moved.y-start.y,20);
});
test('a valid one-point power profile can add a distinct later point',()=>{
  assert.deepEqual(insertPowerPoint([{time_s:12,power_W:5}],20),[{time_s:12,power_W:5},{time_s:20,power_W:5}]);
  assert.deepEqual(insertPowerPoint([{time_s:12,power_W:5}],10),[{time_s:12,power_W:5},{time_s:13,power_W:5}]);
});
test('power curve drag maps a narrow scaled plot to its viewBox',()=>{
  const point=plotPoint(100+398*.6,200+20*.6,{a:.6,b:0,c:0,d:.6,e:100,f:200});
  assert.ok(Math.abs(point.x-398)<1e-10);
  assert.ok(Math.abs(point.y-20)<1e-10);
});
