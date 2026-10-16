"""Generate a resumable, reviewed release recipe from an already built candidate.

Build/signing stays in build-signed-update-candidate.py; this command does not
rebuild a package just to publish it. Test/build receipts are required inputs.
"""
import argparse
import json
from pathlib import Path
import sys
from release_flow import save

ROOT = Path(__file__).resolve().parents[1]


def recipe(spec):
    candidate = Path(spec['candidate']).resolve()
    output = Path(spec['output']).resolve()
    if not candidate.is_relative_to(ROOT / 'artifacts') or not output.is_relative_to(ROOT / 'artifacts'):
        raise ValueError('Candidate and publisher state must stay in repo artifacts')
    if not spec.get('validationReceipts'):
        raise ValueError('Reviewed build and changed-area test receipts are required')
    version = json.loads((candidate/'candidate.json').read_text(encoding='utf-8'))['version']
    def relative(file):
        file = Path(file).resolve()
        if not file.is_relative_to(ROOT):
            raise ValueError('Release input must be inside repo')
        return file.relative_to(ROOT).as_posix()
    c, o = relative(candidate), relative(output)
    notes, config = relative(spec['notes']), relative(spec['publicConfig'])
    validate = [relative(path) for path in spec['validationReceipts']]
    python = sys.executable
    steps = []
    def step(name, command, inputs, outputs, effect='local', reuse=True):
        steps.append({'id': name, 'command': command, 'inputs': inputs, 'outputs': outputs,
                      'effect': effect, 'reuse': reuse})
    step('review', [python, '-X', 'utf8', 'scripts/release_review.py', '--candidate', c,
         '--target', spec['target'], '--receipt', o+'/review.json', *sum([['--validation', p] for p in validate], [])],
         ['scripts/release_review.py', c+'/candidate.json', *validate], [o+'/review.json'], reuse=False)
    step('signatures', ['node', 'scripts/verify-release-signatures.mjs', c, config, o+'/signatures.json'],
         ['scripts/verify-release-signatures.mjs', 'scripts/update-candidate.mjs', config,
          c+'/latest.json', c+'/component-update.json', c+'/*.exe', c+'/*.tar.gz'], [o+'/signatures.json'])
    step('payload', [python, '-X', 'utf8', 'scripts/release_payload.py', c, o+'/payload.json'],
         ['scripts/release_payload.py', 'scripts/extract-release-candidate.py', 'scripts/release_inventory.py', c+'/candidate.json',
          c+'/*.exe', c+f'/GeoD-Agent-{version}-windows-x64/geod-agent-desktop.exe'], [o+'/payload.json', c+'/installer-payload'])
    step('public-files', [python, '-X', 'utf8', 'scripts/release_prepare.py', '--candidate', c,
         '--output', o, '--signatures', o+'/signatures.json', '--notes', notes],
         ['scripts/release_prepare.py', o+'/review.json', o+'/signatures.json', o+'/payload.json', notes,
          c+'/candidate.json', c+'/latest.json', c+'/component-update.json', c+'/*.exe', c+'/*.sig', c+'/*.zip', c+'/*.tar.gz'],
         [o+'/public-objects.json', o+'/latest.json', o+'/cos-'+version, o+'/github-'+version])
    plan = o+'/public-objects.json'
    publisher_python = spec.get('publisherPython') or next((str(path) for path in [
        ROOT/'artifacts/release-tools/Scripts/python.exe',
        ROOT/'artifacts/release-flow-tools/venv/Scripts/python.exe'] if path.is_file()), python)
    step('cos-assets', [publisher_python, '-X', 'utf8', 'scripts/release_cos.py', 'assets', '--plan', plan,
         '--receipt', o+'/cos-assets.json'], ['scripts/release_cos.py', plan, o+'/cos-'+version],
         [o+'/cos-assets.json'], 'cloud', False)
    common = ['--plan', plan, '--target', spec['target'], '--notes', notes]
    step('github-draft', [python, '-X', 'utf8', 'scripts/release_github.py', 'stage', *common,
         '--receipt', o+'/github-draft.json'], ['scripts/release_github.py', plan, notes, o+'/github-'+version],
         [o+'/github-draft.json'], 'cloud', False)
    # Website content and its preview remain authored/reviewed before publishing.
    # Build is local; publisher packages only Agent pages + hashed shared assets.
    for item in spec.get('websiteSteps', []):
        steps.append(item)
    site = spec['websiteBuild']
    release_id = spec['releaseId']
    step('origin-prepare', [python, '-X', 'utf8', 'scripts/release_origin.py', 'prepare', '--site', site,
         '--latest', o+'/latest.json', '--output', o, '--release-id', release_id],
         ['scripts/release_origin.py', o+'/latest.json', plan],
         [o+'/website-deploy-plan.json', o+'/website-agent.tar.gz'], 'server-read')
    steps[-1]['externalInputs'] = [str(Path(site)/name) for name in ['agent.html','agent.txt','en/agent.html','en/agent.txt','_next/static']]
    step('github-publish', [python, '-X', 'utf8', 'scripts/release_github.py', 'publish', *common,
         '--receipt', o+'/github-published.json'], ['scripts/release_github.py', plan, notes,
         o+'/cos-assets.json', o+'/github-draft.json', o+'/github-'+version], [o+'/github-published.json'], 'cloud', False)
    step('origin-activate', [python, '-X', 'utf8', 'scripts/release_origin.py', 'activate', '--output', o,
         '--latest', o+'/latest.json'], ['scripts/release_origin.py', 'scripts/release_activate.py',
         o+'/website-deploy-plan.json', o+'/website-agent.tar.gz', o+'/latest.json', o+'/github-published.json'],
         [o+'/origin-activation.json'], 'server', False)
    step('cos-index', [publisher_python, '-X', 'utf8', 'scripts/release_cos.py', 'index', '--plan', plan,
         '--receipt', o+'/cos-assets.json', '--previous-sha256', spec['previousCdnIndexSha256'],
         '--backup', o+'/cdn-latest-before.json'], ['scripts/release_cos.py', plan, o+'/cos-assets.json',
         o+'/origin-activation.json'], [o+'/cos-index-receipt.json'], 'cloud', False)
    step('public-verify', [python, '-X', 'utf8', 'scripts/release_verify.py', '--output', o],
         ['scripts/release_verify.py', o+'/public-objects.json', o+'/website-deploy-plan.json',
          o+'/latest.json', o+'/cos-index-receipt.json'], [o+'/public-verification.json'], 'read', False)
    return {'root': str(ROOT), 'state': o+'/flow', 'version': version, 'steps': steps}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path)
    parser.add_argument('--recipe', required=True, type=Path)
    args = parser.parse_args()
    result = recipe(json.loads(args.spec.read_text(encoding='utf-8')))
    save(args.recipe, result)
    print(json.dumps({'prepared': True, 'version': result['version'], 'steps': len(result['steps']),
                      'recipe': str(args.recipe), 'published': False}))
