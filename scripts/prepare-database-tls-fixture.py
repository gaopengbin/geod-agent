"""Owned loopback database with a private CA; never changes Windows trust stores."""
from pathlib import Path
import argparse
import datetime as dt
import json
import secrets
import subprocess
import time
import uuid
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

parser = argparse.ArgumentParser()
parser.add_argument('provider', choices=['mysql', 'mariadb', 'sqlserver', 'oracle'])
parser.add_argument('--reuse', action='store_true')
parser.add_argument('--output',type=Path)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
root = (args.output or repo / 'artifacts/product-gaps-20261004/database-tls').resolve()
assert root.is_relative_to(repo/'artifacts/product-gaps-20261004') and not root.is_symlink()
private_root = root / 'private' / args.provider
workspace = root / 'workspace'
private_root.mkdir(parents=True, exist_ok=True)
workspace.mkdir(parents=True, exist_ok=True)
state_file = private_root / 'state.json'


def docker(*command, text=None):
    return subprocess.run(['docker', *command], input=text.encode() if text else None, capture_output=True)


def certificate(name, issuer=None, client=False, ca=False):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer[1].subject if issuer else subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(hours=1)).not_valid_after(now + dt.timedelta(days=3))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=0 if ca else None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=not ca,
                                        data_encipherment=False, key_agreement=False, key_cert_sign=ca, crl_sign=ca,
                                        encipher_only=False, decipher_only=False), critical=True))
    if not ca:
        cert = cert.add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH if client else ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
    if not ca and not client:
        cert = cert.add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False)
    return key, cert.sign(issuer[0] if issuer else key, hashes.SHA256())


def write_pair(name, pair):
    (private_root / f'{name}.pem').write_bytes(pair[1].public_bytes(serialization.Encoding.PEM))
    (private_root / f'{name}.key').write_bytes(pair[0].private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))


if state_file.exists():
    if not args.reuse:
        raise SystemExit('Owned fixture already exists; inspect or reuse it.')
    private = json.loads(state_file.read_text())
    info = json.loads(docker('inspect', private['container']).stdout)[0]
    assert info['Config']['Labels'].get('dev.geod-agent.fixture') == 'database-tls'
else:
    existing = repo / 'artifacts/product-gaps-20261004' / ('sql-inputs/mysql-fixture.json' if args.provider == 'mysql' else f'database-providers/{args.provider}-fixture.json')
    image = json.loads(existing.read_text())['imageId']
    inspected = json.loads(docker('image', 'inspect', image).stdout)[0]
    assert inspected['Id'] == image
    ca = certificate('GeoD TLS QA ' + uuid.uuid4().hex, ca=True)
    wrong = certificate('GeoD wrong CA ' + uuid.uuid4().hex, ca=True)
    for name, pair in [('ca', ca), ('wrong-ca', wrong), ('server', certificate('localhost', ca)),
                       ('client', certificate('geod-client', ca, client=True)), ('wrong-client', certificate('wrong-client', wrong, client=True))]:
        write_pair(name, pair)
    name = 'geod-agent-tls-' + args.provider + '-' + uuid.uuid4().hex[:8]
    private = {'container': name, 'password': 'Gd9!' + secrets.token_hex(24),
               'readerPassword': 'Gd9!' + secrets.token_hex(24), 'walletPassword': 'Gd9!' + secrets.token_hex(16),
               'marker': args.provider.upper() + '_TLS_' + uuid.uuid4().hex.upper(), 'imageId': image,
               'fixtureId': uuid.uuid4().hex}
    state_file.write_text(json.dumps(private), encoding='utf-8')
    environment = ({'MYSQL_ROOT_PASSWORD': private['password']} if args.provider == 'mysql' else
                   {'MARIADB_ROOT_PASSWORD': private['password']} if args.provider == 'mariadb' else
                   {'ACCEPT_EULA': 'Y', 'MSSQL_PID': 'Developer', 'MSSQL_SA_PASSWORD': private['password'], 'MSSQL_MEMORY_LIMIT_MB': '2048'} if args.provider == 'sqlserver' else
                   {'ORACLE_PWD': private['password'], 'ORACLE_CHARACTERSET': 'AL32UTF8'})
    env_file = private_root / 'database.env'
    env_file.write_text('\n'.join(f'{key}={value}' for key, value in environment.items()) + '\n')
    inside = {'mysql': 3306, 'mariadb': 3306, 'sqlserver': 1433, 'oracle': 1521}[args.provider]
    command = ['run', '--detach', '--name', name, '--label', 'dev.geod-agent.fixture=database-tls',
               '--label', 'dev.geod-agent.fixture-id=' + private['fixtureId'], '--publish', f'127.0.0.1::{inside}',
               '--memory', '3g' if args.provider in ['sqlserver', 'oracle'] else '1g',
               '--mount', f'type=bind,source={private_root},target=/qa,readonly', '--env-file', str(env_file)]
    if args.provider == 'oracle': command += ['--publish', '127.0.0.1::2484']
    command += [image]
    if args.provider in ['mysql', 'mariadb']:
        command += ['--ssl-ca=/qa/ca.pem', '--ssl-cert=/qa/server.pem', '--ssl-key=/qa/server.key', '--require-secure-transport=ON']
    started = docker(*command)
    env_file.unlink()
    if started.returncode: raise SystemExit('Owned TLS container failed to start; retain state for cleanup.')

