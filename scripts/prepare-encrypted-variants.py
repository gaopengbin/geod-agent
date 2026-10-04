"""Independent cipher variants and a tampered authenticated payload."""
from pathlib import Path
import hashlib,json,os,secrets,shutil,subprocess
repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/encrypted-documents'
workspace=root/'workspace'
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources/legacy-office';jar=runtime/'tika-app-3.3.2.jar'
file=root/'variant-fixtures.json';assert not file.exists(),'Do not replace verified cipher variants'
password_file=root/'private-passwords.json'
passwords=json.loads(password_file.read_text(encoding='utf-8'))
variants=[]
for name,cipher,hash_name,chaining in [('agile-192.docx','aes192','sha384','cbc'),('agile-256.docx','aes256','sha512','cbc'),('agile-256-sha1.docx','aes256','sha1','cbc'),('empty-password.docx','aes128','sha1','cbc'),('cfb-mode.docx','aes128','sha512','cfb')]:
    password='' if name=='empty-password.docx' else 'QA_VARIANT_'+secrets.token_hex(20)
    passwords[name]=password;variants.append(dict(name=name,cipher=cipher,hash=hash_name,chaining=chaining,password=password))
classes=root/'fixture-generator'
subprocess.run([shutil.which('javac'),'--release','17','-encoding','UTF-8','-cp',str(jar),'-d',str(classes),str(repo/'scripts/EncryptedOfficeFixtures.java')],check=True,creationflags=subprocess.CREATE_NO_WINDOW)
out=subprocess.run([str(runtime/'java/bin/java.exe'),'-Dfile.encoding=UTF-8','-cp',str(classes)+os.pathsep+str(jar),'EncryptedOfficeFixtures',str(workspace)],input=json.dumps(dict(variants=variants)).encode('utf-8'),capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
assert out.returncode==0,out.stderr.decode('utf-8',errors='replace')
shutil.copyfile(workspace/'agile-256.docx',workspace/'damaged-integrity.docx')
passwords['damaged-integrity.docx']=passwords['agile-256.docx']
code='''import sys
sys.path.insert(0,sys.argv[2])
import olefile
with olefile.OleFileIO(sys.argv[1],write_mode=True) as ole:
  data=bytearray(ole.openstream('EncryptedPackage').read());data[-33]^=1;ole.write_stream('EncryptedPackage',bytes(data))
'''
subprocess.run([str(repo/'apps/geod-agent-desktop/src-tauri/resources/gdal/python.exe'),'-I','-X','utf8','-c',code,str(workspace/'damaged-integrity.docx'),str(repo/'apps/geod-agent-desktop/src-tauri/resources/documents')],capture_output=True,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
result=[{key:value for key,value in row.items() if key!='password'} for row in variants]
result.append(dict(name='damaged-integrity.docx',cipher='aes256',hash='sha512',chaining='cbc',tampered=True))
for row in result:
    data=(workspace/row['name']).read_bytes();row.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
file.write_text(json.dumps(result,indent=2),encoding='utf-8')
password_file.write_text(json.dumps(passwords,ensure_ascii=False),encoding='utf-8')
print(json.dumps(dict(prepared=True,variants=len(result),passwordsInPublicEvidence=False)))
