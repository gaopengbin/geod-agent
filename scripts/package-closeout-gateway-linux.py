"""Run inside the local Linux builder, preserving npm's Linux symbolic links."""
from pathlib import Path
import hashlib
import json
import tarfile

stage = Path('/candidate')
archive = stage / 'gateway-linux-x64.tar.gz'
assert not archive.exists(), 'Preserve previous archive'
files, links = {}, {}
with tarfile.open(archive, 'w:gz', dereference=False) as tar:
    for root in [stage/'services', stage/'packages']:
        for file in [root, *sorted(root.rglob('*'))]:
            relative = file.relative_to(stage)
            if 'test' in relative.parts:
                continue
            assert file.resolve().is_relative_to(stage), 'Do not package external symbolic links'
            if file.is_symlink():
                links[relative.as_posix()] = str(file.readlink())
            elif file.is_file():
                if 'node_modules' not in relative.parts:
                    assert file.suffix not in {'.env', '.sqlite', '.db', '.pem', '.key'}
                with file.open('rb') as stream:
                    files[relative.as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
            tar.add(file, arcname=relative.as_posix(), recursive=False)
assert any(name.endswith('better_sqlite3.node') for name in files)
(stage/'linux-files.json').write_text(json.dumps({'files':files,'symlinks':links}),encoding='utf-8')
print(json.dumps({'packaged':True,'files':len(files),'symlinks':len(links)}))
