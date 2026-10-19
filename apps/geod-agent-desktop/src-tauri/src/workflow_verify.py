"""Read-only acceptance checks for workspace artifacts, without model assertions."""
from pathlib import Path
import hashlib, json, math, sys

def verify_artifact(check):
    kind = check['kind']
    if kind not in ('file', 'json', 'raster', 'vector'):
        raise ValueError('Unsupported artifact check')
    root = Path.cwd().resolve()
    raw = Path(check['path'])
    path = (root / raw).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError('Artifact is missing or outside the current workspace')
    stat = path.stat()
    with path.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = dict(kind=kind, path=str(path.relative_to(root)).replace('\\', '/'),
                  bytes=stat.st_size, sha256=sha, verified=stat.st_size > 0)
    failures = []
    if kind == 'json':
        if stat.st_size > 16 * 1024 * 1024:
            raise ValueError('JSON requires a bounded or streamed inspector')
        value = json.loads(path.read_text(encoding='utf-8-sig'))
        for key in check.get('requiredFields', []):
            if not isinstance(value, dict) or key not in value:
                failures.append('requiredFields')
        if 'minItems' in check and (not isinstance(value, list) or len(value) < check['minItems']):
            failures.append('minItems')
    elif kind == 'raster':
        import rasterio
        from rasterio.crs import CRS
        with rasterio.open(path) as ds:
            result.update(crs=str(ds.crs) if ds.crs else None, width=ds.width, height=ds.height,
                          bands=ds.count, overviews=ds.overviews(1), layout=ds.tags(ns='IMAGE_STRUCTURE').get('LAYOUT'),
                          compression=ds.compression.value if ds.compression else 'none')
            if 'crs' in check and ds.crs != CRS.from_user_input(check['crs']):
                failures.append('crs')
            for key in ('width', 'height', 'bands', 'layout'):
                if key in check and result[key] != check[key]:
                    failures.append(key)
            if 'compression' in check and result['compression'].lower() != check['compression'].lower():
                failures.append('compression')
            if 'overviews' in check:
                expected = [(math.ceil(ds.width / n), math.ceil(ds.height / n)) for n in check['overviews']]
                actual = [(math.ceil(ds.width / n), math.ceil(ds.height / n)) for n in result['overviews']]
                if expected != actual:
                    failures.append('overviews')
            # Decode real blocks, rather than accepting an unreadable TIFF header.
            for band in range(1, ds.count + 1):
                for _, window in ds.block_windows(band):
                    ds.read(band, window=window)
    elif kind == 'vector':
        import pyogrio
        from pyproj import CRS
        info = pyogrio.read_info(path)
        result.update(crs=info['crs'], features=info['features'], fields=list(info['fields']))
        if 'crs' in check and (not info['crs'] or CRS(info['crs']) != CRS(check['crs'])):
            failures.append('crs')
        if 'minFeatures' in check and info['features'] < check['minFeatures']:
            failures.append('minFeatures')
        if any(field not in result['fields'] for field in check.get('requiredFields', [])):
            failures.append('requiredFields')
    if path.stat().st_size != stat.st_size or path.stat().st_mtime_ns != stat.st_mtime_ns:
        failures.append('changedDuringVerification')
    result['verified'] = result['verified'] and not failures
    if failures:
        result['failedChecks'] = failures
    return result

if __name__ == '__main__':
    try:
        print(json.dumps(verify_artifact(json.loads(sys.stdin.read())), ensure_ascii=False, allow_nan=False))
    except Exception:
        # Paths, dataset attributes and credentials never enter error messages.
        print(json.dumps(dict(verified=False, error='WORKFLOW_ARTIFACT_UNAVAILABLE',
                              message='成果无法读取或检查条件不适用，请核对当前工作区与文件。'), ensure_ascii=False))
