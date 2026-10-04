"""Check GIS file reads still work without the removed psycopg worker dependency."""
import base64
import json
import os
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parents[1]
fixture = Path(os.environ["TEMP"]) / "geod-data-input-fixtures"
cases = []
for name in ["boundary.geojson", "boundary.gpkg"]:
    request = {"command": "data_input_read", "args": {"conversationId": "pgedge-file-regression", "request": {"files": [{"name": name, "base64": base64.b64encode((fixture / name).read_bytes()).decode()}]}}}
    result = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:1421/rpc", json.dumps(request).encode(), {"Content-Type": "application/json"}), timeout=190))
    boundary = result["value"].get("boundary")
    assert boundary and len(boundary["geometry"]["polygons"][0]) == 2, result
    cases.append({"format": name, "pass": True, "bounds": boundary["bounds"], "holesPreserved": True})
    print(name, "PASS", flush=True)
(root / "docs/implementation/evidence/pgedge-file-regression-2026-10-01.json").write_text(json.dumps(cases, indent=2), encoding="utf-8")
