"""Configure only the labelled Oracle TLS acceptance container."""
from pathlib import Path
import argparse
import json
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--client-auth', action='store_true')
parser.add_argument('--output',type=Path)
args = parser.parse_args()
client_auth = 'TRUE' if args.client_auth else 'FALSE'

repo = Path(__file__).resolve().parents[1]
root = (args.output or repo/'artifacts/product-gaps-20261004/database-tls').resolve()
assert root.is_relative_to(repo/'artifacts/product-gaps-20261004') and not root.is_symlink()
private_root = root / 'private/oracle'
state = json.loads((private_root / 'state.json').read_text())
name = state['container']

def docker(*args, data=None):
    result = subprocess.run(['docker', *args], input=data, capture_output=True)
    if result.returncode:
        text = (result.stdout + result.stderr).decode('utf-8', errors='replace')
        for secret in (state['password'], state['readerPassword'], state['walletPassword']):
            text = text.replace(secret, '[redacted]')
        raise RuntimeError(text[:1500])
    return result.stdout

info = json.loads(docker('inspect', name))[0]
assert info['Config']['Labels']['dev.geod-agent.fixture-id'] == state['fixtureId']
assert info['Config']['Labels']['dev.geod-agent.fixture'] == 'database-tls'
assert info['Image'] == state['imageId']
home = '/opt/oracle/product/26ai/dbhomeFree'
wallet = private_root / 'wallet'
assert (wallet / 'cwallet.sso').is_file()
docker('exec', name, 'mkdir', '-p', '/opt/oracle/geod-tls-wallet')
for file in ('ewallet.p12', 'cwallet.sso'):
    docker('cp', str(wallet / file), name + ':/opt/oracle/geod-tls-wallet/' + file)
docker('exec', '--user', 'root', name, 'chown', '-R', 'oracle:oinstall', '/opt/oracle/geod-tls-wallet')
docker('exec', name, 'chmod', '600', '/opt/oracle/geod-tls-wallet/ewallet.p12', '/opt/oracle/geod-tls-wallet/cwallet.sso')
location = '(SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=/opt/oracle/geod-tls-wallet)))'
listener = f'''DEFAULT_SERVICE_LISTENER=FREE
LISTENER=(DESCRIPTION_LIST=(DESCRIPTION=
  (ADDRESS=(PROTOCOL=TCP)(HOST=0.0.0.0)(PORT=1521))
  (ADDRESS=(PROTOCOL=TCPS)(HOST=0.0.0.0)(PORT=2484))
  (ADDRESS=(PROTOCOL=IPC)(KEY=EXTPROC1521))))
WALLET_LOCATION={location}
SSL_CLIENT_AUTHENTICATION={client_auth}
'''
sqlnet = f'''NAMES.DIRECTORY_PATH=(TNSNAMES,EZCONNECT,HOSTNAME)
DISABLE_OOB=ON
SQLNET.EXPIRE_TIME=3
WALLET_LOCATION={location}
SSL_CLIENT_AUTHENTICATION={client_auth}
'''
for file, content in (('listener.ora', listener), ('sqlnet.ora', sqlnet)):
    host_file = private_root / file
    host_file.write_text(content)
    actual = docker('exec', name, 'readlink', '-f', home + '/network/admin/' + file).decode().strip()
    assert actual == '/opt/oracle/oradata/dbconfig/FREE/' + file
    docker('cp', str(host_file), name + ':' + actual)
    docker('exec', '--user', 'root', name, 'chown', 'oracle:oinstall', actual)
docker('exec', name, 'lsnrctl', 'stop')
docker('exec', name, 'lsnrctl', 'start')
sql = f'''WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SYSTEM REGISTER;
ALTER SESSION SET CONTAINER=FREEPDB1;
BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLESPACE GEOD_TLS DATAFILE ''/opt/oracle/oradata/geod-tls.dbf'' SIZE 20M AUTOEXTEND OFF';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1543 THEN RAISE; END IF; END;
/
BEGIN
  EXECUTE IMMEDIATE 'CREATE USER GEOD_FIXTURE IDENTIFIED BY "{state['readerPassword']}"';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1920 THEN RAISE; END IF; END;
/
ALTER USER GEOD_FIXTURE DEFAULT TABLESPACE GEOD_TLS QUOTA 10M ON GEOD_TLS;
BEGIN
  EXECUTE IMMEDIATE 'CREATE TABLE GEOD_FIXTURE.REGIONS(ID NUMBER PRIMARY KEY,CITY NVARCHAR2(100),MARKER VARCHAR2(100))';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF; END;
/
DELETE FROM GEOD_FIXTURE.REGIONS;
INSERT INTO GEOD_FIXTURE.REGIONS VALUES(1,N'北京','{state['marker']}');
COMMIT;
BEGIN
  EXECUTE IMMEDIATE 'CREATE USER GEOD_READER IDENTIFIED BY "{state['readerPassword']}"';
EXCEPTION WHEN OTHERS THEN IF SQLCODE != -1920 THEN RAISE; END IF; END;
/
GRANT CREATE SESSION TO GEOD_READER;
GRANT SELECT ON GEOD_FIXTURE.REGIONS TO GEOD_READER;
SELECT BANNER_FULL FROM V$VERSION;
EXIT
'''
output = docker('exec', '-i', '--env', 'NLS_LANG=AMERICAN_AMERICA.AL32UTF8', name, 'sqlplus', '-s', '/ as sysdba', data=sql.encode())
assert b'ORA-' not in output
info = json.loads(docker('inspect', name))[0]
port = int(info['NetworkSettings']['Ports']['2484/tcp'][0]['HostPort'])
draft = {'name': 'Oracle TLS acceptance', 'kind': 'oracle', 'host': 'localhost', 'port': port,
         'database': 'FREEPDB1', 'user': 'GEOD_READER', 'password': state['readerPassword'],
         'sslMode': 'verify-full', 'sslRootCert': (private_root / 'ca.pem').read_text()}
(root / 'workspace/oracle-tls.json').write_text(json.dumps(draft, ensure_ascii=False))
fixture = {key: value for key, value in draft.items() if key not in ('password', 'sslRootCert')}
fixture.update({'provider': 'oracle', 'container': name, 'imageId': state['imageId'],
                'marker': state['marker'], 'fixtureId': state['fixtureId'], 'table': 'GEOD_FIXTURE.REGIONS',
                'schema': 'GEOD_FIXTURE', 'credentialFile': 'oracle-tls.json', 'actualVersion': output.decode('utf-8', errors='replace').splitlines()[-8:]})
(root / 'oracle-fixture.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2))
print(json.dumps({'ready': True, 'provider': 'oracle', 'port': port, 'privateCA': True, 'certificateHost': 'localhost', 'clientAuthentication': args.client_auth}))
