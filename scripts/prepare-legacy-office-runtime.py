"""Prepare a private, hash-pinned Java/Office parser; no system installation."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, urllib.request, zipfile

repo = Path(__file__).resolve().parents[1]
resource_parent = (repo/'apps/geod-agent-desktop/src-tauri/resources').resolve()
destination = resource_parent/'legacy-office'
lock = repo/'vendor/legacy-office-runtime.lock.json'
source = repo/'apps/geod-agent-desktop/src-tauri/src/GeodOfficeReader.java'
def digest(file, algorithm='sha256'):
    with file.open('rb') as stream: return hashlib.file_digest(stream, algorithm).hexdigest()
manifest_path = destination/'manifest.json'
if manifest_path.is_file():
    value = json.loads(manifest_path.read_text(encoding='utf-8'))
    if value.get('systemUcrt') is True and value.get('lockSha256')==digest(lock) and value.get('sourceSha256')==digest(source) and all(
        (destination/name).is_file() and digest(destination/name)==expected for name,expected in value['files'].items()):
        print(f"Verified bundled legacy Office reader: {len(value['files'])} files"); raise SystemExit(0)
pins = json.loads(lock.read_text(encoding='utf-8'))
cache = Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/runtime-cache'
cache.mkdir(parents=True,exist_ok=True)
archives = {}
for key,item in pins.items():
    file = cache/item['filename']; algorithm = 'sha512' if 'sha512' in item else 'sha256'
    if not file.is_file() or digest(file,algorithm)!=item[algorithm]:
        pending = file.with_suffix(file.suffix+'.pending')
        print('Downloading pinned '+item['filename'],flush=True)
        with urllib.request.urlopen(item['url'],timeout=60) as response, pending.open('wb') as output:
            shutil.copyfileobj(response,output)
        assert digest(pending,algorithm)==item[algorithm], 'Pinned runtime checksum mismatch'
        pending.replace(file)
    archives[key]=file
if destination.exists():
    assert destination.resolve().parent==resource_parent,'Unexpected generated resource target'
    shutil.rmtree(destination)
destination.mkdir(parents=True)
with zipfile.ZipFile(archives['java']) as bundle:
    assert all((destination/item.filename).resolve().is_relative_to(destination) for item in bundle.infolist()), 'Unsafe runtime archive path'
    # Windows 10/11 always use the OS UCRT, even when a JRE ships a newer copy.
    # Keep the reviewed archive intact; package only the effective runtime files.
    # https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment
    for item in bundle.infolist():
        if Path(item.filename).name.lower() != 'ucrtbase.dll': bundle.extract(item, destination)
java_roots = [p for p in destination.iterdir() if p.is_dir() and (p/'bin/java.exe').exists()]
assert len(java_roots)==1
java_roots[0].rename(destination/'java')
jar = destination/pins['tika']['filename']; shutil.copyfile(archives['tika'],jar)
with zipfile.ZipFile(jar) as bundle:
    for name in ['META-INF/LICENSE','META-INF/NOTICE']:
        if name in bundle.namelist(): (destination/Path(name).name).write_bytes(bundle.read(name))
assert (destination/'LICENSE').is_file() and (destination/'NOTICE').is_file()
javac = shutil.which('javac')
assert javac,'Build requires a Java 21 JDK; the application only ships a private JRE'
subprocess.run([javac,'--release','17','-encoding','UTF-8','-g:none','-cp',str(jar),'-d',str(destination),str(source)],
               check=True,creationflags=subprocess.CREATE_NO_WINDOW)
environment = {key:value for key,value in os.environ.items() if key.upper() in {'SYSTEMROOT','WINDIR','TEMP','TMP'}}
environment['PATH']=str(Path(os.environ['SYSTEMROOT'])/'System32')
result=subprocess.run([str(destination/'java/bin/java.exe'),'-Dfile.encoding=UTF-8','-cp',str(destination)+os.pathsep+str(jar),'GeodOfficeReader','--runtime-check'],
                      env=environment,capture_output=True,encoding='utf-8',check=True,creationflags=subprocess.CREATE_NO_WINDOW)
runtime=json.loads(result.stdout);assert runtime['ready'] is True
manifest = {'name':'geod-legacy-office','version':pins['tika']['version'],'javaVersion':pins['java']['version'],
            'poiVersion':runtime['poiVersion'],'systemUcrt':True,'minimumWindowsVersion':'10',
            'lockSha256':digest(lock),'sourceSha256':digest(source),'files':{p.relative_to(destination).as_posix():digest(p) for p in sorted(destination.rglob('*')) if p.is_file()}}
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'prepared':True,'files':len(manifest['files']),'bytes':sum(p.stat().st_size for p in destination.rglob('*') if p.is_file())}))
