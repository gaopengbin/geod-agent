"""Start the local test gateway. Provider credentials stay in process memory."""
from pathlib import Path
import argparse
import os
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--existing-config", action="store_true", help="Read the current GeoD provider config over pinned SSH; no server changes.")
args = parser.parse_args()
environment = dict(os.environ)
if not environment.get("DEEPSEEK_API_KEY"):
    if not args.existing_config:
        raise SystemExit("Set DEEPSEEK_API_KEY or use --existing-config.")
    skill = Path.home() / ".codex/skills/laogao-tencent-deploy"
    result = subprocess.run([
        "ssh.exe", "-i", str(Path.home() / ".ssh/laogao_tencent_ed25519"),
        "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={skill / 'references/known_hosts'}", "-o", "ConnectTimeout=15",
        "ubuntu@62.234.147.130", "sudo cat /srv/laogao/secrets/geod-agent.env",
    ], capture_output=True, encoding="utf-8", timeout=30)
    if result.returncode:
        raise SystemExit("Could not read the existing GeoD provider configuration.")
    for line in result.stdout.splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "DEEPSEEK_API_KEY":
            environment[name.strip()] = value.strip().strip('"').strip("'")
    if not environment.get("DEEPSEEK_API_KEY"):
        raise SystemExit("The existing GeoD configuration has no DeepSeek project key.")
environment["GEOD_LOCAL_DESKTOP_TEST"] = "1"
environment["GEOD_LOCAL_GATEWAY_DB_PATH"] = str(Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/dev-logs/local-gateway.sqlite")
node = shutil.which("node")
if not node:
    raise SystemExit("Node.js is required.")
folder = Path(os.environ["LOCALAPPDATA"]) / "GeoD Agent/dev-logs"
folder.mkdir(parents=True, exist_ok=True)
with (folder / "local-gateway.log").open("ab") as log:
    process = subprocess.Popen([node, str(Path(__file__).with_name("local-desktop-gateway.mjs"))],
        env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True,
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
(folder / "local-gateway.pid").write_text(str(process.pid), encoding="ascii")
print(f"Local test gateway started (PID {process.pid}); log: {folder / 'local-gateway.log'}")
