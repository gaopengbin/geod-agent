"""Extend only this request's uniquely labelled fixture, with no secret output."""
from pathlib import Path
import json
import subprocess
root = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/sql-inputs'
private = json.loads((root / 'mysql-private-state.json').read_text(encoding='utf-8'))
public = json.loads((root / 'mysql-fixture.json').read_text(encoding='utf-8'))
name = private['container']
assert name.startswith('geod-agent-mysql-input-')
info = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
assert info['Config']['Labels'].get('dev.geod-agent.fixture') == 'sql-input'
database = '实际 属性数据库'
sql = f"""CREATE DATABASE IF NOT EXISTS `{database}` CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS `{database}`.regions LIKE geod_fixture.regions;
INSERT IGNORE INTO `{database}`.regions SELECT * FROM geod_fixture.regions;
CREATE OR REPLACE VIEW `{database}`.current_cities AS SELECT city,score FROM `{database}`.regions;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'geod_reader'@'%';
GRANT SELECT ON geod_fixture.* TO 'geod_reader'@'%';
GRANT SELECT ON `{database}`.* TO 'geod_reader'@'%';
"""
result = subprocess.run(['docker', 'exec', '-i', '--env', 'MYSQL_PWD=' + private['password'], name, 'mysql', '-uroot', '--default-character-set=utf8mb4'], input=sql.encode('utf-8'), capture_output=True)
if result.returncode:
    raise SystemExit('Owned fixture extension failed; private diagnostics retained locally.')
credential = root / 'workspace' / public['credentialFile']
value = json.loads(credential.read_text(encoding='utf-8'))
value['database'] = database
credential.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
public.update(database=database, user='geod_reader', readOnlyRole=True)
(root / 'mysql-fixture.json').write_text(json.dumps(public, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'prepared': True, 'database': database, 'readOnlyRole': True}, ensure_ascii=False))
