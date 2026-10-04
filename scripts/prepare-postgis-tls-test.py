"""Isolated, labelled Docker TLS/geography fixture. No user database is changed."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import secrets
import subprocess
import time
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'infra/postgis-test/.secrets/tls-test'
STATE.mkdir(parents=True, exist_ok=True)
NAME = 'geod-agent-postgis-tls-test'
LABEL = 'geod-agent-tls-geography-acceptance'
IMAGE = 'postgis/postgis@sha256:60f6ad1d21ea86a67d47780b9a0d1e1d200500f62b19293fa834d0dea80b8677'

def command(*args, timeout=50):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Docker operation failed: {args[0]}')
    return result.stdout

ready = False
for _ in range(20):
    try:
        command('info', '--format', '{{.ServerVersion}}', timeout=4)
        ready = True
        break
    except (RuntimeError, subprocess.TimeoutExpired):
        time.sleep(2)
if not ready:
    raise SystemExit('Docker engine is not ready; fixture has not been created')
existing = subprocess.run(['docker', 'inspect', NAME], capture_output=True, timeout=10)
if existing.returncode == 0:
    label = json.loads(existing.stdout)[0]['Config'].get('Labels', {}).get('com.geod.purpose')
    if label != LABEL:
        raise SystemExit('Container name belongs to another service')
    command('rm', '-f', NAME)

now = datetime.now(timezone.utc)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'GeoD local acceptance CA')])
ca = x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(key, hashes.SHA256())
server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
server = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])).issuer_name(subject).public_key(server_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False).sign(key, hashes.SHA256())
(STATE/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
(STATE/'server.pem').write_bytes(server.public_bytes(serialization.Encoding.PEM))
(STATE/'server.key').write_bytes(server_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
password = secrets.token_urlsafe(32)
(STATE/'password.txt').write_text(password, encoding='utf-8')
(STATE/'init.sql').write_text("""
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE public.regions(id integer PRIMARY KEY,name text,score integer,geom geometry(Polygon,4326),geog geography(Polygon,4326));
INSERT INTO public.regions VALUES
 (1,'east',10,ST_MakeEnvelope(116.1,39.6,116.2,39.7,4326),ST_MakeEnvelope(116.1,39.6,116.2,39.7,4326)::geography),
 (2,'west',20,ST_MakeEnvelope(117.1,40.6,117.2,40.7,4326),ST_MakeEnvelope(117.1,40.6,117.2,40.7,4326)::geography),
 (3,'third',30,ST_MakeEnvelope(118.1,41.6,118.2,41.7,4326),ST_MakeEnvelope(118.1,41.6,118.2,41.7,4326)::geography);
CREATE INDEX ON public.regions USING gist(geom);
CREATE INDEX ON public.regions USING gist(geog);
""", encoding='utf-8')
startup = 'install -o postgres -m 600 /geod-cert/server.key /tmp/geod-server.key; install -o postgres -m 644 /geod-cert/server.pem /tmp/geod-server.pem; exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/geod-server.pem -c ssl_key_file=/tmp/geod-server.key'
command('run','-d','--name',NAME,'--label',f'com.geod.purpose={LABEL}','-p','127.0.0.1:55439:5432','--mount',f'type=bind,source={STATE},target=/geod-cert,readonly','--mount',f'type=bind,source={STATE / "init.sql"},target=/docker-entrypoint-initdb.d/10-geod.sql,readonly','-e','POSTGRES_USER=geod_tls','-e','POSTGRES_DB=geod_tls_test','-e','POSTGRES_PASSWORD_FILE=/geod-cert/password.txt','--entrypoint','sh',IMAGE,'-c',startup)
for _ in range(60):
    status=subprocess.run(['docker','exec',NAME,'pg_isready','-U','geod_tls','-d','geod_tls_test'],capture_output=True,timeout=5)
    if status.returncode==0:
        break
    time.sleep(1)
else:
    raise SystemExit('Isolated TLS fixture did not become ready')
# Require the TCP server, not the transient init server.
for _ in range(20):
    check=subprocess.run(['docker','exec',NAME,'psql','-U','geod_tls','-d','geod_tls_test','-Atc',"SELECT current_setting('ssl'),count(*) FROM public.regions"],capture_output=True,timeout=5)
    if check.returncode==0 and check.stdout.strip()==b'on|3':
        break
    time.sleep(1)
else:
    raise SystemExit('TLS fixture data was not initialized')
draft={'name':'PostGIS TLS/geography acceptance','host':'localhost','port':55439,'database':'geod_tls_test','user':'geod_tls','password':password,'sslMode':'verify-full','sslRootCert':(STATE/'ca.pem').read_text()}
(STATE/'connection.json').write_text(json.dumps(draft),encoding='utf-8')
print(json.dumps({'container':NAME,'port':55439,'tls':'enabled','certificateDnsName':'localhost','rows':3,'credentialFile':str(STATE/'connection.json')}))
