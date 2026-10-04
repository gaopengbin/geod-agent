"""Localize the actual PostGIS TLS choices and narrow the authentication type."""
from pathlib import Path

file = Path('apps/geod-agent-desktop/src/data-input-panel.tsx')
text = file.read_text(encoding='utf-8')
old = "{{prefer:'优先加密',require:'必须加密','verify-ca':'验证证书','verify-full':'验证证书及主机',disable:'关闭'}[mode]}"
new = "{t({prefer:'优先加密',require:'必须加密','verify-ca':'验证证书','verify-full':'验证证书及主机',disable:'关闭'}[mode])}"
assert text.count(old) == 1
text = text.replace(old, new)
assert text.count('type DataConnectionDraft,') == 1
text = text.replace('type DataConnectionDraft,', 'type DataConnectionDraft, type DataConnectionAuthentication,')
assert text.count('Omit<DataConnectionDraft, "password">') == 1
text = text.replace('Omit<DataConnectionDraft, "password">', 'DataConnectionAuthentication')
file.write_text(text, encoding='utf-8')
