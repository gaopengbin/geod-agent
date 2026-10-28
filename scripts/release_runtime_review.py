"""Recheck a retained build when runtime text was only normalized by preparation.

This never builds, signs, mutates a candidate, or accepts executable changes.
The original failed receipt and pre-build snapshot remain immutable evidence.
"""
from pathlib import Path
import hashlib,json
from release_inventory import runtime_directories,verify_runtime

def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def same_text(a,b):
    # Strict UTF-8 and newline-only equivalence; JSON value changes are changes.
    x=Path(a).read_bytes();y=Path(b).read_bytes()
    x.decode('utf-8');y.decode('utf-8')
    return b'\0' not in x+y and x.replace(b'\r\n',b'\n')==y.replace(b'\r\n',b'\n')

def verify(repo,original_receipt,before):
    repo=Path(repo);before=Path(before);original_receipt=Path(original_receipt)
    original=json.loads(original_receipt.read_text(encoding='utf-8'))
    assert original['exitCode']==0 and original['phase']=='failed'
    assert original['failure']=='Actual build source or runtime inputs changed; candidate review is blocked'
    assert original['changedSources']==[] and original['changedBuildInputs']==[]
    assert original['candidateHasNoPrivateSigningMaterial'] and original['frozenAssetsPreserved']
    freeze_file=Path(original['preBuildSourceFreeze']);assert sha(freeze_file)==original['preBuildSourceFreezeSha256']
    freeze=json.loads(freeze_file.read_text(encoding='utf-8'))
    for n,h in freeze['files'].items():
        # Review tooling may change after the build; no build input may change.
        if n.startswith(('apps/','crates/','packages/','vendor/','scripts/prepare-')) or n in ('LICENSE','Cargo.lock','Cargo.toml','scripts/patch-document-crypto.py'):
            assert sha(repo/n)==h,'Build source changed: '+n
    details=[]
    for folder,name in runtime_directories(repo):
        old_folder=before/name;old_manifest=old_folder/'manifest.json'
        assert sha(old_manifest)==freeze['runtimeInputs']['runtimes'][name]['manifestSha256']
        old=json.loads(old_manifest.read_text(encoding='utf-8'));new=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
        assert set(old['files'])==set(new['files']),'Runtime file set changed'
        changed=[]
        for n in old['files']:
            a=old['files'][n];b=new['files'][n]
            if a==b:continue
            assert Path(n).suffix in ('.json','.toml','.mjs'), 'Non-text runtime changed'
            old_file=(old_folder/n).resolve();new_file=(folder/n).resolve()
            assert old_file.is_relative_to(old_folder.resolve()) and new_file.is_relative_to(folder.resolve())
            old_hash=a['sha256']if isinstance(a,dict)else a
            new_hash=b['sha256']if isinstance(b,dict)else b
            assert sha(old_file)==old_hash and sha(new_file)==new_hash
            assert same_text(old_file,new_file),'Runtime text semantics changed: '+n
            if isinstance(a,dict):
                assert a['bytes']==old_file.stat().st_size and b['bytes']==new_file.stat().st_size
                assert {k:v for k,v in a.items()if k not in ('sha256','bytes')}=={k:v for k,v in b.items()if k not in ('sha256','bytes')}
            changed.append(n)
        old_meta={k:v for k,v in old.items()if k!='files'};new_meta={k:v for k,v in new.items()if k!='files'}
        if old_meta!=new_meta:
            assert name=='document-runtime'
            a=old_meta.pop('patchSha256');b=new_meta.pop('patchSha256')
            patch=repo/'scripts/patch-document-crypto.py';old_patch=before/'patch-document-crypto.py'
            assert old_meta==new_meta and sha(old_patch)==a and sha(patch)==b and same_text(old_patch,patch)
        current=verify_runtime(folder)
        details.append({'runtime':name,'filesVerified':current['filesVerified'],'beforeManifestSha256':sha(old_manifest),'afterManifestSha256':current['manifestSha256'],'newlineOnlyFiles':changed})
    return {'passed':True,'originalReceipt':str(original_receipt),'originalReceiptSha256':sha(original_receipt),'before':str(before),'details':details,'scope':'Runtime UTF-8 newlines and manifest formatting only; all executable/content hashes unchanged; original failed record retained'}
