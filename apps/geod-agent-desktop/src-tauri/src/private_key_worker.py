"""Local PEM unlock; secrets enter and leave through pipes, never files or argv."""
import json, sys

def fail(code):
    print(json.dumps({'ok':False,'error':code}));raise SystemExit(1)

try:
    sys.path.insert(0,sys.argv[1])
    from cryptography import x509
    from cryptography.exceptions import UnsupportedAlgorithm
    from cryptography.hazmat.primitives import serialization
except (ImportError,IndexError):fail('INPUT_TLS_KEY_RUNTIME')

try:
    raw=sys.stdin.buffer.read(512*1024+1)
    if len(raw)>512*1024:fail('INPUT_TLS_INVALID')
    request=json.loads(raw)
    pem,certificate,password=(request.get(k) for k in ['key','certificate','password'])
    if not isinstance(pem,str) or not isinstance(certificate,str) or len(pem.encode())>64*1024 or len(certificate.encode())>256*1024:
        fail('INPUT_TLS_INVALID')
    if password is not None and (not isinstance(password,str) or len(password.encode())>4096):fail('INPUT_TLS_KEY_PASSWORD_INPUT')
    data=pem.encode('utf-8')
    try:
        key=serialization.load_pem_private_key(data,None)
    except TypeError:
        if not password:fail('INPUT_TLS_KEY_PASSWORD_REQUIRED')
        try:key=serialization.load_pem_private_key(data,password.encode('utf-8'))
        except ValueError:fail('INPUT_TLS_KEY_PASSWORD_INCORRECT')
    cert=x509.load_pem_x509_certificate(certificate.encode('utf-8'))
    public=lambda value:value.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    if public(cert.public_key())!=public(key.public_key()):fail('INPUT_TLS_INVALID')
    output=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode('ascii')
    print(json.dumps({'ok':True,'key':output}))
except UnsupportedAlgorithm:fail('INPUT_TLS_KEY_UNSUPPORTED')
except (ValueError,TypeError,KeyError,AttributeError):fail('INPUT_TLS_INVALID')
except Exception:fail('INPUT_TLS_INVALID')
