"""Copy verified, public build inputs between worktrees of this same product.

Never copies application profiles, service databases, configuration or signing
secrets. Existing destination files must match; no source is moved or deleted.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
from release_inventory import runtime_directories, inventory

ROOT = Path(__file__).resolve().parents[1]


def sha(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(repo, *args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    reference, output = args.reference.resolve(), args.output.resolve()
    assert reference != ROOT and reference.is_dir()
    assert Path(git(reference, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve() == Path(git(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir')).resolve(), 'Use another worktree of this same repository'
    assert output.is_relative_to(ROOT/'artifacts') and output.name.startswith('release-worktree-inputs-') and not output.exists()
    native = Path('apps/geod-agent-desktop/src-tauri/tauri.conf.json')
    source_config = json.loads((reference/native).read_text(encoding='utf-8'))
    target_config = json.loads((ROOT/native).read_text(encoding='utf-8'))
    assert source_config == target_config and source_config['identifier'] == 'dev.geod-agent.desktop'
    assert source_config['version'] == '0.2.2', 'This preparation reuses the reviewed 0.2.2 reference only'
    assert shutil.disk_usage(ROOT).free > 12*1024**3
    source_inventory = inventory(reference)
    assert len(source_inventory['runtimes']) == 8
    source_head, target_head = git(reference, 'rev-parse', 'HEAD'), git(ROOT, 'rev-parse', 'HEAD')
    output.mkdir(parents=True)
    receipt = {'passed':False,'reference':str(reference),'referenceGitHead':source_head,'targetGitHead':target_head,'sameRepositoryVerified':True,'files':{},'runtimes':{},'installed':False,'published':False,'profileRead':False,'signingPrivateKeyRead':False}
    record = output/'result.json'

    def save():
        record.write_text(json.dumps(receipt, indent=2), encoding='utf-8')

    def copy(source, destination, expected):
        assert source.resolve().is_relative_to(reference) and destination.resolve().is_relative_to(ROOT)
        assert source.is_file() and sha(source) == expected
        if destination.exists():
            assert destination.is_file() and sha(destination) == expected, 'Preserve differing destination input: '+str(destination)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        assert sha(destination) == expected

    save()
    try:
        sources = {name:folder for folder,name in runtime_directories(reference)}
        for destination,name in runtime_directories(ROOT):
            source = sources[name]
            manifest = json.loads((source/'manifest.json').read_text(encoding='utf-8'))
            for relative, value in manifest['files'].items():
                copy(source/relative, destination/relative, value['sha256'] if isinstance(value,dict) else value)
            copy(source/'manifest.json', destination/'manifest.json', sha(source/'manifest.json'))
            receipt['runtimes'][name] = source_inventory['runtimes'][name]
            save()
            print(json.dumps({'runtimePrepared':name,'files':len(manifest['files'])}), flush=True)
        assert inventory(ROOT) == source_inventory
        candidate_relative = Path('artifacts/release-candidate-0.2.2-credits-20261004')
        candidate = json.loads((reference/candidate_relative/'candidate.json').read_text(encoding='utf-8'))
        assert candidate['version'] == '0.2.2' and candidate['runtimeVerification'] == source_inventory['runtimes']
        for name, value in candidate['artifacts'].items():
            assert name in {'GeoD Agent_0.2.2_x64-setup.exe','GeoD-Agent-0.2.2-windows-x64.zip'}
            copy(reference/candidate_relative/name, ROOT/candidate_relative/name, value['sha256'])
            receipt['files'][(candidate_relative/name).as_posix()] = value['sha256']
        for name in ['candidate.json','source-freeze.json']:
            relative=candidate_relative/name
            digest=sha(reference/relative);copy(reference/relative,ROOT/relative,digest);receipt['files'][relative.as_posix()]=digest
        signed_relative=Path('artifacts/update-candidate-0.2.2-20261005')
        signed_receipt=json.loads((reference/signed_relative/'signing-receipt.json').read_text(encoding='utf-8'))
        assert signed_receipt['version']=='0.2.2'
        for name in ['GeoD Agent_0.2.2_x64-setup.exe','GeoD Agent_0.2.2_x64-setup.exe.sig','build-public-config.json']:
            relative=signed_relative/name
            digest=sha(reference/relative)
            if name.endswith('.exe'):
                assert digest==signed_receipt['sha256']
            copy(reference/relative,ROOT/relative,digest);receipt['files'][relative.as_posix()]=digest
        assert git(reference,'rev-parse','HEAD')==source_head and git(ROOT,'rev-parse','HEAD')==target_head
        assert all(sha(reference/name)==digest and sha(ROOT/name)==digest for name,digest in receipt['files'].items())
        receipt.update(passed=True,sourceAssetsPreserved=True,sourceRuntimeInventory=source_inventory)
        save()
        print(json.dumps({'passed':True,'runtimes':8,'runtimeFiles':sum(value['filesVerified'] for value in receipt['runtimes'].values()),'receipt':str(record),'installed':False,'published':False}), flush=True)
    except Exception as error:
        receipt.update(failure=str(error));save();raise


if __name__=='__main__':
    main()
