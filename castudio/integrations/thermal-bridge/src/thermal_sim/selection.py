"""Inspection-owned thermal surfaces and physical selection descriptors."""
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


class Selection(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    kind: Literal['point','embedded','face','rectangle']
    face: int | None = Field(default=None,ge=0)
    center_m: list[float] | None = Field(default=None,min_length=3,max_length=3)
    width_m: float | None = Field(default=None,gt=0,le=100)
    height_m: float | None = Field(default=None,gt=0,le=100)
    u_axis: list[float] | None = Field(default=None,min_length=3,max_length=3)
    v_axis: list[float] | None = Field(default=None,min_length=3,max_length=3)


def planar_groups(points,faces):
    """STL has no CAD faces: group only edge-connected coplanar triangles."""
    mesh=trimesh.Trimesh(points,faces,process=False)
    normals=np.asarray(mesh.face_normals);centers=points[faces].mean(axis=1)
    eps=max(float(np.ptp(points,axis=0).max())*1e-6,1e-10)
    parent=np.arange(len(faces))
    def find(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    for a,b in mesh.face_adjacency:
        if normals[a]@normals[b]>1-1e-8 and abs((centers[a]-centers[b])@normals[a])<=eps:
            x,y=find(a),find(b)
            if x!=y:parent[max(x,y)]=min(x,y)
    return np.asarray([find(i) for i in range(len(faces))],int)


def surface_evidence(model,points,faces,outer,source_hash):
    model=Path(model);group_file=model/'surface-groups.json'
    kind='step' if group_file.is_file() else 'stl'
    ids=np.asarray(json.loads(group_file.read_text())['face_groups'],int) if group_file.is_file() else planar_groups(points,faces)
    if len(ids)!=len(faces):raise ValueError('热表面分组数量不一致')
    raw_ids=sorted(set(ids.tolist()));mapping={v:i for i,v in enumerate(raw_ids)}
    ids=np.asarray([mapping[v] for v in ids],dtype='<u4')
    groups=[];scale=max(float(np.ptp(points,axis=0).max()),1e-9);eps=max(scale*1e-6,1e-10)
    tri=points[faces];cross=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]);area=np.linalg.norm(cross,axis=1)/2
    normals=cross/np.maximum(2*area[:,None],1e-30)
    for index in range(len(raw_ids)):
        chosen=np.flatnonzero(ids==index);vertices=tri[chosen].reshape(-1,3)
        normal=normals[chosen[0]];origin=vertices[0]
        planar=bool(np.max(abs((vertices-origin)@normal))<=eps and np.min(normals[chosen]@normal)>1-1e-5)
        axis=np.eye(3)[int(np.argmin(abs(normal)))];u=axis-normal*(axis@normal);u/=np.linalg.norm(u);v=np.cross(normal,u)
        groups.append(dict(id=index,name=f'{"STEP 表面" if kind=="step" else "STL 连通平面"} {index+1}',
            planar=planar,normal=normal.tolist(),u_axis=u.tolist(),v_axis=v.tolist(),
            center_m=vertices.mean(axis=0).tolist(),area_m2=float(area[chosen].sum()),triangles=len(chosen)))
    fingerprint=hashlib.sha256()
    for array,dtype in ((points,'<f4'),(faces,'<u4'),(ids,'<u4'),(outer,'u1')):
        fingerprint.update(np.asarray(array,dtype=dtype).tobytes())
    return dict(schema_version=1,source_sha256=source_hash,surface_sha256=fingerprint.hexdigest(),units='m',kind=kind,
        points=points.ravel().tolist(),faces=faces.ravel().tolist(),face_groups=ids.tolist(),groups=groups,
        bounds_m=[points.min(axis=0).tolist(),points.max(axis=0).tolist()])


