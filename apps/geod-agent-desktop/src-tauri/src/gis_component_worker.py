"""Extract a verified component into an empty, application-owned staging folder."""
from pathlib import Path, PurePosixPath
import hashlib, json, stat, sys, zipfile

def extract(archive, destination, component_id, manifest_sha):
    destination = Path(destination).resolve()
    if any(destination.iterdir()): raise ValueError('Staging directory must be empty')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 12000: raise ValueError('Too many component files')
        names = [e.filename for e in entries]
        if len(set(names)) != len(names): raise ValueError('Duplicate archive paths')
        manifest_bytes = bundle.read('manifest.json')
        if len(manifest_bytes) > 2_000_000 or hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha:
            raise ValueError('Manifest differs from application catalog')
        manifest = json.loads(manifest_bytes)
        if manifest['id'] != component_id or manifest['version'] != '1.0.0': raise ValueError('Component identity mismatch')
        files = manifest['files']
        if set(names) != set(files) | {'manifest.json'}: raise ValueError('Unlisted component files')
        total = 0
        for entry in entries:
            relative = PurePosixPath(entry.filename)
            if relative.is_absolute() or any(p in {'..', '.'} or ':' in p or '\\' in p for p in relative.parts):
                raise ValueError('Invalid component path')
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode) or entry.is_dir(): raise ValueError('Only regular files are supported')
            total += entry.file_size
            if entry.file_size > 128_000_000 or total > 600_000_000: raise ValueError('Component exceeds extraction limit')
            path = destination / entry.filename
            if not path.resolve().is_relative_to(destination): raise ValueError('Path escaped staging directory')
            data = bundle.read(entry)
            if entry.filename != 'manifest.json' and hashlib.sha256(data).hexdigest() != files[entry.filename]:
                raise ValueError('Component file checksum mismatch')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return {'installed': True, 'files': len(files)}

if __name__ == '__main__':
    try: print(json.dumps(extract(*sys.argv[1:])))
    except Exception: print(json.dumps({'installed': False, 'error': 'GIS_COMPONENT_INVALID'})); sys.exit(1)
