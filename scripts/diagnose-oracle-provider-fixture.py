"""Read only the owned Oracle fixture's readiness and schema metadata."""
from pathlib import Path
import json
import subprocess
root = Path(__file__).resolve().parents[1] / 'artifacts/product-gaps-20261004/database-providers'
state = json.loads((root / 'oracle-private-state.json').read_text(encoding='utf-8'))
sql = """SELECT NAME,OPEN_MODE FROM V$PDBS;
ALTER SESSION SET CONTAINER=FREEPDB1;
SELECT TABLESPACE_NAME FROM DBA_TABLESPACES;
SELECT USERNAME FROM DBA_USERS WHERE USERNAME LIKE 'GEOD%';
SELECT OWNER,TABLE_NAME FROM DBA_TABLES WHERE OWNER LIKE 'GEOD%';
EXIT;
"""
result = subprocess.run(['docker', 'exec', '-i', state['container'], 'sqlplus', '-s', '/ as sysdba'], input=sql.encode('utf-8'), capture_output=True)
print(result.stdout.decode('utf-8', errors='replace')[:5000])
print(result.stderr.decode('utf-8', errors='replace')[:1000])
