"""Inspect actual shared edges in bundled AreaCity data, without network calls."""
import gzip, json, struct
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'apps/geod-agent-desktop/src-tauri/data/areacity'
regions = json.loads((root / 'regions.json').read_text(encoding='utf-8'))
data = (root / 'geometry.bin').read_bytes()

def rings(region):
    raw = gzip.decompress(data[region['offset']:region['offset'] + region['length']])
    cursor = 0
    def count():
        nonlocal cursor
        value = struct.unpack_from('<I', raw, cursor)[0]; cursor += 4
        return value
    def delta():
        nonlocal cursor
        value = shift = 0
        while True:
            byte = raw[cursor]; cursor += 1
            value |= (byte & 127) << shift
            if byte < 128: return (value >> 1) ^ -(value & 1)
            shift += 7
    result = []
    for _ in range(count()):
        for _ in range(count()):
            x = y = 0; ring = []
            for _ in range(count()):
                x += delta(); y += delta(); ring.append((x, y))
            result.append(ring)
    return result

target = next(r for r in regions if r['name'] == '驻马店市')
edges = {tuple(sorted((a, b))) for ring in rings(target) for a, b in zip(ring, ring[1:]) if a != b}
found = []
for region in regions:
    if region['level'] != target['level'] or region['id'] == target['id']: continue
    shared = sum(tuple(sorted((a, b))) in edges for ring in rings(region) for a, b in zip(ring, ring[1:]) if a != b)
    if shared: found.append({'name': region['name'], 'adcode': region['id'].ljust(6, '0'), 'sharedEdges': shared})
print(json.dumps({'target': target['name'], 'neighbors': found}, ensure_ascii=False, indent=2))
