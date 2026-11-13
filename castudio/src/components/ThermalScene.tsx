import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TransformControls} from 'three/addons/controls/TransformControls.js';
import type {MutableRefObject} from 'react';
import type {ThermalSelection,ThermalSurface,SurfacePatch,Vec3} from '../../shared/thermal';
import {rectangleCorners,rectangleOverlay,add,sub,scale,dot,cross} from '../thermal/patch-geometry';

export type ThermalPose={position:Vec3;target:Vec3;up:Vec3;source?:string};
export type ThermalOverlay={id:string;name:string;color:string;faces:number[];position?:Vec3;patch?:SurfacePatch;embedded?:boolean;radius?:number};
type Props={identity:string;sourceHash?:string;surface:Pick<ThermalSurface,'points'|'faces'>;pose?:MutableRefObject<ThermalPose|null>;
  field?:{values:Float32Array;min:number;max:number};overlays?:ThermalOverlay[];activeId?:string;
  tool?:'orbit'|'place';disabled?:boolean;onSelect?:(id:string)=>void;
  onPlace?:(face:number,point:Vec3)=>void;onCommit?:(selection:ThermalSelection)=>void;
  onPreview?:(selection:ThermalSelection|null)=>void;onError?:(message:string)=>void};

/** Shared, demand-rendered thermal scene; all coordinates remain in metres. */
export function ThermalScene(props:Props){
  const host=useRef<HTMLDivElement>(null),latest=useRef(props);latest.current=props;
  const engine=useRef<{paint:()=>void;overlays:()=>void;view:(direction:string)=>void}|null>(null),[ready,setReady]=useState(0);
  useEffect(()=>{
    const target=host.current!;let disposed=false;let cleanup=()=>{};
    try{
      const {surface}=latest.current,vertices=surface.points.length/3;
      if(!vertices||surface.points.length%3||!surface.points.every(Number.isFinite)||!surface.faces.length||surface.faces.length%3||!surface.faces.every(v=>Number.isInteger(v)&&v>=0&&v<vertices))throw new Error('热表面网格无效');
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(surface.points,3));geometry.setIndex(surface.faces);geometry.computeVertexNormals();geometry.computeBoundingBox();
      const colors=new Float32Array(vertices*3);geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
      const material=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide});
      const mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.background=new THREE.Color('#171b22');scene.add(mesh);
      const overlayRoot=new THREE.Group();scene.add(overlayRoot);
      const bounds=geometry.boundingBox!,center=bounds.getCenter(new THREE.Vector3()),span=Math.max(bounds.getSize(new THREE.Vector3()).length(),1e-6);
      const camera=new THREE.PerspectiveCamera(40,1,span/10000,span*100);camera.up.set(0,0,1);camera.position.copy(center).add(new THREE.Vector3(span,-span,span*.8));
      const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));target.appendChild(renderer.domElement);
      const controls=new OrbitControls(camera,renderer.domElement);controls.target.copy(center);
      if(latest.current.pose?.current&&latest.current.pose.current.source===latest.current.sourceHash){const pose=latest.current.pose.current;camera.position.fromArray(pose.position);camera.up.fromArray(pose.up);controls.target.fromArray(pose.target);}
      controls.update();
      const transform=new TransformControls(camera,renderer.domElement);transform.setMode('translate');transform.setSpace('world');transform.size=.65;scene.add(transform.getHelper());
      const ray=new THREE.Raycaster(),pointer=new THREE.Vector2(),plane=new THREE.Plane();
      const color=new THREE.Color();let drag:{overlay:ThermalOverlay;corner:number;start:Vec3;selection?:ThermalSelection;pointerId:number}|null=null;
      let down:{x:number;y:number}|null=null,embeddedStart:Vec3|null=null,frameId=0;
      const render=()=>{if(!disposed)renderer.render(scene,camera);};
      const remember=()=>{if(latest.current.pose)latest.current.pose.current={position:camera.position.toArray() as Vec3,target:controls.target.toArray() as Vec3,up:camera.up.toArray() as Vec3,source:props.sourceHash};render();};
      controls.addEventListener('change',remember);
      const rayAt=(event:PointerEvent)=>{const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);};
      const clearOverlays=()=>{transform.detach();overlayRoot.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.Line){object.geometry.dispose();(Array.isArray(object.material)?object.material:[object.material]).forEach(item=>item.dispose());}});overlayRoot.clear();};
      const dotMarker=(position:Vec3,radius:number,ink:string,data:Record<string,unknown>)=>{
        const mark=new THREE.Mesh(new THREE.SphereGeometry(radius,14,10),new THREE.MeshBasicMaterial({color:ink,depthTest:false,transparent:true,opacity:.95}));mark.position.fromArray(position);mark.userData=data;mark.renderOrder=5;overlayRoot.add(mark);return mark;
      };
      const drawOverlays=(preview?:{id:string;selection:ThermalSelection})=>{
        if(transform.dragging)return;
        clearOverlays();
        for(const saved of latest.current.overlays||[]){
          const overlay={...saved};
          if(preview?.id===overlay.id){if(overlay.patch)overlay.patch={...overlay.patch,...preview.selection} as SurfacePatch;else if(preview.selection.center_m)overlay.position=preview.selection.center_m;}
          const active=overlay.id===latest.current.activeId,positions=overlay.patch?rectangleOverlay(surface,overlay.faces,overlay.patch).points:overlay.faces.flatMap(face=>[0,1,2].flatMap(i=>surface.points.slice(surface.faces[face*3+i]*3,surface.faces[face*3+i]*3+3)));
          if(positions.length){
            const region=new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(positions,3)),new THREE.MeshBasicMaterial({color:overlay.color,transparent:true,opacity:active ? .6 : .12,side:THREE.DoubleSide,depthTest:false,depthWrite:false}));region.userData={id:overlay.id,role:'region'};region.renderOrder=active?3:1;overlayRoot.add(region);
          }
          let position=overlay.patch?.center_m||overlay.position;
          if(!position&&overlay.faces.length){const bb=new THREE.Box3();for(const f of overlay.faces)for(let i=0;i<3;i++)bb.expandByPoint(new THREE.Vector3().fromArray(surface.points,surface.faces[f*3+i]*3));position=bb.getCenter(new THREE.Vector3()).toArray() as Vec3;}
          if(!position)continue;
          const mark=dotMarker(position,span*.012,overlay.color,{id:overlay.id,role:'center'});
          if(active&&overlay.embedded&&!latest.current.disabled&&latest.current.tool!=='place'){transform.attach(mark);transform.enabled=true;}
          if(active&&overlay.patch){
            const corners=rectangleCorners(overlay.patch),line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners.map(p=>new THREE.Vector3(...p))),new THREE.LineBasicMaterial({color:overlay.color,depthTest:false}));line.renderOrder=4;overlayRoot.add(line);
            if(!latest.current.disabled)corners.forEach((p,i)=>dotMarker(p,span*.009,'#f4f4f4',{id:overlay.id,role:'corner',corner:i}));
          }
          if(active&&overlay.radius){const shell=new THREE.Mesh(new THREE.SphereGeometry(overlay.radius,24,16),new THREE.MeshBasicMaterial({color:overlay.color,wireframe:true,transparent:true,opacity:.2,depthTest:false}));shell.position.fromArray(position);overlayRoot.add(shell);}
        }
        render();
      };
      const paint=()=>{
        const field=latest.current.field;
        if(field&&field.values.length!==vertices)throw new Error('温度场与热表面顶点数量不一致');
        for(let i=0;i<vertices;i++){
          if(field){const fraction=Math.max(0,Math.min(1,(field.values[i]-field.min)/Math.max(field.max-field.min,1e-8)));color.setHSL((1-fraction)*.66,1,.5);}else color.set('#96a4b7');
          color.toArray(colors,i*3);
        }
        geometry.attributes.color.needsUpdate=true;render();
      };
      const cancelDrag=()=>{
        if(drag){try{renderer.domElement.releasePointerCapture(drag.pointerId);}catch{}drag=null;}
        if(transform.dragging)transform.reset();embeddedStart=null;controls.enabled=true;latest.current.onPreview?.(null);drawOverlays();
      };
      const pointerDown=(event:PointerEvent)=>{
        if(event.button!==0)return;down={x:event.clientX,y:event.clientY};
        if(latest.current.disabled)return;
        if(latest.current.tool==='place'){controls.enabled=false;event.stopImmediatePropagation();return;}
        if(transform.axis)return;
        rayAt(event);const hit=ray.intersectObjects(overlayRoot.children,true).find(hit=>hit.object.userData.id);
        if(!hit)return;
        const overlay=latest.current.overlays?.find(row=>row.id===hit.object.userData.id);if(!overlay)return;
        if(overlay.id!==latest.current.activeId){latest.current.onSelect?.(overlay.id);return;}
        if(overlay.embedded||(!overlay.position&&!overlay.patch)||hit.object.userData.role==='region')return;
        const normal=overlay.patch?cross(overlay.patch.u_axis,overlay.patch.v_axis):[0,0,1] as Vec3;
        const origin=overlay.patch?.center_m||overlay.position!;plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(...normal),new THREE.Vector3(...origin));
        const at=ray.ray.intersectPlane(plane,new THREE.Vector3());
        drag={overlay,corner:hit.object.userData.role==='corner'?Number(hit.object.userData.corner):-1,start:(at?.toArray()||origin) as Vec3,pointerId:event.pointerId};
        renderer.domElement.setPointerCapture(event.pointerId);controls.enabled=false;event.stopImmediatePropagation();
      };
      const pointerMove=(event:PointerEvent)=>{
        if(!drag)return;rayAt(event);const row=drag.overlay;let selection:ThermalSelection|undefined;
        if(row.patch){
          const at=ray.ray.intersectPlane(plane,new THREE.Vector3());if(!at)return;
          const patch={...row.patch};
          if(drag.corner<0)patch.center_m=add(patch.center_m,sub(at.toArray() as Vec3,drag.start));
          else{
            const [x,y]=[[-1,-1],[1,-1],[1,1],[-1,1]][drag.corner];
            const fixed=add(patch.center_m,add(scale(patch.u_axis,-x*patch.width_m/2),scale(patch.v_axis,-y*patch.height_m/2)));
            const delta=sub(at.toArray() as Vec3,fixed);
            patch.width_m=Math.max(span*1e-5,Math.min(100,x*dot(delta,patch.u_axis)));patch.height_m=Math.max(span*1e-5,Math.min(100,y*dot(delta,patch.v_axis)));
            patch.center_m=add(fixed,add(scale(patch.u_axis,x*patch.width_m/2),scale(patch.v_axis,y*patch.height_m/2)));
          }
          selection={kind:'rectangle',...patch};
        }else{
          const hit=ray.intersectObject(mesh,false)[0];if(hit)selection={kind:'point',face:hit.faceIndex!,center_m:hit.point.toArray() as Vec3};
        }
        if(!selection)return;drag.selection=selection;latest.current.onPreview?.(selection);
        cancelAnimationFrame(frameId);frameId=requestAnimationFrame(()=>{if(drag?.selection)drawOverlays({id:row.id,selection:drag.selection});});
      };
      const pointerUp=(event:PointerEvent)=>{
        if(drag){const selection=drag.selection;cancelDrag();if(selection)latest.current.onCommit?.(selection);down=null;return;}
        controls.enabled=true;
        if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>4){down=null;return;}down=null;
        if(latest.current.disabled||latest.current.tool!=='place'||transform.axis)return;
        rayAt(event);const hit=ray.intersectObject(mesh,false)[0];if(hit)latest.current.onPlace?.(hit.faceIndex!,hit.point.toArray() as Vec3);
      };
      const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')cancelDrag();};
      transform.addEventListener('dragging-changed',event=>{controls.enabled=!event.value;});
      transform.addEventListener('change',render);
      transform.addEventListener('mouseDown',()=>{embeddedStart=(transform.object?.position.toArray() as Vec3)||null;});
      transform.addEventListener('objectChange',()=>{if(transform.object){latest.current.onPreview?.({kind:'embedded',center_m:transform.object.position.toArray() as Vec3});render();}});
      transform.addEventListener('mouseUp',()=>{
        const position=transform.object?.position.toArray() as Vec3|undefined;
        if(position&&embeddedStart){embeddedStart=null;latest.current.onCommit?.({kind:'embedded',center_m:position});}latest.current.onPreview?.(null);
      });
      renderer.domElement.addEventListener('pointerdown',pointerDown,true);renderer.domElement.addEventListener('pointermove',pointerMove,true);renderer.domElement.addEventListener('pointerup',pointerUp,true);renderer.domElement.addEventListener('pointercancel',cancelDrag);window.addEventListener('keydown',escape);
      const resize=new ResizeObserver(()=>{if(target.clientWidth<2||target.clientHeight<2)return;renderer.setSize(target.clientWidth,target.clientHeight);camera.aspect=target.clientWidth/target.clientHeight;camera.updateProjectionMatrix();render();});resize.observe(target);
      cleanup=()=>{remember();resize.disconnect();cancelAnimationFrame(frameId);window.removeEventListener('keydown',escape);renderer.domElement.removeEventListener('pointerdown',pointerDown,true);renderer.domElement.removeEventListener('pointermove',pointerMove,true);renderer.domElement.removeEventListener('pointerup',pointerUp,true);renderer.domElement.removeEventListener('pointercancel',cancelDrag);clearOverlays();transform.dispose();controls.dispose();geometry.dispose();material.dispose();renderer.dispose();renderer.domElement.remove();};
      engine.current={paint,overlays:()=>drawOverlays(),view:direction=>{
        const offset=direction==='top'?new THREE.Vector3(0,0,span*1.9):direction==='bottom'?new THREE.Vector3(0,0,-span*1.9):direction==='front'?new THREE.Vector3(0,-span*1.9,0):new THREE.Vector3(span,-span,span*.8);
        camera.up.set(0,direction==='top'||direction==='bottom'?1:0,direction==='top'||direction==='bottom'?0:1);camera.position.copy(center).add(offset);controls.target.copy(center);controls.update();remember();
      }};paint();drawOverlays();setReady(value=>value+1);
    }catch(error){latest.current.onError?.((error as Error).message);cleanup();}
    return()=>{disposed=true;engine.current=null;cleanup();};
  },[props.identity]);
  useEffect(()=>{try{engine.current?.paint();}catch(error){props.onError?.((error as Error).message);}},[props.field,ready]);
  useEffect(()=>{engine.current?.overlays();},[props.overlays,props.activeId,props.disabled,props.tool,ready]);
  return <div className="thermal-stage"><div className="thermal-canvas thermal-scene" ref={host} aria-label="热工况三维编辑视口"/>
    <div className="thermal-scene-views" role="toolbar" aria-label="热模型视角">{[['bottom','底视'],['top','俯视'],['front','前视'],['fit','适应视图']].map(([direction,label])=><button className="button" key={direction} onClick={()=>engine.current?.view(direction)}>{label}</button>)}</div>
  </div>;
}
