"""Read the exact bundled engine's public hook source; do not change Codex homes."""
import json
from pathlib import Path
from urllib.request import Request, urlopen

ROOT=Path('artifacts/product-gaps-20261004/plugin-hooks/research')
ROOT.mkdir(parents=True,exist_ok=True)
def get(url):
    with urlopen(Request(url,headers={'User-Agent':'GeoD-Agent-local-development'}),timeout=35) as response:
        return response.read(12000000)
tree=json.loads((ROOT/'tree.json').read_text(encoding='utf-8')) if (ROOT/'tree.json').exists() else json.loads(get('https://api.github.com/repos/openai/codex/git/trees/rust-v0.159.2?recursive=1'))
assert not tree.get('truncated')
(ROOT/'tree.json').write_text(json.dumps(tree),encoding='utf-8')
paths=[entry['path'] for entry in tree['tree'] if entry['type']=='blob' and ('hook' in entry['path'].lower()) and entry['path'].endswith('.rs')]
print(json.dumps({'commit':tree['sha'],'hookFiles':len(paths)},ensure_ascii=False))
selected=[p for p in paths if p in [
    'codex-rs/config/src/hook_config.rs','codex-rs/hooks/src/declarations.rs',
    'codex-rs/core/src/hook_runtime.rs',
    'codex-rs/hooks/src/engine/discovery.rs','codex-rs/hooks/src/registry.rs',
    'codex-rs/hooks/src/config_rules.rs','codex-rs/plugin/src/bundled_hooks.rs',
    'codex-rs/tui/src/chatwidget/hooks.rs','codex-rs/hooks/src/engine/command_runner.rs',
    'codex-rs/hooks/src/schema.rs','codex-rs/tui/src/hooks_rpc.rs',
    'codex-rs/core/tests/suite/hooks.rs','codex-rs/hooks/src/types.rs',
    'codex-rs/app-server/tests/suite/v2/hooks_list.rs']]
for source in selected:
    target=ROOT/source
    target.parent.mkdir(parents=True,exist_ok=True)
    if not target.exists(): target.write_bytes(get('https://raw.githubusercontent.com/openai/codex/rust-v0.159.2/'+source))
print(json.dumps({'saved':selected}))
