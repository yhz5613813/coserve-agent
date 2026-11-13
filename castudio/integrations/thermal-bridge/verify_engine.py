"""Verify the pinned patched checkout, then write the bridge's source marker."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve(strict=True)
metadata = json.loads(Path(__file__).with_name('engine.json').read_text(encoding='utf-8'))
head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
if head != metadata['commit']:
    raise SystemExit('Engine checkout does not match engine.json')
for item in metadata['patchedFiles']:
    file = (root / item['path']).resolve(strict=True)
    if not file.is_relative_to(root):
        raise SystemExit('Engine file escapes its checkout')
    actual = hashlib.sha256(file.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
    if actual != item['sha256']:
        raise SystemExit('Engine patch mismatch: ' + item['path'])
(root / '.coserve-source.json').write_text(json.dumps({
    'Commit': metadata['commit'], 'Repository': metadata['repository'],
}, indent=2) + '\n', encoding='utf-8')
print('Verified pinned engine and all seven patched files; source marker written.')
