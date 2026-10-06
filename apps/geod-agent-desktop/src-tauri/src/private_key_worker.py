"""Local PEM/PKCS12 unlock; secrets use pipes, never files or argv."""
import base64, binascii, json, sys

def fail(code):
    print(json.dumps({'ok':False,'error':code}));raise SystemExit(1)

try:
    sys.path.insert(0,sys.argv[1])
    from cryptography import x509
    from cryptography.exceptions import UnsupportedAlgorithm
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import pkcs12
except (ImportError,IndexError):fail('INPUT_TLS_KEY_RUNTIME')

try:
    raw=sys.stdin.buffer.read(512*1024+1)
    if len(raw)>512*1024:fail('INPUT_TLS_INVALID')
    request=json.loads(raw)
    password=request.get('password')
    if password is not None and (not isinstance(password,str) or len(password.encode())>4096):fail('INPUT_TLS_KEY_PASSWORD_INPUT')
    bundle=request.get('bundle')
    if bundle is not None:
        if not isinstance(bundle,str) or len(bundle)>350*1024 or request.get('key') or request.get('certificate'):fail('INPUT_TLS_BUNDLE_INVALID')
        try:data=base64.b64decode(bundle,validate=True)
        except (ValueError,binascii.Error):fail('INPUT_TLS_BUNDLE_INVALID')
        if not data or len(data)>256*1024:fail('INPUT_TLS_BUNDLE_INVALID')
        try:key,cert,chain=pkcs12.load_key_and_certificates(data,None)
        except ValueError:
            if not password:fail('INPUT_TLS_BUNDLE_PASSWORD_REQUIRED')
            try:key,cert,chain=pkcs12.load_key_and_certificates(data,password.encode('utf-8'))
            except ValueError:fail('INPUT_TLS_BUNDLE_OPEN_FAILED')
        if key is None or cert is None:fail('INPUT_TLS_BUNDLE_INVALID')
        certificate=''.join(value.public_bytes(serialization.Encoding.PEM).decode('ascii') for value in [cert,*(chain or [])])
        if len(certificate.encode())>256*1024:fail('INPUT_TLS_BUNDLE_INVALID')
    else:
        pem,certificate=(request.get(k) for k in ['key','certificate'])
        if not isinstance(pem,str) or not isinstance(certificate,str) or len(pem.encode())>64*1024 or len(certificate.encode())>256*1024:fail('INPUT_TLS_INVALID')
        data=pem.encode('utf-8')
        try:key=serialization.load_pem_private_key(data,None)
        except TypeError:
            if not password:fail('INPUT_TLS_KEY_PASSWORD_REQUIRED')
            try:key=serialization.load_pem_private_key(data,password.encode('utf-8'))
            except ValueError:fail('INPUT_TLS_KEY_PASSWORD_INCORRECT')
        cert=x509.load_pem_x509_certificate(certificate.encode('utf-8'))
    public=lambda value:value.public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    if public(cert.public_key())!=public(key.public_key()):fail('INPUT_TLS_INVALID')
    output=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode('ascii')
    if len(output.encode())>64*1024:fail('INPUT_TLS_INVALID')
    print(json.dumps({'ok':True,'key':output,**({'certificate':certificate} if bundle is not None else {})}))
except UnsupportedAlgorithm:fail('INPUT_TLS_BUNDLE_UNSUPPORTED' if 'bundle' in locals() and bundle is not None else 'INPUT_TLS_KEY_UNSUPPORTED')
except (ValueError,TypeError,KeyError,AttributeError):fail('INPUT_TLS_INVALID')
except Exception:fail('INPUT_TLS_INVALID')
