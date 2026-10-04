"""Create only the uniquely named local SQL acceptance fixtures."""
from pathlib import Path
import json
import sqlite3
import uuid

root = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/sql-inputs'
workspace = root / 'workspace'
workspace.mkdir(parents=True, exist_ok=True)
state = root / 'fixture-state.json'
if state.exists():
    raise SystemExit('Fixture state already exists; reuse it instead of recreating databases.')
table = '实际 属性"表'
marker = 'SQL_' + uuid.uuid4().hex.upper()
database = workspace / '普通属性.sqlite'
with sqlite3.connect(database) as connection:
    connection.execute('CREATE TABLE "实际 属性""表" (id INTEGER PRIMARY KEY, city TEXT, score REAL, note TEXT, big_integer INTEGER)')
    connection.executemany('INSERT INTO "实际 属性""表" VALUES(?,?,?,?,?)', [(1, '北京', 18.25, marker + '\t换行\n正文', 9223372036854775806), (2, '上海', 31.75, '实际第二条记录', None)])
    connection.execute('CREATE TABLE many_rows (id INTEGER PRIMARY KEY)')
    connection.executemany('INSERT INTO many_rows VALUES (?)', [(n,) for n in range(1, 606)])
    connection.execute('CREATE VIEW current_cities AS SELECT city, score FROM "实际 属性""表"')
fixture = {'sqlite': {'name': '实际 SQLite 读取验收', 'relativePath': database.name, 'table': table, 'marker': marker, 'total': 50}}
state.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'sqlitePrepared': True, 'path': str(database), 'marker': marker}))
