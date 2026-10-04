"""Correct only authored fixture rows, independently of SQLPlus client encoding."""
from pathlib import Path
import json
import subprocess
root=Path(__file__).resolve().parents[1]/'artifacts/product-gaps-20261004/database-providers'
state=json.loads((root/'oracle-private-state.json').read_text(encoding='utf-8'))
sql=r"""WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=FREEPDB1;
UPDATE GEOD_FIXTURE.REGIONS SET CITY=UNISTR('\5317\4EAC'),NOTE=UNISTR('\5236\8868\7B26')||CHR(9)||UNISTR('\4E0E\6362\884C')||CHR(10)||UNISTR('\6B63\6587') WHERE ID=1;
UPDATE GEOD_FIXTURE.REGIONS SET CITY=UNISTR('\4E0A\6D77'),NOTE=UNISTR('\5B9E\9645\7B2C\4E8C\6761') WHERE ID=2;
COMMIT;
SELECT ID,ASCIISTR(CITY),ASCIISTR(NOTE) FROM GEOD_FIXTURE.REGIONS ORDER BY ID;
EXIT;
"""
result=subprocess.run(['docker','exec','-i','--env','NLS_LANG=AMERICAN_AMERICA.AL32UTF8',state['container'],'sqlplus','-s','/ as sysdba'],input=sql.encode('ascii'),capture_output=True)
assert result.returncode==0 and b'ORA-' not in result.stdout
assert b'\\5317\\4EAC' in result.stdout and b'\\4E0A\\6D77' in result.stdout
(root/'oracle-independent-unicode.json').write_text(json.dumps({'passed':True,'verification':'Oracle ASCIISTR confirms authored Unicode codepoints before MCP reads','onlyOwnedFixtureRowsChanged':True}),encoding='utf-8')
print(json.dumps({'passed':True,'unicodeFixtureCorrected':True}))
