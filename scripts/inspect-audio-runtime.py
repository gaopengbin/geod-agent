"""Read upstream release and model identity before selecting a local audio runtime."""
from pathlib import Path
import json
import urllib.request

root = Path(__file__).resolve().parents[1]
target = root / 'artifacts/product-gaps-20261004/audio-inputs'
target.mkdir(parents=True, exist_ok=True)
def request(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'GeoD-Agent-development-QA'}), timeout=60) as response:
        return json.load(response)

release = request('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest')
binary = request('https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5130')
assets = [{key: asset.get(key) for key in ['name', 'size', 'digest', 'browser_download_url']} for asset in binary['assets'] if asset['name'] == 'whisper-bin-x64.zip']
model_repository = request('https://huggingface.co/api/models/ggerganov/whisper.cpp')
models = request('https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main?recursive=false&expand=false')
chosen = [entry for entry in models if entry.get('path') in ['ggml-tiny.bin', 'ggml-base.bin']]
record = {'tag': release['tag_name'], 'releaseUrl': release['html_url'], 'binaryTag': binary['tag_name'],
          'binaryReleaseUrl': binary['html_url'], 'assets': assets,
          'modelRevision': model_repository['sha'], 'models': chosen, 'inspectedOnly': True}
(target / 'upstream-runtime.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
print(json.dumps(record))
