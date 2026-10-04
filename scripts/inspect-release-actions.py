from pathlib import Path
import json
import urllib.request
tags = {'actions/checkout': 'v7.0.1', 'actions/setup-node': 'v7.0.0', 'actions/setup-python': 'v7.0.0', 'actions/upload-artifact': 'v7.0.1'}
result = {}
for repo, tag in tags.items():
    request = urllib.request.Request('https://api.github.com/repos/' + repo + '/git/ref/tags/' + tag, headers={'User-Agent': 'GeoD-Build-Research'})
    value = json.load(urllib.request.urlopen(request, timeout=30))['object']
    if value['type'] == 'tag':
        annotated = json.load(urllib.request.urlopen(urllib.request.Request(value['url'], headers={'User-Agent': 'GeoD-Build-Research'}), timeout=30))
        value = annotated['object']
    assert value['type'] == 'commit'
    result[repo] = {'tag': tag, 'sha': value['sha']}
target = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/release-pipeline/actions-pins.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
