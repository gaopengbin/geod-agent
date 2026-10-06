"""Build current native development code without replacing the running program.

Use locked offline dependencies and two build jobs; optionally reuse a build cache.
Explicitly supplied running processes retain their exact identities.
"""
import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tomllib

import psutil

from release_build_identity import release_environment, source_config
from update_signing_vault import public_environment
from windows_detached_process import process_in_job, process_package_identity

REPO = Path(__file__).resolve().parents[1]
NATIVE = REPO / "apps/geod-agent-desktop/src-tauri"
BUILDS = REPO / "artifacts/development-native-current-20261006"


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def protected():
    values = []
    for value in args.preserve_process:
        pid, created = value.split(":", 1)
        pid, created = int(pid), float(created)
        process = psutil.Process(pid)
        assert process.create_time() == created and process.is_running()
        values.append({"pid": pid, "created": created, "exe": process.exe()})
    return values


def source_snapshot():
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=REPO).decode("utf-8").split("\0")
    return {name: digest(REPO / name) for name in sorted(set(names)) if name and
            name.startswith(("apps/geod-agent-desktop/", "crates/", "packages/", "vendor/")) and (REPO / name).is_file()}


def executable_version(file):
    api = ctypes.WinDLL("version", use_last_error=True)
    api.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    api.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    api.VerQueryValueW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    ignored = wintypes.DWORD()
    size = api.GetFileVersionInfoSizeW(str(file), ctypes.byref(ignored))
    assert size > 0
    data = ctypes.create_string_buffer(size)
    assert api.GetFileVersionInfoW(str(file), 0, size, data)
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    assert api.VerQueryValueW(data, "\\", ctypes.byref(pointer), ctypes.byref(length)) and length.value >= 52
    info = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD * 13)).contents
    assert info[0] == 0xfeef04bd
    return ".".join(map(str, [info[2] >> 16, info[2] & 65535, info[3] >> 16, info[3] & 65535]))


parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path)
parser.add_argument("--build-cache", type=Path, help="Reusable ignored Cargo cache; outputs are copied into the new build record")
parser.add_argument("--preserve-process", action="append", required=True,
                    help="PID:creation-time identity of a running process to preserve")
args = parser.parse_args()
assert os.name == "nt" and not process_in_job(os.getpid()) and process_package_identity(os.getpid()) is None
root = (args.output or BUILDS / ("build-" + secrets.token_hex(8))).resolve()
assert root.is_relative_to(BUILDS.resolve()) and not root.exists()
config = source_config(NATIVE)
assert config["version"] == tomllib.loads((NATIVE / "Cargo.toml").read_text(encoding="utf-8"))["package"]["version"]
root.mkdir(parents=True, exist_ok=False)
target=(args.build_cache or root/"target").resolve()
if args.build_cache:
    assert target.is_relative_to((REPO/"artifacts/development-native-cache").resolve())
    target.mkdir(parents=True,exist_ok=True)
report = {"passed": False, "startedAt": datetime.now(timezone.utc).isoformat(), "pid": os.getpid(),
          "outsideWindowsJobs": True, "packageIdentity": None, "identifier": config["identifier"],
          "version": config["version"], "developmentBuild": True, "runtimeVerified": False,
          "originalExecutableReplaced": False, "shippingCandidateModified": False,
          "installed": False, "launched": False, "modelCalls": 0, "providerCredentialsPassedToCompiler": False}
receipt = root / "build.json"
old_executable = NATIVE / "target/debug/geod-agent-desktop.exe"
try:
    report["protectedBefore"] = protected()
    report["originalExecutableSha256"] = digest(old_executable)
    before = source_snapshot()
    report["sourceSnapshotBeforeBuild"] = before
    report["productInputs"] = len(before)
    env = public_environment(release_environment(os.environ))
    for name in list(env):
        if any(word in name.upper() for word in ("SECRET", "PASSWORD", "TOKEN", "API_KEY")) or name.startswith("GEOD_QA_"):
            env.pop(name, None)
    for name in ("GEOD_UPDATE_ENDPOINT", "GEOD_UPDATE_PUBLIC_KEY", "GEOD_UPDATE_ARTIFACT_BASE"):
        env.pop(name, None)
    env["CARGO_BUILD_JOBS"] = "2"
    env["CARGO_TARGET_DIR"] = str(target)
    receipt.write_text(json.dumps(report, indent=2), encoding="utf-8")
    with (root / "build.log").open("w", encoding="utf-8") as log:
        result = subprocess.run([shutil.which("cargo"), "build", "--locked", "--offline", "--jobs", "2",
                                 "--manifest-path", str(NATIVE / "Cargo.toml"), "--target-dir", str(target)],
                                cwd=NATIVE, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                creationflags=subprocess.CREATE_NO_WINDOW)
    report["exitCode"] = result.returncode
    assert result.returncode == 0, "Inspect the preserved offline compiler log"
    after = source_snapshot()
    report["changedProductInputs"] = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
    assert not report["changedProductInputs"]
    assert digest(old_executable) == report["originalExecutableSha256"]
    assert protected() == report["protectedBefore"]
    executable = target / "debug/geod-agent-desktop.exe"
    if args.build_cache:
        frozen=root/"geod-agent-desktop.exe"
        shutil.copy2(executable,frozen)
        executable=frozen
    assert executable.is_file() and config["identifier"].encode() in executable.read_bytes()
    file_version = executable_version(executable)
    assert file_version == config["version"].split("-")[0] + ".0"
    report.update(passed=True, executable=str(executable), executableSha256=digest(executable),
                  executableBytes=executable.stat().st_size, windowsFileVersion=file_version,
                  protectedAfter=protected(), originalExecutableHashUnchanged=True)
except BaseException as error:
    report["error"] = str(error)
    raise
finally:
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    receipt.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in
                      ("sourceSnapshotBeforeBuild", "protectedBefore", "protectedAfter")}), flush=True)
