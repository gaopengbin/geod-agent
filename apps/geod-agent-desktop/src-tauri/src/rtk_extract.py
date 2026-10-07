"""Extract only the pinned executable from the verified official RTK archive."""
import hashlib, json, stat, sys, zipfile
from pathlib import Path

def extract(archive, destination, member, expected_size, expected_sha):
    root = Path(destination).resolve()
    if any(root.iterdir()): raise ValueError('Staging must be empty')
    with zipfile.ZipFile(archive) as bundle:
        entries = [e for e in bundle.infolist() if e.filename == member]
        if len(entries) != 1: raise ValueError('Executable missing or duplicated')
        entry = entries[0]
        if entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16): raise ValueError('Invalid executable')
        if member != 'rtk.exe' or entry.file_size != int(expected_size): raise ValueError('Unexpected executable size')
        data = bundle.read(entry)
        if hashlib.sha256(data).hexdigest() != expected_sha: raise ValueError('Executable checksum mismatch')
        (root / 'rtk.exe').write_bytes(data)
    return {'extracted': True}

if __name__ == '__main__':
    try: print(json.dumps(extract(*sys.argv[1:])))
    except Exception: print('{"extracted":false}'); sys.exit(1)