name = private['container']


def execute(sql):
    if args.provider in ['mysql', 'mariadb']:
        command = ['exec', '-i', '--env', 'MYSQL_PWD=' + private['password'], name,
                   'mysql' if args.provider == 'mysql' else 'mariadb', '-uroot', '--default-character-set=utf8mb4', '--batch']
    elif args.provider == 'sqlserver':
        command = ['exec', '-i', '--env', 'SQLCMDPASSWORD=' + private['password'], name,
                   '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-C', '-b', '-f', '65001']
    else:
        command = ['exec', '-i', '--env', 'NLS_LANG=AMERICAN_AMERICA.AL32UTF8', name, 'sqlplus', '-s', '/ as sysdba']
        sql = 'WHENEVER SQLERROR EXIT SQL.SQLCODE\n' + sql + '\nEXIT\n'
    return docker(*command, text=sql)


print(json.dumps({'phase': 'starting-private-CA-database', 'provider': args.provider, 'container': name}), flush=True)
deadline = time.monotonic() + 300
while time.monotonic() < deadline:
    if args.provider == 'oracle' and b'DATABASE IS READY TO USE!' not in docker('logs', name).stdout:
        time.sleep(2)
        continue
    probe = execute('SELECT 1;\nGO\n' if args.provider == 'sqlserver' else "SELECT OPEN_MODE FROM V$PDBS WHERE NAME='FREEPDB1';" if args.provider == 'oracle' else 'SELECT 1;')
    if probe.returncode == 0 and (args.provider != 'oracle' or b'READ WRITE' in probe.stdout): break
    time.sleep(2)
else: raise SystemExit('Owned TLS database did not become ready; retain state.')

