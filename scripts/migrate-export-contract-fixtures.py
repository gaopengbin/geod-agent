"""One-time update of typed Rust request literals for the v1 export contract."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
for base in [root / "crates/geod-core/tests", root / "crates/geod-core/examples"]:
    for path in base.glob("*.rs"):
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"^(\s*)output_mbtiles: ([^\n]+),\n(?!\s*extra_outputs:)",
                      r"\1output_mbtiles: \2,\n\1extra_outputs: Vec::new(),\n\1export_options: geod_core::imagery::ExportOptions::default(),\n", text, flags=re.M)
        path.write_text(text, encoding="utf-8")
for base in [root / "crates/geod-task-engine/tests", root / "crates/geod-task-engine/examples"]:
    for path in base.glob("*.rs"):
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"^(\s*)output_directory:", r"\1export_options: None,\n\1output_directory:", text, flags=re.M)
        path.write_text(text, encoding="utf-8")
