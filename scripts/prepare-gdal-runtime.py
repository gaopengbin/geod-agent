"""Prepare a relocatable Windows GIS runtime; never install into the user's Python."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "apps/geod-agent-desktop/src-tauri/resources/gdal"
LOCK = ROOT / "vendor/gdal-runtime-1.1.3.lock"
PYTHON_VERSION = "3.13.11"
ARCHIVE_SHA256 = base64.b64decode("HsBm+2G6Xoxz4p4EjNB8JoUPdFheOhFgBRNbMbgASJA=").hex()
ARCHIVE_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def freeze():
    code = "import importlib.metadata as m,json;print(json.dumps(sorted((d.metadata['Name'],d.version) for d in m.distributions())))"
    result = subprocess.run(["uvx", "--from", "gdal-mcp==1.1.3", "python", "-I", "-c", code], capture_output=True, text=True, check=True)
    source = ROOT / "vendor/gdal-runtime-1.1.3.in"
    source.write_text("# Actual accepted Windows x86_64 CPython 3.13 environment.\n" + "\n".join(f"{name}=={version}" for name, version in json.loads(result.stdout)) + "\n", encoding="utf-8")
    subprocess.run(["uv", "pip", "compile", str(source), "--python-version", "3.13", "--python-platform", "x86_64-pc-windows-msvc", "--generate-hashes", "--output-file", str(LOCK), "--quiet"], check=True)
    print(f"Pinned accepted GIS dependencies: {LOCK}", flush=True)


def prepare():
    if not LOCK.is_file():
        raise SystemExit("Missing pinned GDAL runtime lock; use --freeze only after accepting the chosen dependency environment")
    manifest_path = DESTINATION / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("lockSha256") == digest(LOCK) and all((DESTINATION / name).is_file() and digest(DESTINATION / name) == sha for name, sha in manifest["files"].items()):
            print(f"Verified bundled GIS runtime: {DESTINATION}", flush=True)
            return
    cache = Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/runtime-cache"
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"python-{PYTHON_VERSION}-embed-amd64.zip"
    if not archive.is_file() or digest(archive) != ARCHIVE_SHA256:
        with urllib.request.urlopen(urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "GeoD-Agent-Build"}), timeout=90) as response:
            archive.write_bytes(response.read())
    if digest(archive) != ARCHIVE_SHA256:
        raise SystemExit("Python archive checksum differs from the pinned official Sigstore message digest")
    if DESTINATION.exists():
        # Only the fixed generated resource directory inside this repository is replaced.
        if DESTINATION.resolve().parent != (ROOT / "apps/geod-agent-desktop/src-tauri/resources").resolve():
            raise SystemExit("Unexpected runtime target")
        shutil.rmtree(DESTINATION)
    DESTINATION.mkdir(parents=True)
    with zipfile.ZipFile(archive) as bundle:
        for name in bundle.namelist():
            if not (DESTINATION / name).resolve().is_relative_to(DESTINATION.resolve()):
                raise SystemExit("Invalid Python archive member")
        bundle.extractall(DESTINATION)
    # Application-local site packages, no registry/system/user Python paths.
    (DESTINATION / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\nimport site\n", encoding="ascii")
    packages = DESTINATION / "Lib/site-packages"
    packages.mkdir(parents=True)
    subprocess.run(["uv", "pip", "install", "--python", str(DESTINATION / "python.exe"), "--target", str(packages), "--require-hashes", "--no-deps", "--only-binary", ":all:", "-r", str(LOCK), "--quiet"], check=True)
    check = "import sys,geopandas,pyogrio,rasterio,pyproj,fastmcp;assert sys.prefix==sys.base_prefix;from src.server import mcp;print(pyogrio.__gdal_version__)"
    environment = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE"}}
    environment["PATH"] = str(Path(os.environ["SYSTEMROOT"]) / "System32")
    subprocess.run([str(DESTINATION / "python.exe"), "-I", "-X", "utf8", "-c", check], env=environment, check=True)
    manifest = {"package": "gdal-mcp", "version": "1.1.3", "pythonVersion": PYTHON_VERSION, "archive": ARCHIVE_URL, "archiveSha256": ARCHIVE_SHA256, "checksumSource": ARCHIVE_URL + ".sigstore", "lockSha256": digest(LOCK), "files": {}}
    for path in sorted(DESTINATION.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.name != "manifest.json":
            manifest["files"][path.relative_to(DESTINATION).as_posix()] = digest(path)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared standalone GIS runtime: {len(manifest['files'])} checked files", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--freeze", action="store_true", help="Pin versions from the actual accepted development environment")
    arguments = parser.parse_args()
    freeze() if arguments.freeze else prepare()
