"""Public acceptance reads only four small files; cannot fetch installer assets."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen, Request
from release_cos import verify_small_index
from release_flow import save


def verify(output):
    output = Path(output)
    plan = json.loads((output / 'website-deploy-plan.json').read_text(encoding='utf-8'))
    reads = []
    for origin in ['https://geod.laogao.xyz', 'https://download.laogao.xyz']:
        url = origin + '/agent-updates/windows-x86_64/latest.json'
        reads.append({'url': url, **verify_small_index(url, output / 'latest.json')})
    for route, name in [('/agent', 'agent.html'), ('/en/agent', 'en/agent.html')]:
        with urlopen(Request('https://geod.laogao.xyz'+route, headers={'Accept-Encoding': 'identity'}), timeout=30) as response:
            if response.url != 'https://geod.laogao.xyz'+route:
                raise ValueError('Unexpected site redirect')
            if int(response.headers.get('Content-Length', 0)) > 1024**2:
                raise ValueError('Unexpected large website response')
            data = response.read(1024**2 + 1)
            if len(data) > 1024**2 or hashlib.sha256(data).hexdigest() != plan['files'][name]['sha256']:
                raise ValueError('Published Agent page differs')
            reads.append({'url': response.url, 'bytes': len(data)})
    result = {'passed': True, 'version': plan['version'], 'reads': reads, 'largeCdnDownloads': 0}
    save(output / 'public-verification.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    print(json.dumps(verify(parser.parse_args().output)))
