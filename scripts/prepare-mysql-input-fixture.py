"""A private, uniquely named local Docker fixture; no production databases are modified."""
from pathlib import Path
import json
import secrets
import subprocess
import time
import uuid

root = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/sql-inputs'
state_path = root / 'mysql-private-state.json'
if state_path.exists():
    raise SystemExit('Private fixture state already exists; reuse the existing fixture.')
name = 'geod-agent-mysql-input-' + uuid.uuid4().hex[:8]
password = secrets.token_urlsafe(32)
marker = 'MYSQL_' + uuid.uuid4().hex.upper()
subprocess.run(['docker', 'pull', 'mysql:8.4'], check=True)
subprocess.run(['docker', 'run', '--detach', '--name', name, '--label', 'dev.geod-agent.fixture=sql-input', '--publish', '127.0.0.1::3306',
                '--env', 'MYSQL_ROOT_PASSWORD=' + password, '--env', 'MYSQL_DATABASE=geod_fixture', '--env', 'MYSQL_USER=geod_reader', '--env', 'MYSQL_PASSWORD=' + password,
                'mysql:8.4'], check=True, stdout=subprocess.DEVNULL)
private = {'container': name, 'password': password, 'marker': marker}
state_path.write_text(json.dumps(private), encoding='utf-8')
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    result = subprocess.run(['docker', 'exec', '--env', 'MYSQL_PWD=' + password, name, 'mysql', '-uroot', '--batch', '-e', 'SELECT 1'],
                            capture_output=True)
    if result.returncode == 0:
        break
    time.sleep(2)
else:
    raise SystemExit('MySQL fixture did not start within 180 seconds; retain its private state for cleanup.')
sql = f"""CREATE TABLE geod_fixture.regions (id BIGINT PRIMARY KEY, city VARCHAR(100), score DECIMAL(10,2), marker VARCHAR(100), note TEXT, big_integer BIGINT);
INSERT INTO geod_fixture.regions VALUES (1,'北京',18.25,'{marker}','制表符\\t与换行\\n正文',9223372036854775806),(2,'上海',31.75,'second','实际第二条',NULL);
CREATE VIEW geod_fixture.current_cities AS SELECT city,score FROM geod_fixture.regions;
GRANT SELECT ON geod_fixture.* TO 'geod_reader'@'%';
"""
result = subprocess.run(['docker', 'exec', '-i', '--env', 'MYSQL_PWD=' + password, name, 'mysql', '-uroot', '--default-character-set=utf8mb4'],
                        input=sql.encode('utf-8'), capture_output=True)
if result.returncode:
    raise SystemExit('MySQL fixture data preparation failed.')
mapping = subprocess.check_output(['docker', 'port', name, '3306/tcp'], text=True).strip()
port = int(mapping.rsplit(':', 1)[1])
credential = root / 'workspace' / 'mysql-connection.json'
credential.write_text(json.dumps({'kind': 'mysql', 'name': '实际 MySQL 输入验收', 'host': '127.0.0.1', 'port': port,
                                 'database': 'geod_fixture', 'user': 'geod_reader', 'password': password, 'sslMode': 'disable'}), encoding='utf-8')
private['credentialFile'] = credential.name
state_path.write_text(json.dumps(private), encoding='utf-8')
image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', 'mysql:8.4'], text=True))[0]
(root / 'mysql-fixture.json').write_text(json.dumps({'container': name, 'imageId': image['Id'], 'repoDigests': image.get('RepoDigests'),
    'credentialFile': credential.name, 'host': '127.0.0.1', 'port': port, 'marker': marker}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'prepared': True, 'container': name, 'database': 'geod_fixture', 'port': port}))
