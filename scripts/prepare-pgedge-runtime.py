"""Bundle the pinned official Windows MCP runtime; no desktop installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "vendor/pgedge-postgres-mcp-1.1.0.json"
DESTINATION = ROOT / "apps/geod-agent-desktop/src-tauri/resources/pgedge"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(archive_path=None):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    DESTINATION.mkdir(parents=True, exist_ok=True)
    if not all((DESTINATION / name).is_file() and digest(DESTINATION / name) == sha for name, sha in manifest["files"].items()):
        cache = Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/runtime-cache"
        cache.mkdir(parents=True, exist_ok=True)
        archive = Path(archive_path) if archive_path else cache / manifest["archive"].rsplit("/", 1)[-1]
        if not archive.is_file() or digest(archive) != manifest["archiveSha256"]:
            if archive_path:
                raise SystemExit("pgEdge archive checksum does not match the pinned official release")
            request = urllib.request.Request(manifest["archive"], headers={"User-Agent": "GeoD-Agent-Build"})
            with urllib.request.urlopen(request, timeout=90) as response:
                archive.write_bytes(response.read())
        if digest(archive) != manifest["archiveSha256"]:
            raise SystemExit("pgEdge official release checksum did not match")
        with zipfile.ZipFile(archive) as bundle:
            for name, sha in manifest["files"].items():
                contents = bundle.read(name)
                if hashlib.sha256(contents).hexdigest() != sha:
                    raise SystemExit(f"pgEdge binary/license checksum did not match: {name}")
                (DESTINATION / name).write_bytes(contents)
    (DESTINATION / "postgres-mcp.yaml").write_bytes((ROOT / "apps/geod-agent-desktop/src-tauri/pgedge-config.yaml").read_bytes())
    (DESTINATION / "manifest.json").write_bytes(MANIFEST.read_bytes())
    print(f"Verified builtin pgEdge MCP {manifest['version']}: {DESTINATION}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", help="Reuse an official archive already downloaded and checksum verified")
    prepare(parser.parse_args().archive)