def resolve(surface,value):
    from thermal_legacy.geometry import project
    from thermal_legacy.schemas import SurfacePatch
    from thermal_legacy.surface_patch import selected_quadrature
    spec=Selection.model_validate(value).model_dump(exclude_none=True)
    points=np.asarray(surface['points'],float).reshape(-1,3);faces=np.asarray(surface['faces'],int).reshape(-1,3)
    mesh=trimesh.Trimesh(points,faces,process=False);scale=float(np.ptp(points,axis=0).max());eps=max(scale*1e-6,1e-9)
    seed=spec.get('face')
    if seed is not None and seed>=len(faces):raise ValueError('选中的面不属于当前热模型')
    center=np.asarray(spec.get('center_m',points[faces[seed]].mean(axis=0) if seed is not None else []),float)
    if spec['kind'] in ('point','embedded'):
        if center.shape!=(3,):raise ValueError('请指定热源位置')
        closest,distance,nearest=project(mesh,center[None,:])
        if spec['kind']=='embedded':
            if not mesh.contains(center[None,:])[0] and distance[0]>eps:raise ValueError('嵌入热源必须位于实体内部')
        elif distance[0]>eps:raise ValueError('表面点热源必须位于模型表面')
        else:center=closest[0]
        return dict(kind=spec['kind'],position_m=center.tolist(),faces=[int(nearest[0])],area_m2=0,
                    descriptor={**spec,'center_m':center.tolist()})
    if seed is None:raise ValueError('请先点击热模型表面')
    group=int(surface['face_groups'][seed]);record=surface['groups'][group]
    chosen=np.flatnonzero(np.asarray(surface['face_groups'])==group)
    result=dict(kind=spec['kind'],faces=chosen.tolist(),group=group,descriptor=spec)
    if spec['kind']=='face':
        result.update(area_m2=record['area_m2'],center_m=record['center_m'],overlay_points=points[faces[chosen]].ravel().tolist())
        return result
    if not record['planar']:raise ValueError('矩形贴片需要平面，请改用整面选择或点热源')
    normal=np.asarray(record['normal']);origin=np.asarray(record['center_m'])
    if abs((center-origin)@normal)>eps:raise ValueError('矩形中心必须位于选中的平面')
    center=center-normal*((center-origin)@normal)
    patch=SurfacePatch.model_validate(dict(center_m=center.tolist(),u_axis=spec.get('u_axis',record['u_axis']),
        v_axis=spec.get('v_axis',record['v_axis']),width_m=spec.get('width_m'),height_m=spec.get('height_m'))).model_dump()
    if abs(np.cross(patch['u_axis'],patch['v_axis'])@normal)<1-1e-6:raise ValueError('矩形贴片必须贴合选中的平面')
    parent,bary,weight=selected_quadrature(points[faces],points,faces,chosen,patch=patch)
    area=float(weight.sum())
    if area<=1e-20:raise ValueError('矩形贴片与选中表面的交集为空')
    quad=np.einsum('qi,qic->qc',bary,points[faces[parent]])
    rule=np.array([[2/3,1/6,1/6],[1/6,2/3,1/6],[1/6,1/6,2/3]])
    overlay=(np.linalg.inv(rule)@quad.reshape(-1,3,3)).ravel().tolist() if len(quad)%3==0 else []
    result.update(surface_patch=patch,area_m2=area,center_m=center.tolist(),overlay_points=overlay,
                  descriptor={**spec,**patch})
    return result


def validate_config(config,surface,schemas,strict_positions=True):
    """Validate editable conditions without discarding advanced engine fields."""
    cfg=schemas.Simulation.model_validate(config).model_dump()
    points=np.asarray(surface['points'],float).reshape(-1,3);faces=np.asarray(surface['faces'],int).reshape(-1,3)
    from thermal_legacy.surface_patch import selected_quadrature
    for heat in cfg['heat_sources']:
        times=[p['time_s'] for p in heat['power_profile']]
        if len(set(times))!=len(times):raise ValueError('功率曲线不能包含重复时刻')
        if strict_positions and (heat['source_type']=='point' or heat['placement']=='embedded'):
            resolve(surface,dict(kind='embedded' if heat['placement']=='embedded' else 'point',center_m=heat['position_m']))
    for condition in [*cfg['heat_sources'],*cfg['cooling']]:
        selected=condition.get('faces',[])
        if selected and (min(selected)<0 or max(selected)>=len(faces)):raise ValueError('选区不属于当前热表面')
        patch=condition.get('surface_patch')
        if patch:
            chosen=np.asarray(selected,int)
            if not len(chosen):raise ValueError('矩形贴片缺少作用表面')
            normal=np.cross(patch['u_axis'],patch['v_axis']);vertices=points[faces[chosen]].reshape(-1,3)
            tolerance=max(float(np.ptp(points,axis=0).max())*1e-6,1e-9)
            if np.max(abs((vertices-patch['center_m'])@normal))>tolerance:raise ValueError('矩形选区必须位于同一平面')
            if selected_quadrature(points[faces],points,faces,selected,patch=patch)[2].sum()<=1e-20:
                raise ValueError('矩形贴片与指定表面的交集为空')
    return cfg