database = 'geod_tls' if args.provider != 'oracle' else 'FREEPDB1'
reader = 'geod_reader' if args.provider != 'oracle' else 'GEOD_READER'
marker = private['marker']
if args.provider in ['mysql', 'mariadb']:
    sql = f"""CREATE DATABASE IF NOT EXISTS geod_tls CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS geod_tls.regions (id BIGINT PRIMARY KEY,city VARCHAR(100),marker VARCHAR(100));
REPLACE INTO geod_tls.regions VALUES(1,'北京','{marker}');
CREATE USER IF NOT EXISTS 'geod_reader'@'%' IDENTIFIED BY '{private['readerPassword']}' REQUIRE SSL;
CREATE USER IF NOT EXISTS 'geod_client'@'%' IDENTIFIED BY '{private['readerPassword']}' REQUIRE X509;
GRANT SELECT ON geod_tls.* TO 'geod_reader'@'%';
GRANT SELECT ON geod_tls.* TO 'geod_client'@'%';
SELECT VERSION();"""
elif args.provider == 'sqlserver':
    config = '[network]\ntlscert=/var/opt/mssql/geod-server.pem\ntlskey=/var/opt/mssql/geod-server.key\ntlsprotocols=1.2\nforceencryption=1\n'
    (private_root / 'mssql.conf').write_text(config)
    configured = docker('exec', '--user', 'root', name, '/bin/bash', '-c',
                        'install -o mssql -g mssql -m 440 /qa/server.pem /var/opt/mssql/geod-server.pem && install -o mssql -g mssql -m 440 /qa/server.key /var/opt/mssql/geod-server.key && install -o mssql -g mssql -m 640 /qa/mssql.conf /var/opt/mssql/mssql.conf')
    if configured.returncode: raise SystemExit('SQL Server TLS file configuration failed')
    if docker('restart', name).returncode: raise SystemExit('Owned SQL Server restart failed')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if execute('SELECT 1;\nGO\n').returncode == 0: break
        time.sleep(2)
    else: raise SystemExit('SQL Server did not return after its TLS configuration')
    sql = f"""IF DB_ID(N'geod_tls') IS NULL CREATE DATABASE geod_tls;
GO
IF SUSER_ID(N'geod_reader') IS NULL CREATE LOGIN geod_reader WITH PASSWORD=N'{private['readerPassword']}';
GO
USE geod_tls;
GO
IF OBJECT_ID(N'dbo.regions') IS NULL CREATE TABLE dbo.regions(id BIGINT PRIMARY KEY,city NVARCHAR(100),marker NVARCHAR(100));
DELETE FROM dbo.regions;
INSERT INTO dbo.regions VALUES(1,N'北京',N'{marker}');
IF USER_ID(N'geod_reader') IS NULL CREATE USER geod_reader FOR LOGIN geod_reader;
GRANT SELECT ON dbo.regions TO geod_reader;
SELECT @@VERSION;
GO
"""
else:
    # Oracle needs a native auto-login wallet for both listener and server TLS.
    from cryptography.hazmat.primitives.serialization import pkcs12
    server_key = serialization.load_pem_private_key((private_root / 'server.key').read_bytes(), None)
    server_cert = x509.load_pem_x509_certificate((private_root / 'server.pem').read_bytes())
    ca_cert = x509.load_pem_x509_certificate((private_root / 'ca.pem').read_bytes())
    (private_root / 'server.p12').write_bytes(pkcs12.serialize_key_and_certificates(b'geod-server', server_key, server_cert, [ca_cert], serialization.BestAvailableEncryption(private['walletPassword'].encode())))
    raise SystemExit('Oracle wallet setup is prepared; configure the exact owned listener before acceptance.')

result = execute(sql)
if result.returncode: raise SystemExit('Owned database SQL initialization failed; private fixture state retained.')
info = json.loads(docker('inspect', name).stdout)[0]
inside = {'mysql': 3306, 'mariadb': 3306, 'sqlserver': 1433}[args.provider]
port = int(info['NetworkSettings']['Ports'][f'{inside}/tcp'][0]['HostPort'])
draft = {'name': args.provider + ' TLS acceptance', 'kind': 'mysql' if args.provider == 'mariadb' else args.provider,
         'host': 'localhost', 'port': port, 'database': database, 'user': reader,
         'password': private['readerPassword'], 'sslMode': 'verify-full', 'sslRootCert': (private_root / 'ca.pem').read_text()}
(workspace / f'{args.provider}-tls.json').write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
fixture = {key: value for key, value in draft.items() if key not in ['password', 'sslRootCert']}
fixture.update({'provider': args.provider, 'container': name, 'imageId': private['imageId'], 'marker': marker,
                'fixtureId': private['fixtureId'], 'table': 'regions', 'schema': 'dbo' if args.provider == 'sqlserver' else database,
                'credentialFile': f'{args.provider}-tls.json', 'actualVersion': result.stdout.decode('utf-8', errors='replace').splitlines()[-15:]})
(root / f'{args.provider}-fixture.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'ready': True, 'provider': args.provider, 'port': port, 'certificateHost': 'localhost', 'privateCA': True}))
