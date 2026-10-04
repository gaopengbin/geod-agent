"""Disposable certificate-auth PostGIS. Only the labelled GeoD fixture is replaced."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import secrets
import subprocess
import time
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'infra/postgis-test/.secrets/mtls-test'
STATE.mkdir(parents=True, exist_ok=True)
NAME = 'geod-agent-postgis-mtls-test'
LABEL = 'geod-agent-mtls-acceptance'
IMAGE = 'postgis/postgis@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677'

def command(*args, timeout=50):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Docker operation failed: {args[0]}')
    return result.stdout

existing = subprocess.run(['docker', 'inspect', NAME], capture_output=True, timeout=10)
if existing.returncode == 0:
    if json.loads(existing.stdout)[0]['Config'].get('Labels', {}).get('com.geod.purpose') != LABEL:
        raise SystemExit('Container name belongs to another service')
    command('rm', '-f', NAME)

now = datetime.now(timezone.utc)
ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ca_subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'GeoD mTLS local acceptance CA')])
ca = x509.CertificateBuilder().subject_name(ca_subject).issuer_name(ca_subject).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(ca_key, hashes.SHA256())
(STATE/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))

def issue(name, common_name, *, server=False, expired=False, key_size=2048):
    key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    cert = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])).issuer_name(ca_subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=2) if expired else now-timedelta(minutes=5)).not_valid_after(now-timedelta(days=1) if expired else now+timedelta(days=1)).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
    if server:
        cert = cert.add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False)
    cert = cert.sign(ca_key, hashes.SHA256())
    (STATE/f'{name}.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (STATE/f'{name}.key').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return cert, key

issue('server', 'localhost', server=True)
issue('client', 'geod_mtls', key_size=4096)
issue('wrong-user', 'different_role')
issue('expired', 'geod_mtls', expired=True)
(STATE/'password.txt').write_text(secrets.token_urlsafe(32), encoding='utf-8')
(STATE/'pg_hba.conf').write_text('local all all trust\nhostssl all all 0.0.0.0/0 cert\nhostssl all all ::/0 cert\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\n', encoding='utf-8')
(STATE/'init.sql').write_text("""
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE public.regions(id integer PRIMARY KEY,name text,score integer,geom geometry(Polygon,4326));
INSERT INTO public.regions VALUES
 (1,'certificate-east',41,ST_MakeEnvelope(116.1,39.6,116.2,39.7,4326)),
 (2,'certificate-west',42,ST_MakeEnvelope(117.1,40.6,117.2,40.7,4326));
CREATE VIEW public.delayed_regions AS SELECT id,name,score,geom FROM public.regions WHERE (SELECT pg_sleep(30)) IS NULL;
""", encoding='utf-8')
startup = 'install -o postgres -m 600 /geod-cert/server.key /tmp/geod-server.key; install -o postgres -m 644 /geod-cert/server.pem /tmp/geod-server.pem; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/geod-server.pem -c ssl_key_file=/tmp/geod-server.key -c ssl_ca_file=/geod-cert/ca.pem -c hba_file=/geod-cert/pg_hba.conf'
command('run', '-d', '--name', NAME, '--label', f'com.geod.purpose={LABEL}', '-p', '127.0.0.1:55440:5432', '--mount', f'type=bind,source={STATE},target=/geod-cert,readonly', '--mount', f'type=bind,source={STATE / "init.sql"},target=/docker-entrypoint-initdb.d/10-geod.sql,readonly', '-e', 'POSTGRES_USER=geod_mtls', '-e', 'POSTGRES_DB=geod_mtls_test', '-e', 'POSTGRES_PASSWORD_FILE=/geod-cert/password.txt', '--entrypoint', 'sh', IMAGE, '-c', startup)
for _ in range(60):
    ready = subprocess.run(['docker', 'exec', NAME, 'psql', '-U', 'geod_mtls', '-d', 'geod_mtls_test', '-Atc', "SELECT current_setting('ssl'),count(*) FROM public.regions"], capture_output=True, timeout=5)
    if ready.returncode == 0 and ready.stdout.strip() == b'on|2':
        break
    time.sleep(1)
else:
    raise SystemExit('Isolated mTLS fixture did not become ready')
draft = {'name': 'PostGIS client certificate acceptance', 'host': 'localhost', 'port': 55440, 'database': 'geod_mtls_test', 'user': 'geod_mtls', 'password': '', 'sslMode': 'verify-full', 'sslRootCert': (STATE/'ca.pem').read_text(), 'sslClientCert': (STATE/'client.pem').read_text(), 'sslClientKey': (STATE/'client.key').read_text()}
(STATE/'connection.json').write_text(json.dumps(draft), encoding='utf-8')
print(json.dumps({'container': NAME, 'port': 55440, 'authentication': 'client certificate required; no TCP password fallback', 'rows': 2, 'clientKeyBits': 4096, 'credentialFile': str(STATE/'connection.json')}))
