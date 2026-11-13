import type {SurfacePatch,ThermalSurface,Vec3} from '../../shared/thermal';
export const add=(a:Vec3,b:Vec3):Vec3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
export const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const scale=(a:Vec3,s:number):Vec3=>[a[0]*s,a[1]*s,a[2]*s];
export const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function rectangleCorners(patch:SurfacePatch):Vec3[]{
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>add(patch.center_m,add(scale(patch.u_axis,x*patch.width_m/2),scale(patch.v_axis,y*patch.height_m/2))));
}
export function rectangleOverlay(surface:Pick<ThermalSurface,'points'|'faces'>,selected:number[],patch:SurfacePatch){
  const out:number[]=[];let area=0;
  const normal=cross(patch.u_axis,patch.v_axis),eps=Math.max(patch.width_m,patch.height_m)*1e-7;
  for(const face of selected){
    let polygon:Vec3[]=[0,1,2].map(i=>surface.points.slice(surface.faces[face*3+i]*3,surface.faces[face*3+i]*3+3) as Vec3);
    if(polygon.some(point=>Math.abs(dot(sub(point,patch.center_m),normal))>Math.max(eps,1e-9)))continue;
    for(const [axis,half] of [[patch.u_axis,patch.width_m/2],[patch.v_axis,patch.height_m/2]] as [Vec3,number][]){
      for(const sign of [-1,1]){
        const clipped:Vec3[]=[];
        for(let i=0;i<polygon.length;i++){
          const p=polygon[i],q=polygon[(i+1)%polygon.length],a=half-sign*dot(sub(p,patch.center_m),axis),b=half-sign*dot(sub(q,patch.center_m),axis);
          if(a>=-1e-12)clipped.push(p);
          if((a>=-1e-12)!==(b>=-1e-12))clipped.push(add(p,scale(sub(q,p),a/(a-b))));
        }
        polygon=clipped;
      }
    }
    for(let i=1;i<polygon.length-1;i++){
      const triangle=[polygon[0],polygon[i],polygon[i+1]],n=cross(sub(triangle[1],triangle[0]),sub(triangle[2],triangle[0]));
      const size=Math.hypot(...n)/2;if(size>1e-22){area+=size;out.push(...triangle.flat());}
    }
  }
  return {points:out,area_m2:area};
}
