"""Launch an explicit candidate with bundled dependencies and a stock Windows PATH."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["predecessor", "candidate"])
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output).resolve()
if not output.is_relative_to(ROOT / "artifacts") or not output.name.startswith("release-candidate-"):
    raise SystemExit("QA output must stay in candidate artifacts")
if args.mode == "predecessor":
    executable = ROOT / "apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe"
else:
    executable = output / "installer-payload/geod-agent-desktop.exe"
if not executable.is_file():
    raise SystemExit("The explicit QA executable is missing")
environment = {key: value for key, value in os.environ.items() if key.upper() in {
    "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "COMSPEC"}}
windows = Path(os.environ["SYSTEMROOT"])
environment["PATH"] = os.pathsep.join(map(str, [windows / "System32", windows / "System32/WindowsPowerShell/v1.0", windows]))
environment["GEOD_AGENT_GATEWAY_ORIGIN"] = "http://127.0.0.1:43123"
environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9234"
if args.mode == "predecessor":
    environment["GEOD_AGENT_DEV_GATEWAY_ORIGIN"] = "http://127.0.0.1:43123"
with (output / "qa-native.log").open("ab") as log:
    process = subprocess.Popen([str(executable)], cwd=executable.parent, env=environment,
                               stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
                               creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
print(f"Launched {args.mode} PID {process.pid}; PATH contains stock Windows directories only")
