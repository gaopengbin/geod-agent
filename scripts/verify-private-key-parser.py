"""Exercise real pinned key decryption with independent generated RSA/EC/Ed keys."""
from pathlib import Path
import datetime as dt, json, os, secrets, subprocess, uuid
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa,ec,ed25519
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID

repo=Path(__file__).resolve().parents[1]
root=repo/'artifacts/product-gaps-20261004/database-keys'
private=root/'private/parser'
private.mkdir(parents=True,exist_ok=True)
state_file=private/'inputs.json'
assert not state_file.exists(),'Preserve existing private fixture identities'
runtime=repo/'apps/geod-agent-desktop/src-tauri/resources'
script=(repo/'apps/geod-agent-desktop/src-tauri/src/private_key_worker.py').read_text(encoding='utf-8')
env={key:os.environ[key] for key in ['SYSTEMROOT','WINDIR','TEMP','TMP'] if key in os.environ}
env['PATH']=str(Path(os.environ['SYSTEMROOT'])/'System32')
inputs={};rows=[]
def request(value):
    result=subprocess.run([str(runtime/'gdal/python.exe'),'-X','utf8','-I','-c',script,str(runtime/'documents')],
        input=json.dumps(value,ensure_ascii=False).encode(),capture_output=True,env=env,
        creationflags=subprocess.CREATE_NO_WINDOW,timeout=25)
    parsed=json.loads(result.stdout)
    assert bool(parsed['ok'])==(result.returncode==0)
    return parsed
def check(name,value,code=None):
    response=request(value)
    if code:assert response.get('error')==code,(name,response.get('error'))
    else:
        assert response['ok']
        key=serialization.load_pem_private_key(response['key'].encode(),None)
        cert=x509.load_pem_x509_certificate(value['certificate'].encode())
        public=lambda item:item.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
        assert public(key.public_key())==public(cert.public_key())
    rows.append(dict(name=name,passed=True,errorCode=code))
    print(json.dumps(dict(name=name,passed=True)),flush=True)
now=dt.datetime.now(dt.timezone.utc)
sources=[('rsa-pkcs8',rsa.generate_private_key(public_exponent=65537,key_size=2048),serialization.PrivateFormat.PKCS8),
         ('rsa-traditional',rsa.generate_private_key(public_exponent=65537,key_size=3072),serialization.PrivateFormat.TraditionalOpenSSL),
         ('ec-pkcs8',ec.generate_private_key(ec.SECP256R1()),serialization.PrivateFormat.PKCS8),
         ('ec-traditional',ec.generate_private_key(ec.SECP384R1()),serialization.PrivateFormat.TraditionalOpenSSL),
         ('ed25519-pkcs8',ed25519.Ed25519PrivateKey.generate(),serialization.PrivateFormat.PKCS8)]
for name,key,format in sources:
    subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'GeoD '+name+' '+uuid.uuid4().hex)])
    cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-dt.timedelta(hours=1)).not_valid_after(now+dt.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]),False)
        .sign(key,None if name.startswith('ed25519') else hashes.SHA256()))
    password='密钥🗝-'+secrets.token_hex(16)
    value=dict(key=key.private_bytes(serialization.Encoding.PEM,format,serialization.BestAvailableEncryption(password.encode())).decode(),
        certificate=cert.public_bytes(serialization.Encoding.PEM).decode(),password=password)
    inputs[name]=value
    state_file.write_text(json.dumps(inputs,ensure_ascii=False),encoding='utf-8')
    check(name+' missing',dict(value,password=None),'INPUT_TLS_KEY_PASSWORD_REQUIRED')
    check(name+' incorrect',dict(value,password='INCORRECT_QA_VALUE'),'INPUT_TLS_KEY_PASSWORD_INCORRECT')
    check(name+' correct',value)
value=inputs['rsa-pkcs8']
check('Unencrypted key ignores an unnecessary passphrase',dict(value,key=sources[0][1].private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()))
check('Correct password with a different certificate',dict(value,certificate=inputs['ec-pkcs8']['certificate']),'INPUT_TLS_INVALID')
check('Malformed encrypted PEM is not a password challenge',dict(value,key='-----BEGIN ENCRYPTED PRIVATE KEY-----\nbroken\n-----END ENCRYPTED PRIVATE KEY-----'),'INPUT_TLS_INVALID')
check('Overlong password',dict(value,password='x'*4097),'INPUT_TLS_KEY_PASSWORD_INPUT')
check('Non-text password',dict(value,password=['incorrect']),'INPUT_TLS_KEY_PASSWORD_INPUT')
check('Non-object request',[],'INPUT_TLS_INVALID')
result=dict(passed=True,cases=rows,runtime='Pinned CPython 3.13 and cryptography 50.0.2',secretOutputSaved=False)
(root/'parser-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(dict(passed=True,cases=len(rows),decryptedKeysSaved=False)))
