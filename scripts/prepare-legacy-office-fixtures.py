"""Create actual authored DOC/XLS/PPT bytes without using an Office installation."""
from pathlib import Path
import hashlib,json,os,secrets,shutil,subprocess,urllib.request

repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/legacy-office'
root.mkdir(parents=True,exist_ok=True)
assert not (root/'fixtures.json').exists(),'Keep accepted binary files and markers unchanged'
source='https://raw.githubusercontent.com/apache/poi/REL_5_5_1/test-data/document/empty.doc'
expected='5f421a3970c70f12296073478380c0849a54c03fb2f4842392c7d3c5039bf1eb'
template=root/'apache-empty.doc'
if not template.exists():
    with urllib.request.urlopen(source,timeout=60) as response:template.write_bytes(response.read())
assert hashlib.sha256(template.read_bytes()).hexdigest()==expected
markers={key:'OFFICEDATA'+secrets.token_hex(6).upper() for key in ['en','zh','xls','ppt']}
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources/legacy-office'
jar=runtime/'tika-app-3.3.2.jar'
classes=root/'fixture-generator';classes.mkdir(exist_ok=True)
subprocess.run([shutil.which('javac'),'--release','17','-encoding','UTF-8','-cp',str(jar),'-d',str(classes),str(repo/'scripts/LegacyOfficeFixtures.java')],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
subprocess.run([str(runtime/'java/bin/java.exe'),'-Dfile.encoding=UTF-8','-cp',str(classes)+os.pathsep+str(jar),'LegacyOfficeFixtures',str(root),*markers.values()],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
files={name:{'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'bytes':file.stat().st_size}
       for name in ['beijing-brief.doc','北京旧版说明.doc','beijing-table.xls','beijing-slides.ppt','encrypted.xls','damaged.doc','damaged.xls','damaged.ppt','renamed-workbook.doc'] if (file:=root/name).is_file()}
assert len(files)==9 and all((root/name).read_bytes()[:8]==bytes.fromhex('d0cf11e0a1b11ae1') for name in list(files)[:5])
(root/'fixtures.json').write_text(json.dumps({'markers':markers,'template':{'source':source,'sha256':expected},'files':files},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'authored':True,'files':len(files)},ensure_ascii=False))
