import json
import numpy as np
import pytest
from test_editor_physics import kernel, parallel_surfaces


def evidence(tmp_path):
    kernel(tmp_path)
    from thermal_sim.selection import surface_evidence
    points,faces=parallel_surfaces()
    tmp_path.mkdir(exist_ok=True)
    (tmp_path/'surface-groups.json').write_text(json.dumps({'face_groups':[1,1,2,2]}))
    return surface_evidence(tmp_path,points,faces,np.ones(4,bool),'a'*64)


def test_editor_resolves_whole_face_and_clipped_rectangle_with_bound_identity(tmp_path):
    from thermal_sim.selection import resolve
    surface=evidence(tmp_path)
    whole=resolve(surface,{'kind':'face','face':0})
    assert whole['faces']==[0,1]
    rect=resolve(surface,{'kind':'rectangle','face':0,'center_m':[.009,0,0],'width_m':.01,'height_m':.008})
    assert rect['faces']==[0,1]
    assert np.isclose(rect['area_m2'], .006*.008)
    assert len(rect['overlay_points'])>0
    assert len(surface['surface_sha256'])==64
    with pytest.raises(ValueError,match='交集为空'):
        resolve(surface,{'kind':'rectangle','face':0,'center_m':[1,0,0],'width_m':.01,'height_m':.01})
    with pytest.raises(ValueError):resolve(surface,{'kind':'face','face':4})


def test_invalid_point_and_ambiguous_fields_are_rejected(tmp_path):
    from thermal_sim.selection import resolve
    surface=evidence(tmp_path)
    with pytest.raises(ValueError,match='表面'):
        resolve(surface,{'kind':'point','center_m':[0,0,10]})
    with pytest.raises(ValueError):resolve(surface,{'kind':'face','face':0,'made_up':1})
