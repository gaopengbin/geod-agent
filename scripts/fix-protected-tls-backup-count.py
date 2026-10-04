from pathlib import Path
file=Path('apps/geod-agent-desktop/src-tauri/src/desktop_backups.rs')
text=file.read_text(encoding='utf-8')
assert text.count('len(),9);')==1
file.write_text(text.replace('len(),9);','len(),10);'),encoding='utf-8')
import json
root=Path('artifacts/product-gaps-20261004/database-keys')
state=json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
report=dict(passed=False,stage='Before protected client-key backup repair',backup=state['backup'],manifest=json.loads((Path(state['backup']['path'])/'manifest.json').read_text()),reason='System-protected .client-tls files were not included by the prior extension filter')
target=root/'backup-protected-key-omission-failure.json'
assert not target.exists()
target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
