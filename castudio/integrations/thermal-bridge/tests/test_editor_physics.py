import numpy as np
import pytest


def kernel(tmp_path):
    from thermal_sim._backend import load
    return load(tmp_path / 'engine')


def parallel_surfaces():
    points = np.array([[-.01,-.01,0],[.01,-.01,0],[.01,.01,0],[-.01,.01,0],
                       [-.01,-.01,.001],[.01,-.01,.001],[.01,.01,.001],[-.01,.01,.001]])
    return points, np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]])


def test_clipped_heat_never_leaks_to_the_other_side_of_a_thin_plate(tmp_path):
    kernel(tmp_path)
    from thermal_legacy.surface_patch import selected_quadrature
    points, faces = parallel_surfaces()
    parent, bary, weight = selected_quadrature(points[faces], points, faces, [0,1],
        box={'min_m':[-.005,-.005,-.002],'max_m':[.005,.005,.002]})
    assert set(parent) == {0,1}
    assert np.isclose(weight.sum(), .01*.01, rtol=1e-9)
    load = np.bincount(faces[parent].ravel(), weights=(bary*weight[:,None]*95/weight.sum()).ravel(), minlength=8)
    assert np.isclose(load.sum(),95,rtol=1e-12)
    assert not load[4:].any()


def test_tilted_rectangular_patch_has_exact_area_and_local_axes(tmp_path):
    kernel(tmp_path)
    from thermal_legacy.surface_patch import selected_quadrature
    points, faces = parallel_surfaces()
    a=.63
    rotation=np.array([[np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    points=points@rotation.T
    patch={'center_m':[0,0,0],'u_axis':rotation[:,0].tolist(),'v_axis':rotation[:,1].tolist(),
           'width_m':.012,'height_m':.008}
    parent,bary,weight=selected_quadrature(points[faces],points,faces,[0,1],patch=patch)
    assert set(parent)=={0,1}
    assert np.isclose(weight.sum(), .012*.008, rtol=1e-9)
    assert np.allclose(bary.sum(axis=1),1)


def test_patch_axes_and_zero_sizes_are_rejected(tmp_path):
    schemas,*_=kernel(tmp_path)
    from pydantic import ValidationError
    valid={'center_m':[0,0,0],'u_axis':[1,0,0],'v_axis':[0,1,0],'width_m':.01,'height_m':.01}
    schemas.SurfacePatch.model_validate(valid)
    for change in ({'width_m':0},{'u_axis':[2,0,0]},{'v_axis':[1,0,0]}):
        with pytest.raises(ValidationError):
            schemas.SurfacePatch.model_validate({**valid,**change})


def test_boundary_partition_integrates_partial_and_overlapping_cooling_exactly(tmp_path):
    kernel(tmp_path)
    from thermal_legacy.surface_patch import partition_quadrature, patch_inside
    points,faces=parallel_surfaces()
    one={'center_m':[.003,-.002,0],'u_axis':[1,0,0],'v_axis':[0,1,0],'width_m':.01,'height_m':.008}
    two={**one,'center_m':[.005,-.002,0]}
    parent,bary,weight=partition_quadrature(points[faces],[one,two])
    q=np.einsum('qi,qic->qc',bary,points[faces[parent]])
    assert np.isclose(weight.sum(),.02*.02*2,rtol=1e-10)
    h=np.full(len(q),10.)
    h[patch_inside(q,one)]=20
    h[patch_inside(q,two)]=30
    expected=.02*.02*2*10 + .01*.008*10 + .01*.008*20 - .008*.008*10
    assert np.isclose(weight@h,expected,rtol=1e-9)
