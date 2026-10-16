"""Check reviewed build/test evidence before the reusable distribution pipeline."""
import argparse
import json
from pathlib import Path
import re
import subprocess
from release_flow import save, sha


def review(candidate, target, validations, receipt):
    if not re.fullmatch('[a-f0-9]{40}', target):
        raise ValueError('Pin the reviewed source commit')
    candidate = Path(candidate)
    record = json.loads((candidate / 'candidate.json').read_text(encoding='utf-8'))
    for name, expected in record['artifacts'].items():
        if sha(candidate / name) != expected['sha256']:
            raise ValueError('Build artifact differs: ' + name)
    records = []
    signed_build = None
    for file in validations:
        data = json.loads(Path(file).read_text(encoding='utf-8'))
        if data.get('passed') is not True:
            raise ValueError('Build/test evidence not passed: ' + str(file))
        if data.get('version') and data['version'] != record['version']:
            raise ValueError('Build/test version differs')
        records.append({'path': str(file), 'sha256': sha(file)})
        if data.get('candidateHasNoPrivateSigningMaterial') is True:
            signed_build = data
    if not records:
        raise ValueError('Reviewed build/test receipts are required')
    if not signed_build or not signed_build.get('buildInputsUnchangedAcrossBuild') or Path(signed_build['candidate']).resolve() != candidate.resolve():
        raise ValueError('Require the successful frozen signing build receipt for this candidate')
    freeze_file = Path(signed_build['preBuildSourceFreeze'])
    if sha(freeze_file) != signed_build['preBuildSourceFreezeSha256']:
        raise ValueError('Preserve source freeze provenance')
    freeze = json.loads(freeze_file.read_text(encoding='utf-8'))
    root = Path(__file__).resolve().parents[1]
    source = {name: value for name, value in freeze['files'].items()
              if name.startswith(('apps/', 'crates/', 'packages/', 'vendor/')) or name in ('Cargo.toml','Cargo.lock','LICENSE')}
    if any(not (root/name).is_file() or sha(root/name) != value for name,value in source.items()):
        raise ValueError('Build sources changed since this candidate; review/build a new candidate')
    subprocess.run(['git','cat-file','-e',target+'^{commit}'],cwd=root,check=True,capture_output=True)
    # Git normalizes CRLF; source-freeze above verifies actual worktree bytes.
    # Use directory pathspecs: listing thousands of frozen files exceeds the
    # Windows CreateProcess command line limit.
    result = subprocess.run(['git','diff','--quiet',target,'--','apps/','crates/',
                             'packages/','vendor/','Cargo.toml','Cargo.lock','LICENSE'],cwd=root)
    if result.returncode:
        raise ValueError('Reviewed Git target differs from the frozen build sources')
    result = {'passed': True, 'version': record['version'], 'reviewedTarget': target,
              'candidateSha256': sha(candidate / 'candidate.json'), 'validationReceipts': records,
              'evidenceBoundary': 'Target and test scope must be reviewed before generating the recipe'}
    save(receipt, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--target', required=True)
    parser.add_argument('--validation', required=True, action='append', type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(review(args.candidate, args.target, args.validation, args.receipt)))
