from pathlib import Path
import re

root = Path(__file__).resolve().parents[1] / "apps/geod-agent-desktop/src"
for path in root.rglob("*"):
    if path.suffix not in (".ts", ".tsx"):
        continue
    source = path.read_text(encoding="utf-8")
    updated = re.sub(r"(toLocale(?:String|DateString|TimeString))\(\)", r"\1(getLocale())", source)
    if source == updated:
        continue
    if "getLocale" not in source:
        updated = updated.replace('import { t', 'import { getLocale, t', 1)
    path.write_text(updated, encoding="utf-8", newline="\n")
