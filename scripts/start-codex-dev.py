"""Start GeoD's development desktop with HMR and hidden helpers."""
from pathlib import Path
import os
import shutil
import subprocess
import time
import urllib.request
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--local-gateway", action="store_true")
parser.add_argument("--update-fixture", type=Path, help="Debug-only signed updater acceptance configuration")
args = parser.parse_args()

desktop = Path(__file__).resolve().parents[1] / "apps" / "geod-agent-desktop"
logs = Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent" / "dev-logs"
logs.mkdir(parents=True, exist_ok=True)
runtime = desktop / "src-tauri/resources/codex"
node = str(runtime / "node.exe") if (runtime / "node.exe").is_file() else shutil.which("node")
if not node:
    raise SystemExit("Node.js is required for this development build")
codex = [runtime / "codex.exe"] if (runtime / "codex.exe").is_file() else sorted((Path(os.environ["LOCALAPPDATA"]) / "OpenAI" / "Codex" / "bin").glob("*/codex.exe"))
if not codex:
    raise SystemExit("Codex 0.159.2 is required for this development build")
env = dict(os.environ, GEOD_CODEX_NODE=node, GEOD_CODEX_EXE=str(codex[-1]))
if args.local_gateway:
    env["GEOD_AGENT_DEV_GATEWAY_ORIGIN"] = "http://127.0.0.1:43123"
if args.update_fixture:
    fixture = args.update_fixture.resolve(strict=True)
    env["GEOD_AGENT_DEV_UPDATE_CONFIG"] = str(fixture)
flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
subprocess.run([shutil.which("python"), "-X", "utf8", str(desktop.parents[1] / "scripts/prepare-pgedge-runtime.py")], check=True, creationflags=subprocess.CREATE_NO_WINDOW)
subprocess.run([shutil.which("python"), "-X", "utf8", str(desktop.parents[1] / "scripts/prepare-gdal-runtime.py")], check=True, creationflags=subprocess.CREATE_NO_WINDOW)
def healthy():
    try:
        with urllib.request.urlopen("http://127.0.0.1:1420", timeout=1) as response:
            return response.status == 200
    except OSError:
        return False
if not healthy():
    with (logs / "vite.log").open("ab") as output:
        subprocess.Popen([node, str(desktop / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "1420", "--strictPort"], cwd=desktop, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output, creationflags=flags, close_fds=True)
    for _ in range(50):
        if healthy():
            break
        time.sleep(0.2)
    else:
        raise SystemExit(f"Vite did not start; inspect {logs / 'vite.log'}")
executable = desktop / "src-tauri/target/debug/geod-agent-desktop.exe"
if not executable.is_file():
    raise SystemExit("Build the desktop first: cargo build in apps/geod-agent-desktop/src-tauri")
env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9233"
with (logs / "desktop.log").open("ab") as output:
    subprocess.Popen([str(executable)], cwd=desktop, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output, creationflags=flags, close_fds=True)
print("GeoD development desktop started; frontend HMR: http://127.0.0.1:1420")
