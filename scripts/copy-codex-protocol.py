"""Copy the dependency closure of Codex 0.159.2 generated ThreadItem types."""
from pathlib import Path
import sys

source = Path(sys.argv[1]).resolve()
destination = Path(__file__).resolve().parents[1] / "apps/geod-agent-desktop/src/codex-protocol"
pending = [source / "v2/ThreadItem.ts"]
seen = set()
while pending:
    path = pending.pop().resolve()
    if path in seen:
        continue
    seen.add(path)
    content = path.read_text(encoding="utf-8")
    target = destination / path.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    for line in content.splitlines():
        if line.startswith("import ") and ' from "' in line:
            pending.append(path.parent / (line.split(' from "')[1].split('"')[0] + ".ts"))
print(f"Copied {len(seen)} generated protocol files.")
