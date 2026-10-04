"""Resolve official maintained Tika and Windows Temurin archives into reviewed pins."""
from pathlib import Path
import json
import urllib.request

repo = Path(__file__).resolve().parents[1]
version = '3.3.2'
checksum_url = f'https://downloads.apache.org/tika/{version}/tika-app-{version}.jar.sha512'
with urllib.request.urlopen(checksum_url, timeout=60) as response:
    checksum = response.read().decode().strip().split()[0]
assert len(checksum) == 128 and all(c in '0123456789abcdefABCDEF' for c in checksum)
java_version = '21.0.12.1+1'
java_filename = 'OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip'
java_url = f'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/{java_filename}'
with urllib.request.urlopen(java_url+'.sha256.txt', timeout=60) as response:
    java_checksum = response.read().decode().strip().split()[0]
assert len(java_checksum) == 64
value = {'tika': {'version': version, 'filename': f'tika-app-{version}.jar',
                  'url': f'https://downloads.apache.org/tika/{version}/tika-app-{version}.jar',
                  'sha512': checksum.lower(), 'checksumSource': checksum_url,
                  'license': 'Apache-2.0'},
         'java': {'version': java_version, 'filename': java_filename,
                  'url': java_url, 'sha256': java_checksum,
                  'checksumSource': java_url+'.sha256.txt', 'license': 'GPL-2.0-with-classpath-exception'}}
target = repo / 'vendor/legacy-office-runtime.lock.json'
assert not target.exists(), 'Keep reviewed pins; do not silently upgrade'
target.write_text(json.dumps(value, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'tika':version,'java':value['java']['version']}))
