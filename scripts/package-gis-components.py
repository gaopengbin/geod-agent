"""Split accepted, pinned GIS wheels into reusable optional dependency packages.

Run with the existing GIS interpreter. No network, system installs or user data.
"""
from pathlib import Path
from importlib import metadata
import csv, hashlib, io, json, sys, zipfile

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'apps/geod-agent-desktop/src-tauri/resources/gdal/Lib/site-packages'
sys.path.insert(0, str(source))
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.markers import default_environment

output = ROOT / 'artifacts/gis-components-1'
output.mkdir(parents=True, exist_ok=True)
accepted = json.loads((source.parents[1] / 'manifest.json').read_text(encoding='utf-8'))['files']
distributions = {canonicalize_name(d.metadata['Name']): d for d in metadata.distributions(path=[str(source)])}
environment = {**default_environment(), 'python_version': '3.13', 'python_full_version': '3.13.11', 'sys_platform': 'win32', 'platform_system': 'Windows', 'extra': ''}

def closure(names):
    found = set()
    while names:
        name = canonicalize_name(names.pop())
        if name in found: continue
        distribution = distributions[name]
        found.add(name)
        for raw in distribution.requires or []:
            requirement = Requirement(raw)
            if not requirement.marker or requirement.marker.evaluate(environment):
                names.append(requirement.name)
    return found

vector = closure(['geopandas', 'pyogrio', 'pyproj', 'shapely'])
raster = closure(['rasterio'])
common = vector & raster
groups = {'gis-common': common, 'gis-vector': vector-common, 'gis-raster': raster-common}
catalog = {'version': 1, 'components': []}
for component, names in groups.items():
    files = {}
    for name in sorted(names):
        distribution = distributions[name]
        for entry in distribution.files or []:
            relative = str(entry).replace('\\', '/')
            if relative.startswith('../') or not relative: continue
            path = source / relative
            if not path.is_file() or any(part in {'__pycache__', 'tests', 'test', '__tests__'} for part in path.relative_to(source).parts) or path.suffix in {'.pyc', '.pyo', '.map'}: continue
            expected = accepted.get('Lib/site-packages/'+relative)
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            assert expected == actual, f'Unverified accepted runtime input: {relative}'
            files[relative] = actual
    manifest = {'id': component, 'version': '1.0.0', 'pythonVersion': '3.13.11',
                'packages': [{'name': n, 'version': distributions[n].version} for n in sorted(names)], 'files': files}
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    temporary = output / (component+'.zip')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        def write(name, content):
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 6, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = 0o100644 << 16
            bundle.writestr(info, content, compresslevel=9)
        write('manifest.json', manifest_bytes)
        for name in sorted(files): write(name, (source/name).read_bytes())
    sha = hashlib.sha256(temporary.read_bytes()).hexdigest()
    filename = component+'-'+sha+'.zip'
    archive = output / filename
    if archive.exists(): assert hashlib.sha256(archive.read_bytes()).hexdigest() == sha; temporary.unlink()
    else: temporary.rename(archive)
    catalog['components'].append({'id': component, 'version': '1.0.0', 'filename': filename,
        'url': 'https://geod.laogao.xyz/agent-updates/windows-x86_64/components/1/'+filename,
        'sha256': sha, 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'downloadBytes': archive.stat().st_size, 'installedBytes': sum((source/n).stat().st_size for n in files), 'files': len(files)})
(ROOT/'vendor/gis-components.json').write_text(json.dumps(catalog, indent=2)+'\n', encoding='utf-8')
(output/'catalog.json').write_text(json.dumps(catalog, indent=2)+'\n', encoding='utf-8')
print(json.dumps(catalog, indent=2))
