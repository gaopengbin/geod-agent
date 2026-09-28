import stat
import subprocess
import sys
import tempfile
from pathlib import Path


script = Path(__file__).with_name("configure-server-secrets.py")
fake_key = "sk-" + "x" * 32

with tempfile.TemporaryDirectory() as folder:
    studio = Path(folder) / "geod-studio.env"
    agent = Path(folder) / "geod-agent.env"
    studio.write_text("PORT=9114\nEXISTING=value\n", encoding="utf-8")
    command = [sys.executable, str(script), "--studio-env", str(studio), "--agent-env", str(agent)]
    first = subprocess.run(command, input=fake_key + "\n", text=True, capture_output=True)
    assert first.returncode == 0, first.stderr
    assert fake_key not in first.stdout + first.stderr
    studio_text = studio.read_text(encoding="utf-8")
    agent_text = agent.read_text(encoding="utf-8")
    assert studio_text.startswith("PORT=9114\nEXISTING=value\n")
    shared = next(line.partition("=")[2] for line in studio_text.splitlines() if line.startswith("GEOD_AGENT_GATEWAY_SECRET="))
    assert len(shared) >= 32
    assert f"GEOD_AGENT_GATEWAY_SECRET={shared}\n" in agent_text
    assert f"DEEPSEEK_API_KEY={fake_key}\n" in agent_text
    assert stat.S_IMODE(studio.stat().st_mode) == 0o600
    assert stat.S_IMODE(agent.stat().st_mode) == 0o600
    second = subprocess.run(command, input=fake_key + "\n", text=True, capture_output=True)
    assert second.returncode != 0
    assert studio.read_text(encoding="utf-8") == studio_text
    assert agent.read_text(encoding="utf-8") == agent_text

print("secret installer: atomic install, permissions and no overwrite verified")
