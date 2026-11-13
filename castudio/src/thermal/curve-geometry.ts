type Matrix={a:number;b:number;c:number;d:number;e:number;f:number};
type PowerPoint={time_s:number;power_W:number};

export function insertPowerPoint(points:PowerPoint[],end:number):PowerPoint[]{
  const sorted=[...points].sort((a,b)=>a.time_s-b.time_s);
  if(!sorted.length)return [];
  if(sorted.length===1)return [...sorted,{time_s:Math.max(end,sorted[0].time_s+1),power_W:sorted[0].power_W}];
  let i=0;for(let j=1;j<sorted.length-1;j++)if(sorted[j+1].time_s-sorted[j].time_s>sorted[i+1].time_s-sorted[i].time_s)i=j;
  const left=sorted[i],right=sorted[i+1];
  return [...sorted.slice(0,i+1),{time_s:(left.time_s+right.time_s)/2,power_W:(left.power_W+right.power_W)/2},...sorted.slice(i+1)];
}

// SVG screen CTM includes preserveAspectRatio letterboxing as well as scaling.
export function plotPoint(clientX:number,clientY:number,matrix:Matrix):{x:number;y:number}{
  const determinant=matrix.a*matrix.d-matrix.b*matrix.c;
  const x=clientX-matrix.e,y=clientY-matrix.f;
  return {x:(matrix.d*x-matrix.c*y)/determinant,y:(matrix.a*y-matrix.b*x)/determinant};
}
