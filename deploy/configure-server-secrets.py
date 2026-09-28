"""Configure the GeoD Agent service without putting API keys in argv or logs.

The DeepSeek key is read from one stdin line. Existing Studio environment
variables are preserved; the newly generated gateway secret is shared only
between the Studio and Agent service environment files.
"""

import argparse
import os
import re
import secrets
import sys
import tempfile
from pathlib import Path


def temporary_file(path: Path, contents: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    os.fchmod(descriptor, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        Path(name).unlink(missing_ok=True)
        raise
    return Path(name)


def configure(studio_env: Path, agent_env: Path, key: str) -> None:
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{20,200}", key):
        raise ValueError("DeepSeek key has an unexpected format")
    if agent_env.exists() or agent_env.is_symlink():
        raise FileExistsError("Agent environment file already exists; refusing to overwrite it")
    if studio_env.is_symlink() or agent_env.parent.is_symlink():
        raise ValueError("Environment paths must not be symbolic links")
    studio = studio_env.read_text(encoding="utf-8")
    if re.search(r"^GEOD_AGENT_GATEWAY_SECRET=", studio, flags=re.MULTILINE):
        raise ValueError("Studio already has a gateway secret; refusing to replace it")
    shared = secrets.token_urlsafe(48)
    studio_new = studio.rstrip("\n") + f"\nGEOD_AGENT_GATEWAY_SECRET={shared}\n"
    agent_new = "\n".join(
        [
            f"GEOD_AGENT_GATEWAY_SECRET={shared}",
            f"DEEPSEEK_API_KEY={key}",
            "GEOD_IDENTITY_ORIGIN=http://127.0.0.1:9114",
            "DEEPSEEK_BASE_URL=https://api.deepseek.com",
            "DEEPSEEK_MODEL=deepseek-flash",
            "GEOD_AGENT_LISTEN_HOST=127.0.0.1",
            "GEOD_AGENT_LISTEN_PORT=9115",
            "GEOD_AGENT_DB_PATH=/srv/laogao/data/geod-agent/agent-model.sqlite",
            "GEOD_AGENT_TOKEN_LIMIT=100000",
            "",
        ]
    )
    agent_temp = temporary_file(agent_env, agent_new)
    studio_temp = None
    try:
        studio_temp = temporary_file(studio_env, studio_new)
        os.replace(agent_temp, agent_env)
        try:
            os.replace(studio_temp, studio_env)
        except BaseException:
            agent_env.unlink(missing_ok=True)
            raise
    finally:
        agent_temp.unlink(missing_ok=True)
        if studio_temp is not None:
            studio_temp.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--studio-env", type=Path, required=True)
    parser.add_argument("--agent-env", type=Path, required=True)
    options = parser.parse_args()
    key_line = sys.stdin.readline()
    if not key_line.endswith("\n"):
        raise SystemExit("Expected one key line on stdin")
    configure(options.studio_env, options.agent_env, key_line.rstrip("\r\n"))
    print("Service secrets configured; values were not printed")
