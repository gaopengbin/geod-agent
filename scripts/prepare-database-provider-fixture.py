"""Disposable, loopback-only provider fixtures; credentials never enter evidence."""
from pathlib import Path
import argparse
import json
import secrets
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('provider', choices=['mariadb', 'sqlserver', 'oracle'])
parser.add_argument('--reuse', action='store_true', help='Retry initialization in the exact owned fixture')
args = parser.parse_args()
provider = args.provider
root = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/database-providers'
workspace = root / 'workspace'
workspace.mkdir(parents=True, exist_ok=True)
private_file = root / f'{provider}-private-state.json'
if private_file.exists() and not args.reuse:
    raise SystemExit('Fixture state exists; reuse it or clean the owned fixture first.')

images = {'mariadb': 'mariadb:11.8', 'sqlserver': 'mcr.microsoft.com/mssql/server:2025-latest',
          'oracle': 'container-registry.oracle.com/database/free:latest-lite'}
image_name = images[provider]
name = f'geod-agent-provider-{provider}-' + uuid.uuid4().hex[:8]
password = 'Gd9!' + secrets.token_hex(24)
reader_password = 'Gd9!' + secrets.token_hex(24)
marker = provider.upper() + '_' + uuid.uuid4().hex.upper()
port_inside = {'mariadb': 3306, 'sqlserver': 1433, 'oracle': 1521}[provider]
if args.reuse:
    private = json.loads(private_file.read_text(encoding='utf-8'))
    name,password,reader_password,marker = (private[key] for key in ['container','password','readerPassword','marker'])
    assert name.startswith(f'geod-agent-provider-{provider}-')
    owned = json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
    assert owned['Config']['Labels'].get('dev.geod-agent.fixture') == 'database-provider'
    image = json.loads(subprocess.check_output(['docker','image','inspect',owned['Image']],text=True))[0]
else:
    print(json.dumps({'phase': 'pulling-official-image', 'provider': provider}), flush=True)
    pull = subprocess.run(['docker', 'pull', image_name], capture_output=True)
    if pull.returncode:
        raise SystemExit('Official database image download failed: ' + pull.stderr.decode('utf-8', errors='replace')[:700])
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image_name], text=True))[0]
    digest = image['RepoDigests'][0]
    environment = {'mariadb': {'MARIADB_ROOT_PASSWORD': password},
                   'sqlserver': {'ACCEPT_EULA': 'Y', 'MSSQL_PID': 'Developer', 'MSSQL_SA_PASSWORD': password, 'MSSQL_MEMORY_LIMIT_MB': '3072'},
                   'oracle': {'ORACLE_PWD': password, 'ORACLE_CHARACTERSET': 'AL32UTF8'}}[provider]
    env_file = root / f'{provider}-private.env'
    env_file.write_text('\n'.join(f'{key}={value}' for key, value in environment.items()) + '\n', encoding='utf-8')
    private = {'container': name, 'password': password, 'readerPassword': reader_password, 'marker': marker,
               'credentialFile': provider + '-connection.json', 'environmentFile': env_file.name}
    private_file.write_text(json.dumps(private), encoding='utf-8')
    started = subprocess.run(['docker', 'run', '--detach', '--name', name, '--label', 'dev.geod-agent.fixture=database-provider',
                             '--publish', f'127.0.0.1::{port_inside}', '--memory', '4g' if provider == 'sqlserver' else '3g',
                             '--env-file', str(env_file), digest], capture_output=True)
    if started.returncode:
        raise SystemExit('Owned database container did not start; retain private state for cleanup.')
    env_file.unlink()

def execute(sql):
    if provider == 'mariadb':
        command = ['docker', 'exec', '-i', '--env', 'MYSQL_PWD=' + password, name,
                   'mariadb', '-uroot', '--default-character-set=utf8mb4', '--batch']
    elif provider == 'sqlserver':
        command = ['docker', 'exec', '-i', '--env', 'SQLCMDPASSWORD=' + password, name,
                   '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-C', '-b', '-f', '65001']
    else:
        command = ['docker', 'exec', '-i', '--env', 'NLS_LANG=AMERICAN_AMERICA.AL32UTF8', name, 'sqlplus', '-s', '/ as sysdba']
        sql = 'WHENEVER SQLERROR EXIT SQL.SQLCODE\n' + sql + '\nEXIT\n'
    return subprocess.run(command, input=sql.encode('utf-8'), capture_output=True)

print(json.dumps({'phase': 'starting-database', 'provider': provider, 'container': name}), flush=True)
deadline = time.monotonic() + 300
probe = 'SELECT 1;\nGO\n' if provider == 'sqlserver' else "SELECT OPEN_MODE FROM V$PDBS WHERE NAME='FREEPDB1';" if provider == 'oracle' else 'SELECT 1;'
while time.monotonic() < deadline:
    if provider == 'oracle':
        log = subprocess.run(['docker','logs',name],capture_output=True)
        if b'DATABASE IS READY TO USE!' not in log.stdout + log.stderr:
            time.sleep(2)
            continue
    check = execute(probe)
    if check.returncode == 0 and (provider != 'oracle' or b'ORA-' not in check.stdout and b'READ WRITE' in check.stdout):
        break
    time.sleep(2)
else:
    raise SystemExit('Database did not become ready; retain private fixture state for cleanup.')

