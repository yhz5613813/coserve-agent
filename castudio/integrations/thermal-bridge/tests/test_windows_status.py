import json
import pytest


@pytest.mark.parametrize('writer',['bridge','kernel'])
def test_status_publication_retries_transient_windows_sharing_errors(tmp_path,monkeypatch,writer):
    from thermal_sim import preview
    if writer=='kernel':
        from thermal_sim._backend import load
        load(tmp_path/'engine')
        from thermal_legacy import runtime as module
    else:
        module=preview
    path=tmp_path/'status.json'
    path.write_text('{"phase":"running"}')
    replace=module.os.replace
    calls=[]
    def sharing_conflict(source,target):
        calls.append(1)
        assert json.loads(path.read_text(encoding="utf-8"))['phase']=='running'
        if len(calls)<3:raise PermissionError(13,'Windows sharing violation')
        replace(source,target)
    monkeypatch.setattr(module.os,'replace',sharing_conflict)
    module.write_json(path,{'phase':'completed'})
    assert len(calls)==3
    assert json.loads(path.read_text(encoding="utf-8"))['phase']=='completed'


def test_permanent_status_write_denial_stays_a_failure(tmp_path,monkeypatch):
    from thermal_sim import preview
    path=tmp_path/'status.json'
    path.write_text('{"phase":"running"}')
    def deny(*_):raise PermissionError(13,'persistent denial')
    monkeypatch.setattr(preview.os,'replace',deny)
    with pytest.raises(PermissionError):preview.write_json(path,{'phase':'completed'})
    assert json.loads(path.read_text(encoding="utf-8"))['phase']=='running'
