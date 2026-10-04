"""Export only metering columns from local test SQLite; never export auth tables."""
import json
import os
import sqlite3
import tempfile
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "docs/implementation/evidence/local-gateway-usage-2026-10-02.json"
data = json.loads(path.read_text(encoding="utf-8"))
rows = {r["generation_id"]: r for r in data["records"]}
columns = "generation_id,conversation_id,model,state,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,upstream_model,error_code,created_at,updated_at"
count = 0
databases=list(Path(tempfile.gettempdir()).glob("geod-desktop-gateway-*/gateway.sqlite"))
stable=Path(os.environ['LOCALAPPDATA'])/'GeoD Agent'/'dev-logs'/'local-gateway.sqlite'
if stable.exists():databases.append(stable)
for database in databases:
    with sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='model_generations'").fetchone():
            continue
        available = {row[1] for row in connection.execute("PRAGMA table_info(model_generations)")}
        if not set(columns.split(",")).issubset(available):
            continue
        for row in connection.execute("SELECT " + columns + " FROM model_generations"):
            rows[row["generation_id"]] = dict(row)
            count += 1
data["records"] = list(rows.values())
path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print({"exported": count, "total": len(rows)})