database = 'GeoD_输入_验收' if provider != 'oracle' else 'FREEPDB1'
schema = database if provider == 'mariadb' else 'dbo' if provider == 'sqlserver' else 'GEOD_FIXTURE'
reader = 'geod_reader' if provider != 'oracle' else 'GEOD_READER'
if provider == 'mariadb':
    sql = f"""CREATE DATABASE `{database}` CHARACTER SET utf8mb4;
CREATE TABLE `{database}`.regions (id BIGINT PRIMARY KEY,city VARCHAR(100),score DECIMAL(10,2),marker VARCHAR(100),note TEXT,big_integer BIGINT);
INSERT INTO `{database}`.regions VALUES (1,'北京',18.25,'{marker}','制表符\\t与换行\\n正文',9223372036854775806),(2,'上海',31.75,'second','实际第二条',NULL);
CREATE VIEW `{database}`.current_cities AS SELECT city,score FROM `{database}`.regions;
CREATE USER '{reader}'@'%' IDENTIFIED BY '{reader_password}';
GRANT SELECT ON `{database}`.* TO '{reader}'@'%';
SELECT VERSION();"""
elif provider == 'sqlserver':
    sql = f"""CREATE DATABASE [{database}];
GO
CREATE LOGIN [{reader}] WITH PASSWORD=N'{reader_password}';
GO
USE [{database}];
GO
CREATE TABLE dbo.regions (id BIGINT PRIMARY KEY,city NVARCHAR(100),score DECIMAL(10,2),marker NVARCHAR(100),note NVARCHAR(MAX),big_integer BIGINT);
INSERT INTO dbo.regions VALUES (1,N'北京',18.25,N'{marker}',N'制表符'+CHAR(9)+N'与换行'+CHAR(10)+N'正文',9223372036854775806),(2,N'上海',31.75,N'second',N'实际第二条',NULL);
GO
CREATE VIEW dbo.current_cities AS SELECT city,score FROM dbo.regions;
GO
CREATE USER [{reader}] FOR LOGIN [{reader}];
GRANT SELECT ON SCHEMA::dbo TO [{reader}];
SELECT @@VERSION;
GO
"""
else:
    sql = f"""ALTER SESSION SET CONTAINER=FREEPDB1;
CREATE TABLESPACE GEOD_FIXTURE_TS DATAFILE '/opt/oracle/oradata/FREE/FREEPDB1/geod_fixture_qa.dbf' SIZE 20M;
CREATE USER GEOD_FIXTURE IDENTIFIED BY "{password}" DEFAULT TABLESPACE GEOD_FIXTURE_TS QUOTA 10M ON GEOD_FIXTURE_TS;
CREATE USER GEOD_READER IDENTIFIED BY "{reader_password}";
GRANT CREATE SESSION TO GEOD_READER;
CREATE TABLE GEOD_FIXTURE.REGIONS (ID NUMBER(19) PRIMARY KEY,CITY NVARCHAR2(100),SCORE NUMBER(10,2),MARKER VARCHAR2(100),NOTE NVARCHAR2(1000),BIG_INTEGER NUMBER(19));
INSERT INTO GEOD_FIXTURE.REGIONS VALUES (1,UNISTR('\\5317\\4EAC'),18.25,'{marker}',UNISTR('\\5236\\8868\\7B26')||CHR(9)||UNISTR('\\4E0E\\6362\\884C')||CHR(10)||UNISTR('\\6B63\\6587'),9223372036854775806);
INSERT INTO GEOD_FIXTURE.REGIONS VALUES (2,UNISTR('\\4E0A\\6D77'),31.75,'second',UNISTR('\\5B9E\\9645\\7B2C\\4E8C\\6761'),NULL);
CREATE VIEW GEOD_FIXTURE.CURRENT_CITIES AS SELECT CITY,SCORE FROM GEOD_FIXTURE.REGIONS;
GRANT SELECT ON GEOD_FIXTURE.REGIONS TO GEOD_READER;
GRANT SELECT ON GEOD_FIXTURE.CURRENT_CITIES TO GEOD_READER;
COMMIT;
SELECT BANNER FROM V$VERSION;"""
prepared = execute(sql)
if prepared.returncode or b'ORA-' in prepared.stdout or b'Msg ' in prepared.stdout:
    diagnostics = (prepared.stdout + prepared.stderr).decode('utf-8', errors='replace').replace(password, '[redacted]').replace(reader_password, '[redacted]')
    (root / f'{provider}-initialization-diagnostic.txt').write_text(diagnostics, encoding='utf-8')
    # All SQL contains private credentials: diagnostics must not print its content.
    raise SystemExit('Provider fixture initialization failed; retain its private state for diagnosis.')
mapping = subprocess.check_output(['docker', 'port', name, f'{port_inside}/tcp'], text=True).strip()
port = int(mapping.rsplit(':', 1)[1])
draft = {'kind': 'mysql' if provider == 'mariadb' else provider, 'name': f'Actual {provider} provider QA',
         'host': '127.0.0.1', 'port': port, 'database': database, 'user': reader,
         'password': reader_password, 'sslMode': 'require' if provider == 'sqlserver' else 'disable'}
(workspace / private['credentialFile']).write_text(json.dumps(draft, ensure_ascii=False), encoding='utf-8')
receipt = {**{key: value for key, value in draft.items() if key != 'password'}, 'provider': provider, 'schema': schema,
           'table': f'{schema}.REGIONS' if provider == 'oracle' else 'regions', 'credentialFile': private['credentialFile'],
           'marker': marker, 'container': name, 'imageId': image['Id'], 'repoDigests': image['RepoDigests'],
           'actualVersion': prepared.stdout.decode('utf-8', errors='replace').splitlines()[-8:]}
assert password not in json.dumps(receipt) and reader_password not in json.dumps(receipt)
(root / f'{provider}-fixture.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'prepared': True, 'provider': provider, 'container': name, 'port': port}), flush=True)
