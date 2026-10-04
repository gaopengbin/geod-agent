"""Read-only public template probes. Never writes a source or sends credentials."""
import concurrent.futures
import datetime
import hashlib
import io
import json
from pathlib import Path
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / 'contracts/source-presets.v1.json').read_text(encoding='utf-8'))
out = ROOT / 'artifacts/desktop-parity/source-preset-probes'
out.mkdir(parents=True, exist_ok=True)
# Read the currently running app's route instead of assuming an older proxy.
local = urllib.request.build_opener(urllib.request.ProxyHandler({}))
request = urllib.request.Request('http://127.0.0.1:1421/rpc', data=json.dumps({'command': 'network_get', 'args': {}}).encode(), headers={'Content-Type': 'application/json'})
with local.open(request, timeout=10) as response:
    network = json.load(response)['value']
proxy = network.get('effectiveProxy')
opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy} if proxy else {}))

def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'GeoD-Agent/0.1 (preset verification)'})
    with opener.open(request, timeout=20) as response:
        return response.status, response.read(4 * 1024 * 1024)

def probe(preset):
    url = preset['urlTemplate'].replace('{s}', preset['subdomains'][0]).replace('{z}', '3').replace('{x}', '6').replace('{y}', '3')
    result = {'id': preset['id'], 'sample': {'z': 3, 'x': 6, 'y': 3}, 'coordinateSystem': preset.get('coordinateSystem', 'wgs84'), 'subdomains': preset['subdomains']}
    try:
        status, data = fetch(url)
        image = Image.open(io.BytesIO(data))
        image.load()
        artifact = out / f"{preset['id']}.{image.format.lower()}"
        artifact.write_bytes(data)
        result.update(httpStatus=status, bytes=len(data), dimensions=list(image.size), format=image.format, decoded=True, sha256=hashlib.sha256(data).hexdigest(), artifact=str(artifact))
    except Exception as error:
        result.update(decoded=False, error=str(error))
    return result

with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    samples = list(pool.map(probe, [p for p in catalog['presets'] if p['id'].startswith(('google-', 'gaode-'))]))
try:
    status, body = fetch('https://tiles.openfreemap.org/planet')
    metadata = json.loads(body)
    tilejson = {'httpStatus': status, 'tiles': metadata.get('tiles'), 'minZoom': metadata.get('minzoom'), 'maxZoom': metadata.get('maxzoom'), 'resolved': bool(metadata.get('tiles'))}
except Exception as error:
    tilejson = {'resolved': False, 'error': str(error)}
report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'samples': samples, 'openFreeMap': tilejson, 'tiandituLiveVerified': False, 'publicSamplesPassed': all(p['decoded'] for p in samples)}
report_path = ROOT / 'docs/implementation/evidence/source-presets-public-probes-2026-10-02.json'
report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps({'samples': [{'id': p['id'], 'decoded': p['decoded']} for p in samples], 'openFreeMapResolved': tilejson['resolved'], 'report': str(report_path)}, ensure_ascii=False))
