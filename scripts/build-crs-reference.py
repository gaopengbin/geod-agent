"""Regenerate the small read-only EPSG option reference from local PROJ data.

Developer utility only; pyproj is not required by the desktop application.
The actual database version and SHA-256 are always recorded in the output.
"""
from pathlib import Path
import hashlib
import json
import sqlite3
import pyproj

root = Path(__file__).resolve().parents[1]
database = Path(pyproj.datadir.get_data_dir()) / 'proj.db'
with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
    metadata = dict(db.execute('select key,value from metadata'))
entries = {}
for info in pyproj.database.query_crs_info(auth_name='EPSG'):
    if not info.code.isdigit() or not 0 < int(info.code) < 32767:
        continue
    crs = pyproj.CRS.from_epsg(int(info.code))
    if not (crs.is_geographic or crs.is_projected):
        continue
    meridian = None
    if crs.coordinate_operation:
        for parameter in crs.coordinate_operation.params:
            if str(parameter.auth_name) == 'EPSG' and str(parameter.code) in ['8802', '8812', '8822', '8833']:
                meridian = parameter.value
                break
    entries[info.code] = {'name': crs.name, **({'centralMeridian': meridian} if meridian is not None else {})}
reference = {'schemaVersion': 1, 'source': {
    'authority': 'EPSG', 'sourceDatabase': 'PROJ proj.db',
    'databaseSha256': hashlib.sha256(database.read_bytes()).hexdigest(),
    'EPSG.VERSION': metadata.get('EPSG.VERSION'), 'PROJ.VERSION': metadata.get('PROJ.VERSION'),
    'purpose': 'Read-only reference for checking model-proposed CRS option descriptions; not a projection engine.',
}, 'entries': entries}
destination = root / 'contracts/crs-options.v1.json'
destination.write_text(json.dumps(reference, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
print(json.dumps({'entries': len(entries), 'source': reference['source']}, ensure_ascii=False))
