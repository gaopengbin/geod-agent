"""Prepare a verified Windows runtime for bundling; never installs the desktop."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import PurePosixPath

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "vendor/codex-runtime-0.159.2-windows-x64.json").read_text(encoding="utf-8"))
version = manifest["codexVersion"]
destination = root / "apps/geod-agent-desktop/src-tauri/resources/codex"
cache = Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/runtime-cache"
destination.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)

def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "GeoD-Agent-Build"}), timeout=60) as response:
        return response.read()

def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

installed = sorted((Path(os.environ["LOCALAPPDATA"]) / "OpenAI/Codex/bin").glob("*/codex.exe"))
installed_root = installed[-1].parent if installed else None

def save_verified(target, contents, expected):
    if hashlib.sha256(contents).hexdigest() != expected:
        raise SystemExit(f"Pinned official checksum did not match: {target.name}")
    temporary = target.with_suffix(target.suffix + ".download")
    temporary.write_bytes(contents)
    temporary.replace(target)

def node_archive():
    archive = cache / manifest["nodeArchive"].rsplit("/", 1)[-1]
    if not archive.is_file() or digest(archive) != manifest["nodeArchiveSha256"]:
        save_verified(archive, fetch(manifest["nodeArchive"]), manifest["nodeArchiveSha256"])
    return archive

# The pins were recorded from the accepted official releases. Verify every file,
# including licenses, without depending on a release API or selecting a newer
# version during a build. Missing or changed files still require matching pins.
for name, specification in manifest["files"].items():
    target = destination / name
    expected = specification["sha256"]
    if target.is_file() and digest(target) == expected:
        print(f"Verified cached {name}", flush=True)
        continue
    local = installed_root / name if installed_root else None
    if local and local.is_file() and digest(local) == expected:
        shutil.copy2(local, target)
    elif "archiveMember" in specification:
        with zipfile.ZipFile(node_archive()) as bundle:
            save_verified(target, bundle.read(specification["archiveMember"]), expected)
    else:
        save_verified(target, fetch(specification["source"]), expected)
    if digest(target) != expected:
        raise SystemExit(f"Prepared runtime checksum did not match: {name}")
    print(f"Verified {name}", flush=True)

# npm and npx come from the same checksum-pinned official Node distribution.
# Keep their dependencies and licenses intact, and inventory every shipped file.
npm_root = destination / "npm"
prefix = manifest["npmArchivePrefix"]
with zipfile.ZipFile(node_archive()) as bundle:
    members = [entry for entry in bundle.infolist() if entry.filename.startswith(prefix) and not entry.is_dir()]
    if not members:
        raise SystemExit("Pinned official Node archive does not contain npm")
    expected_names = set()
    for entry in members:
        relative = PurePosixPath(entry.filename[len(prefix):])
        if relative.is_absolute() or not relative.parts or any(part in (".", "..") or ":" in part or "\\" in part for part in relative.parts):
            raise SystemExit("Unexpected npm archive member path")
        name = "npm/" + relative.as_posix()
        if name in expected_names:
            raise SystemExit("Duplicate npm archive member")
        expected_names.add(name)
        target = destination.joinpath(*PurePosixPath(name).parts)
        if not target.resolve().is_relative_to(destination.resolve()):
            raise SystemExit("npm runtime path leaves the application resources")
        contents = bundle.read(entry)
        expected = hashlib.sha256(contents).hexdigest()
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or digest(target) != expected:
            save_verified(target, contents, expected)
        manifest["files"][name] = {"sha256": expected, "source": manifest["nodeArchive"], "archiveMember": entry.filename}
    unexpected = [file.relative_to(destination).as_posix() for file in npm_root.rglob("*") if file.is_file() and file.relative_to(destination).as_posix() not in expected_names]
    if unexpected:
        raise SystemExit("Unexpected files in bundled npm; review the runtime directory before preparing it")
if json.loads((npm_root / "package.json").read_text(encoding="utf-8"))["version"] != manifest["npmVersion"]:
    raise SystemExit("npm package version does not match the accepted runtime")
temporary_manifest = destination / "manifest.json.download"
temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
temporary_manifest.replace(destination / "manifest.json")
result = subprocess.run([str(destination / "codex.exe"), "--version"], capture_output=True, encoding="utf-8", check=True)
if result.stdout.strip() != f"codex-cli {version}":
    raise SystemExit("Prepared Codex version does not match the generated protocol.")
node_version = manifest["nodeVersion"]
result = subprocess.run([str(destination / "node.exe"), "--version"], capture_output=True, encoding="utf-8", check=True)
if result.stdout.strip() != node_version:
    raise SystemExit("Prepared Node version does not match the accepted runtime.")
result = subprocess.run([str(destination / "node.exe"), str(npm_root / "bin/npm-cli.js"), "--version"], capture_output=True, encoding="utf-8", check=True)
if result.stdout.strip() != manifest["npmVersion"]:
    raise SystemExit("Prepared npm CLI does not match the accepted runtime")
print(f"Prepared Codex {version}, Node {node_version}, npm {manifest['npmVersion']} ({len(expected_names)} npm files): {destination}")
