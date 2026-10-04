"""Fetch pinned public repository evidence for the GIS MCP comparison."""
import concurrent.futures
import argparse
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.error
import urllib.request
import zipfile

REPOS = ["crystaldba/postgres-mcp", "pgEdge/pgedge-postgres-mcp", "JordanGunn/gdal-mcp", "neverinfamous/postgres-mcp", "receptopalak/postgis-mcp", "microsoft/postgres-mcp"]

def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "GeoD-Agent-research", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()

def inspect(repo):
    meta = json.loads(fetch(f"https://api.github.com/repos/{repo}"))
    head = json.loads(fetch(f"https://api.github.com/repos/{repo}/commits/{meta['default_branch']}"))
    tree = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/trees/{head['sha']}?recursive=1"))
    try:
        release = json.loads(fetch(f"https://api.github.com/repos/{repo}/releases/latest"))
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        release = {}
    return {"repo": repo, "url": meta['html_url'], "sha": head['sha'], "commitDate": head['commit']['committer']['date'], "pushedAt": meta['pushed_at'], "stars": meta['stargazers_count'], "archived": meta['archived'], "license": (meta.get('license') or {}).get('spdx_id'), "release": release.get('tag_name'), "releaseDate": release.get('published_at'), "assets": [{"name": item['name'], "url": item['browser_download_url']} for item in release.get('assets', [])], "files": [item['path'] for item in tree['tree'] if item['type'] == 'blob']}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache')
    parser.add_argument('--toolbox', action='store_true')
    args = parser.parse_args()
    if args.cache:
        cache = Path(args.cache).resolve()
        if args.toolbox:
            item = inspect('googleapis/mcp-toolbox')
            destination = cache / 'googleapis__mcp-toolbox'
            destination.mkdir(exist_ok=True)
            paths = ['README.md', 'LICENSE', 'docs/en/integrations/postgres/source.md', 'docs/en/integrations/postgres/prebuilt-configs/postgresql.md', 'docs/en/integrations/postgres/tools/postgres-execute-sql.md', 'internal/prebuiltconfigs/postgres.yaml']
            for path in paths:
                try:
                    (destination / path.replace('/', '__')).write_bytes(fetch(f"https://raw.githubusercontent.com/googleapis/mcp-toolbox/v1.13.1/{path}"))
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
            url = 'https://storage.googleapis.com/mcp-toolbox-for-databases/v1.13.1/windows/amd64/toolbox.exe'
            request = urllib.request.Request(url, headers={'User-Agent': 'GeoD-Agent-research'}, method='HEAD')
            with urllib.request.urlopen(request, timeout=30) as response:
                item['googleHashHeader'] = ','.join(response.headers.get_all('x-goog-hash', []))
                expected_length = int(response.headers['Content-Length'])
            executable = destination / 'toolbox-1.13.1.exe'
            if not executable.exists() or executable.stat().st_size != expected_length:
                with urllib.request.urlopen(url, timeout=60) as response, executable.open('wb') as stream:
                    downloaded = 0
                    while chunk := response.read(1024 * 1024):
                        stream.write(chunk)
                        downloaded += len(chunk)
                        if downloaded % (50 * 1024 * 1024) == 0:
                            print(json.dumps({'downloadedMiB': downloaded // (1024 * 1024)}), flush=True)
            md5 = hashlib.md5()
            sha256 = hashlib.sha256()
            with executable.open('rb') as stream:
                while chunk := stream.read(1024 * 1024):
                    md5.update(chunk)
                    sha256.update(chunk)
            expected_md5 = item['googleHashHeader'].split('md5=', 1)[1].split(',', 1)[0]
            assert base64.b64encode(md5.digest()).decode() == expected_md5
            item['binaryUrl'] = url
            item['binarySha256'] = sha256.hexdigest()
            item['binaryBytes'] = executable.stat().st_size
            (destination / 'metadata.json').write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({key: value for key, value in item.items() if key != 'files'}, ensure_ascii=False))
            return
        results = json.loads((cache / 'repositories.json').read_text(encoding='utf-8'))
        selected = {
            'pgEdge/pgedge-postgres-mcp': ['docs/guide/env_variable_config.md', 'docs/guide/claude_desktop.md', 'docs/guide/multiple_db_config.md', 'docs/reference/tools.md', 'internal/tools/database_switching.go', 'internal/tools/get_schema_info.go', 'internal/config/config.go'],
            'crystaldba/postgres-mcp': ['src/postgres_mcp/server.py', 'src/postgres_mcp/sql/sql_driver.py', 'src/postgres_mcp/sql/safe_sql.py'],
            'neverinfamous/postgres-mcp': ['src/adapters/postgresql/tools/postgis/query.ts', 'src/adapters/postgresql/tools/postgis/standalone.ts', 'src/adapters/postgresql/resources/postgis.ts', 'src/cli.ts'],
            'receptopalak/postgis-mcp': ['server.ts', 'agentic/database-connections.ts'],
            'microsoft/postgres-mcp': ['USAGE.md', 'CHANGELOG.md'],
        }
        for item in results:
            destination = cache / item['repo'].replace('/', '__')
            for path in selected.get(item['repo'], []):
                if path in item['files']:
                    target = destination / path.replace('/', '__')
                    target.write_bytes(fetch(f"https://raw.githubusercontent.com/{item['repo']}/{item['sha']}/{path}"))
                    print(str(target))
            if item['repo'] == 'pgEdge/pgedge-postgres-mcp':
                for asset in item['assets']:
                    if asset['name'] in {'checksums.txt', 'pgedge-postgres-mcp-server_1.1.0_windows_x86_64.zip'}:
                        target = destination / asset['name']
                        target.write_bytes(fetch(asset['url']))
                        if target.suffix == '.zip':
                            with zipfile.ZipFile(target) as archive:
                                root = (destination / 'windows-1.1.0').resolve()
                                for member in archive.namelist():
                                    if not (root / member).resolve().is_relative_to(root):
                                        raise ValueError('Archive path escapes research directory')
                                archive.extractall(root)
                                print(json.dumps({'archiveFiles': archive.namelist()}))
        return
    cache = Path(tempfile.mkdtemp(prefix="geod-gis-mcp-research-"))
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(inspect, REPOS))
    for item in results:
        repo_cache = cache / item['repo'].replace('/', '__')
        repo_cache.mkdir()
        for path in item['files']:
            if path.lower() in {"readme.md", "pyproject.toml", "package.json", "go.mod", "license", "license.md"}:
                (repo_cache / path.replace('/', '__')).write_bytes(fetch(f"https://raw.githubusercontent.com/{item['repo']}/{item['sha']}/{path}"))
        print(json.dumps({key: value for key, value in item.items() if key != 'files'}, ensure_ascii=False))
        relevant = [path for path in item['files'] if any(word in path.lower() for word in ['postgis', 'connection', 'server.py', 'server.ts', 'integration', 'tool', 'test', 'workflows'])]
        print(json.dumps({"repo": item['repo'], "relevantFiles": relevant[:50]}, ensure_ascii=False))
    (cache / "repositories.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({"cache": str(cache)}))

if __name__ == '__main__':
    main()
