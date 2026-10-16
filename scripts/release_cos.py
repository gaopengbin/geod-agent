"""Upload reviewed assets directly to private COS, never download CDN packages.

Receipts distinguish HEAD metadata from content verification. SHA-256 metadata
is our upload fingerprint, not a COS-calculated digest. SDK MD5 checks transfer.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import subprocess
from urllib.request import Request, urlopen

from release_flow import lock, save, sha

BUCKET = 'geod-downloads-1301384002'
REGION = 'ap-guangzhou'
PREFIX = 'agent-updates/windows-x86_64/'
IMMUTABLE = 'public, immutable, max-age=31536000'
MUTABLE = 'must-revalidate, no-cache, max-age=0'
SMALL_LIMIT = 64 * 1024


def public_plan(file):
    file = Path(file).resolve()
    plan = json.loads(file.read_text(encoding='utf-8'))
    version = plan['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected formal semver release')
    folder = file.parent
    objects = plan['objects']
    if not objects or len(plan['cosFiles']) != len(objects):
        raise ValueError('Empty/mismatched public asset list')
    entries = []
    keys = set()
    for item, name in zip(objects, plan['cosFiles']):
        local = Path(name).resolve()
        if not local.is_relative_to(folder) or not local.is_file() or Path(name).is_symlink():
            raise ValueError('Only allowlisted staged public files may be uploaded')
        expected_key = PREFIX + version + '/' + local.name
        if item['key'] != expected_key or item['name'] != local.name or item['key'] in keys:
            raise ValueError('Unsafe or duplicate COS key')
        if any(token in local.name for token in ('/', '\\', '..', ':')):
            raise ValueError('Unsafe public name')
        if item.get('cacheControl') != IMMUTABLE:
            raise ValueError('Versioned files require immutable cache headers')
        if sha(local) != item['sha256'] or local.stat().st_size != item['bytes']:
            raise ValueError('Public asset changed: ' + local.name)
        keys.add(item['key'])
        entries.append({**item, 'file': str(local)})
    latest = Path(plan['mutableLatest']).resolve()
    if not latest.is_relative_to(folder) or not latest.is_file() or latest.stat().st_size > SMALL_LIMIT:
        raise ValueError('Mutable index must be a small staged public file')
    if json.loads(latest.read_text(encoding='utf-8'))['version'] != version:
        raise ValueError('Index and assets versions differ')
    return plan, entries, latest


def client_from_environment():
    # Do not log SDK request headers (authorization/session tokens).
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    secret_id, secret_key = os.environ.get('COS_SECRET_ID'), os.environ.get('COS_SECRET_KEY')
    credential_file = Path(os.environ.get('COS_RELEASE_CREDENTIAL_FILE',
                           str(Path.home()/'.codex/secrets/geod-cos-publisher.xml'))).resolve()
    if (not secret_id or not secret_key) and credential_file.is_file():
        root = Path(__file__).resolve().parents[1]
        if credential_file.is_relative_to(root):
            raise ValueError('Keep release credentials outside the repository')
        credential_environment = os.environ.copy()
        # Codex may run PowerShell 7; Windows PowerShell 5 must discover its own
        # modules rather than inherit incompatible Security/Utility modules.
        credential_environment.pop('PSModulePath', None)
        result = subprocess.run(['powershell.exe', '-NoProfile', '-File',
                                 str(Path(__file__).with_name('Read-CosReleaseCredential.ps1')),
                                 '-CredentialFile', str(credential_file)], capture_output=True,
                                encoding='utf-8', timeout=15, env=credential_environment,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise ValueError('Cannot decrypt release credentials for this Windows user')
        credentials = json.loads(result.stdout)
        secret_id, secret_key = credentials['SecretId'], credentials['SecretKey']
    if not secret_id or not secret_key:
        raise ValueError('COS release credentials are not configured; use private environment variables')
    from qcloud_cos import CosConfig, CosS3Client
    class ReleaseClient(CosS3Client):
        # SDK 1.9.44 forwards upload kwargs to initiation, but drops them on
        # completion. Enforce immutable writes at BOTH provider API calls.
        def complete_multipart_upload(self, *args, **kwargs):
            metadata = dict(kwargs.get('Metadata', {}))
            metadata['x-cos-forbid-overwrite'] = 'true'
            kwargs['Metadata'] = metadata
            return super().complete_multipart_upload(*args, **kwargs)
    return ReleaseClient(CosConfig(Region=REGION, SecretId=secret_id, SecretKey=secret_key,
                               Token=os.environ.get('COS_SESSION_TOKEN'), Scheme='https', Timeout=30))


def head(client, key):
    try:
        return {k.lower(): v for k, v in client.head_object(Bucket=BUCKET, Key=key).items()}
    except Exception as error:
        if hasattr(error, 'get_status_code') and error.get_status_code() == 404:
            return None
        raise ValueError('COS HEAD failed; check scoped permissions/network (details withheld)') from None


def matches(meta, item):
    return bool(meta and int(meta.get('content-length', -1)) == item['bytes']
                and meta.get('x-cos-meta-sha256') == item['sha256']
                and meta.get('cache-control') == item['cacheControl'])


def upload_one(client, item):
    meta = head(client, item['key'])
    if meta and not matches(meta, item):
        # Older console uploads lack SHA metadata: size alone is insufficient.
        raise ValueError('Preserve existing immutable object with unverified/different content: ' + item['name'])
    action = 'reused'
    if not meta:
        action = 'uploaded'
        try:
            client.upload_file(Bucket=BUCKET, Key=item['key'], LocalFilePath=item['file'],
                               PartSize=16, MAXThread=2, EnableMD5=True,
                               CacheControl=IMMUTABLE,
                               ContentType=mimetypes.guess_type(item['name'])[0] or 'application/octet-stream',
                               Metadata={'x-cos-meta-sha256': item['sha256'],
                                         'x-cos-forbid-overwrite': 'true'})
        except Exception:
            raise ValueError('COS upload failed: ' + item['name'] + '; rerun to resume validated parts') from None
        meta = head(client, item['key'])
        if not matches(meta, item):
            raise ValueError('Uploaded object metadata/size/cache headers differ: ' + item['name'])
    return {'name': item['name'], 'key': item['key'], 'bytes': item['bytes'], 'sha256': item['sha256'],
            'etag': meta.get('etag'), 'action': action,
            'evidence': 'local SHA-256 + SDK transfer MD5 + COS HEAD size and caller-supplied SHA metadata'}


def upload_assets(client, plan_file, receipt_file):
    plan, entries, _ = public_plan(plan_file)  # Validate ALL files before writing any object.
    if client.get_bucket_versioning(Bucket=BUCKET).get('Status') == 'Enabled':
        raise ValueError('Immutable no-overwrite protection requires bucket versioning disabled')
    record = {'passed': False, 'version': plan['version'], 'bucket': BUCKET,
              'publicPlanSha256': sha(plan_file), 'objects': [], 'largeCdnDownloads': 0}
    save(receipt_file, record)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(upload_one, client, item) for item in entries]
        for future in futures:
            record['objects'].append(future.result())
            save(receipt_file, record)
            print(json.dumps({'object': record['objects'][-1]['name'], 'action': record['objects'][-1]['action']}), flush=True)
    record.update(passed=True, objectNames=[item['name'] for item in entries],
                  uploadedBytes=sum(item['bytes'] for item in record['objects'] if item['action'] == 'uploaded'))
    save(receipt_file, record)
    return record


def small_cos_read(client, key):
    metadata = head(client, key)
    if metadata is None:
        return None
    if int(metadata.get('content-length', SMALL_LIMIT + 1)) > SMALL_LIMIT:
        raise ValueError('Refuse a large COS object read')
    response = client.get_object(Bucket=BUCKET, Key=key)
    stream = response['Body'].get_raw_stream()
    try:
        data = stream.read(SMALL_LIMIT + 1)
    finally:
        stream.close()
    if len(data) > SMALL_LIMIT:
        raise ValueError('COS index exceeded small-file limit')
    return data


def activate_index(client, plan_file, receipt_file, previous_sha, backup_file):
    plan, entries, latest = public_plan(plan_file)
    receipt = json.loads(Path(receipt_file).read_text(encoding='utf-8'))
    if not receipt['passed'] or receipt.get('publicPlanSha256') != sha(plan_file):
        raise ValueError('Asset upload receipt does not match this plan')
    for item in entries:
        if not matches(head(client, item['key']), item):
            raise ValueError('Index switch blocked: a referenced object is unavailable')
    key = PREFIX + 'latest.json'
    desired = latest.read_bytes()
    current = small_cos_read(client, key)
    if current == desired:
        return {'passed': True, 'version': plan['version'], 'state': 'already_active', 'largeCdnDownloads': 0}
    if current is None or hashlib.sha256(current).hexdigest() != previous_sha:
        raise ValueError('Current index changed; preserve it and review before retrying')
    backup = Path(backup_file)
    if backup.exists() and backup.read_bytes() != current:
        raise ValueError('Preserve the existing rollback index')
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_bytes(current)
    # Single publisher required: COS+GitHub+origin cannot form one transaction.
    if small_cos_read(client, key) != current:
        raise ValueError('Index changed during preflight')
    try:
        client.put_object(Bucket=BUCKET, Key=key, Body=desired, EnableMD5=True,
                          CacheControl=MUTABLE, ContentType='application/json; charset=utf-8',
                          Metadata={'x-cos-meta-sha256': hashlib.sha256(desired).hexdigest()})
    except Exception:
        raise ValueError('COS index update failed; rerun to check outcome, do not roll back blindly') from None
    if small_cos_read(client, key) != desired or head(client, key).get('cache-control') != MUTABLE:
        raise ValueError('COS index readback/header verification failed')
    return {'passed': True, 'version': plan['version'], 'state': 'activated',
            'previousSha256': previous_sha, 'sha256': sha(latest), 'backup': str(backup),
            'largeCdnDownloads': 0}


def verify_small_index(url, expected):
    allowed = ['https://download.laogao.xyz/', 'https://geod.laogao.xyz/']
    if not any(url.startswith(base) for base in allowed) or not url.endswith('/latest.json'):
        raise ValueError('Only canonical small update indexes may be fetched')
    with urlopen(Request(url, headers={'Accept-Encoding': 'identity'}), timeout=30) as response:
        if not any(response.url.startswith(base) for base in allowed) or not response.url.endswith('/latest.json'):
            raise ValueError('Unexpected redirect for update index')
        if int(response.headers.get('Content-Length', 0)) > SMALL_LIMIT:
            raise ValueError('Refuse large CDN download')
        data = response.read(SMALL_LIMIT + 1)
        if len(data) > SMALL_LIMIT or data != Path(expected).read_bytes():
            raise ValueError('Public small index differs')
    return {'passed': True, 'bytes': len(data), 'largeCdnDownloads': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['plan', 'assets', 'index', 'verify'])
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--previous-sha256')
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--url', default='https://download.laogao.xyz/' + PREFIX + 'latest.json')
    args = parser.parse_args()
    if args.phase == 'plan':
        plan, objects, latest = public_plan(args.plan)
        print(json.dumps({'dryRun': True, 'version': plan['version'], 'objects': len(objects),
                          'uploadMiB': round(sum(i['bytes'] for i in objects) / 1024**2, 2),
                          'indexBytes': latest.stat().st_size, 'largeCdnDownloads': 0}))
        return
    if args.phase == 'verify':
        _, _, latest = public_plan(args.plan)
        result = verify_small_index(args.url, latest)
    else:
        if not args.receipt:
            raise ValueError('A persistent receipt path is required')
        with lock(args.receipt.parent / 'cos-publisher.lock'):
            client = client_from_environment()
            if args.phase == 'assets':
                result = upload_assets(client, args.plan, args.receipt)
            else:
                if not args.previous_sha256 or not args.backup:
                    raise ValueError('Expected previous index hash and backup are required')
                result = activate_index(client, args.plan, args.receipt, args.previous_sha256, args.backup)
                save(args.receipt.with_name('cos-index-receipt.json'), result)
    print(json.dumps({k: v for k, v in result.items() if k != 'objects'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK errors may include signed URLs/headers. Never print those.
        raise SystemExit(str(error) if isinstance(error, ValueError) else
                         'Release COS operation failed (provider details withheld); check credentials/network')
