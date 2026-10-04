"""Compare published MCP servers against the existing synthetic PostGIS fixture.

The credentials are loaded locally and passed only in child process environment.
This checks actual stdio MCP calls, not GeoD or LLM integration.
"""
import argparse
import ast
import asyncio
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.parse import quote

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
DISCOVERY = """SELECT g.f_table_schema AS schema, g.f_table_name AS table_name,
 g.f_geometry_column AS geometry_column, g.type, g.srid
 FROM geometry_columns g JOIN pg_namespace n ON n.nspname=g.f_table_schema
 JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=g.f_table_name
 WHERE has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT')
 ORDER BY 1,2,3 LIMIT 201"""

def decode(result):
    texts = [item.text for item in result.content if getattr(item, 'type', None) == 'text']
    if result.isError:
        return None, texts
    if len(texts) > 1:
        try:
            return [json.loads(text) for text in texts], texts
        except ValueError:
            pass
    for text in texts:
        for decoder in [json.loads, ast.literal_eval]:
            try:
                return decoder(text), texts
            except (ValueError, SyntaxError):
                pass
        bracket = text.find('[')
        if bracket >= 0:
            try:
                return json.loads(text[bracket:]), texts
            except ValueError:
                pass
        if '\nResults (' in text:
            lines = text.split('\nResults (', 1)[1].splitlines()[1:]
            if len(lines) >= 2:
                data = []
                for row in csv.DictReader(io.StringIO('\n'.join(lines)), delimiter='\t'):
                    for key, value in row.items():
                        try:
                            row[key] = json.loads(value)
                        except (ValueError, TypeError):
                            pass
                    data.append(row)
                return data, texts
    if result.structuredContent is not None:
        return result.structuredContent, texts
    return None, texts

def rows(value):
    if isinstance(value, list):
        if value and all(isinstance(item, dict) and item.get('type') == 'text' and 'text' in item for item in value):
            return []
        return value
    if isinstance(value, dict):
        for key in ['rows', 'data', 'results', 'result']:
            if key in value:
                return rows(value[key])
        if value:
            return [value]
    return []

async def probe(name, parameters, record, stderr_path):
    with stderr_path.open('w', encoding='utf-8') as errlog:
        async with stdio_client(parameters, errlog=errlog) as (read, write):
            async with ClientSession(read, write) as session:
                started = asyncio.get_running_loop().time()
                init = await asyncio.wait_for(session.initialize(), 45)
                record['server'] = init.serverInfo.model_dump(mode='json')
                record['protocolVersion'] = init.protocolVersion
                record['initializeSeconds'] = round(asyncio.get_running_loop().time() - started, 3)
                tools = (await session.list_tools()).tools
                record['tools'] = [tool.name for tool in tools]
                query = 'query_database' if name == 'pgedge' else 'execute_sql'
                record['querySchema'] = next(tool.inputSchema for tool in tools if tool.name == query)
                key = 'query' if name == 'pgedge' else 'sql'
                async def call(label, sql):
                    began = asyncio.get_running_loop().time()
                    result = await asyncio.wait_for(session.call_tool(query, {key: sql}), 40)
                    value, text = decode(result)
                    item = {'name': label, 'seconds': round(asyncio.get_running_loop().time() - began, 3), 'isError': bool(result.isError), 'value': value, 'text': text}
                    record.setdefault('calls', []).append(item)
                    return item, rows(value)
                item, layers = await call('discover_spatial_layers', DISCOVERY)
                assert not item['isError'] and len(layers) == 13, 'Expected 13 visible spatial layer/geometry entries'
                assert all(layer['schema'] != 'hidden' for layer in layers)
                item, attrs = await call('read_attributes', 'SELECT id,name FROM demo.boundaries_3857 LIMIT 2')
                assert not item['isError'] and attrs[0]['name'] == '北京测试范围'
                item, fields = await call('read_fields', "SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='demo.boundaries_3857'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")
                assert len(fields) == 3 and fields[-1]['type'] == 'geometry(Polygon,3857)'
                item, data = await call('transform_3857_to_4326_preserve_hole', 'SELECT ST_AsGeoJSON(ST_Transform(geom,4326))::json AS geometry FROM demo.boundaries_3857 LIMIT 1')
                assert not item['isError'] and not any(text.startswith('Error:') for text in item['text']), 'PostGIS ST_Transform/ST_AsGeoJSON rejected by candidate SQL validator'
                geometry = data[0]['geometry']
                if isinstance(geometry, str):
                    geometry = json.loads(geometry)
                assert geometry['type'] == 'Polygon' and len(geometry['coordinates']) == 2
                assert abs(geometry['coordinates'][0][0][0] - 116.1) < 1e-6
                assert abs(geometry['coordinates'][0][0][1] - 39.6) < 1e-6
                item, data = await call('row_level_security', 'SELECT count(*) AS count FROM demo.scoped_regions')
                assert data[0]['count'] == 1
                item, data = await call('quoted_unicode_identifier', 'SELECT ST_SRID("边界 odd") AS srid FROM demo."区划 odd"" table" LIMIT 1')
                assert data[0]['srid'] == 4326
                item, data = await call('multiple_geometry_columns_nulls', 'SELECT count(*) AS count,count(geom) AS geometry_count,count(backup_geom) AS backup_count FROM demo.nullable_area')
                assert data[0] == {'count': 2, 'geometry_count': 1, 'backup_count': 1}
                item, data = await call('view_read', 'SELECT ST_SRID(geom) AS srid FROM demo.projected_view LIMIT 1')
                assert data[0]['srid'] == 4326
                item, data = await call('unknown_table_error', 'SELECT * FROM demo.table_does_not_exist LIMIT 1')
                assert not data and (item['isError'] or any('error' in text.lower() or 'does not exist' in text.lower() for text in item['text']))
                if name == 'pgedge':
                    result = await session.call_tool('get_schema_info', {'schema_name': 'demo', 'table_name': 'boundaries_3857'})
                    _, text = decode(result)
                    record['schemaInfo'] = {'isError': bool(result.isError), 'text': text}
                    assert not result.isError and any('boundaries_3857' in line and 'geom' in line for line in text), 'Native schema introspection missing expected table/field'
                record['passed'] = True

async def main(args):
    cache = Path(args.cache).resolve()
    credential = json.loads((ROOT / 'infra/postgis-test/.secrets/reader-connection.json').read_text(encoding='utf-8'))
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'scope': 'Standard stdio MCP protocol and real synthetic PostGIS data; not yet GeoD/LLM integration', 'candidates': []}
    pg_root = cache / 'pgEdge__pgedge-postgres-mcp'
    archive = pg_root / 'pgedge-postgres-mcp-server_1.1.0_windows_x86_64.zip'
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    expected = next(line.split()[0] for line in (pg_root / 'checksums.txt').read_text().splitlines() if line.endswith(archive.name))
    assert digest == expected
    env = {**os.environ, 'PGHOST': credential['host'], 'PGPORT': str(credential['port']), 'PGDATABASE': credential['database'], 'PGUSER': credential['user'], 'PGPASSWORD': credential['password'], 'PGSSLMODE': credential['sslMode'], 'PGEDGE_DB_ALLOW_WRITES': 'false'}
    uri = 'postgresql://' + quote(credential['user'], safe='') + ':' + quote(credential['password'], safe='') + '@' + credential['host'] + ':' + str(credential['port']) + '/' + quote(credential['database'], safe='') + '?sslmode=' + credential['sslMode']
    parameters = [
        ('pgedge', StdioServerParameters(command=str(pg_root / 'windows-1.1.0/pgedge-postgres-mcp.exe'), args=[], env=env, cwd=str(cache)), {'version': '1.1.0', 'sha256': digest}),
        ('crystaldba-restricted', StdioServerParameters(command=shutil.which('uvx'), args=['--python', '3.12', '--from', 'postgres-mcp==0.3.0', '--with', 'mcp==1.30.0', 'postgres-mcp', '--access-mode=restricted'], env={**os.environ, 'DATABASE_URI': uri, 'PYTHONUTF8': '1'}, cwd=str(cache)), {'version': '0.3.0', 'sdkPin': 'mcp==1.30.0', 'accessMode': 'restricted', 'unmodifiedInstall': 'Fails with current MCP 2.x; requires compatible SDK pin'}),
        ('crystaldba-unrestricted', StdioServerParameters(command=shutil.which('uvx'), args=['--python', '3.12', '--from', 'postgres-mcp==0.3.0', '--with', 'mcp==1.30.0', 'postgres-mcp', '--access-mode=unrestricted'], env={**os.environ, 'DATABASE_URI': uri, 'PYTHONUTF8': '1'}, cwd=str(cache)), {'version': '0.3.0', 'sdkPin': 'mcp==1.30.0', 'accessMode': 'unrestricted', 'databaseRole': 'Existing SELECT-only geod_reader; no data modification requested'}),
    ]
    if args.toolbox:
        toolbox_root = cache / 'googleapis__mcp-toolbox'
        metadata = json.loads((toolbox_root / 'metadata.json').read_text(encoding='utf-8'))
        executable = toolbox_root / 'toolbox-1.13.1.exe'
        assert hashlib.sha256(executable.read_bytes()).hexdigest() == metadata['binarySha256']
        toolbox_env = {**os.environ, 'POSTGRES_HOST': credential['host'], 'POSTGRES_PORT': str(credential['port']), 'POSTGRES_DATABASE': credential['database'], 'POSTGRES_USER': credential['user'], 'POSTGRES_PASSWORD': credential['password'], 'POSTGRES_QUERY_PARAMS': json.dumps({'sslmode': credential['sslMode']})}
        parameters.append(('toolbox', StdioServerParameters(command=str(executable), args=['--prebuilt=postgres/data', '--stdio', '--log-level=ERROR'], env=toolbox_env, cwd=str(cache)), {'version': '1.13.1', 'binaryBytes': metadata['binaryBytes'], 'sha256': metadata['binarySha256']}))
    for name, settings, metadata in parameters:
        record = {'candidate': name, **metadata, 'passed': False}
        report['candidates'].append(record)
        try:
            await asyncio.wait_for(probe(name, settings, record, cache / (name + '-stdio.stderr.log')), 180)
        except Exception as error:
            record['failureType'] = type(error).__name__
            record['failure'] = str(error).replace(credential['password'], '[REDACTED]').replace(uri, '[REDACTED_DSN]')
            def reasons(value):
                nested = getattr(value, 'exceptions', None)
                return [reason for inner in nested for reason in reasons(inner)] if nested else [str(value)]
            record['failureDetails'] = [message.replace(credential['password'], '[REDACTED]').replace(uri, '[REDACTED_DSN]') for message in reasons(error)]
        finally:
            stderr_path = cache / (name + '-stdio.stderr.log')
            if stderr_path.exists():
                redacted = stderr_path.read_text(encoding='utf-8', errors='replace').replace(credential['password'], '[REDACTED]').replace(uri, '[REDACTED_DSN]')
                stderr_path.write_text(redacted, encoding='utf-8')
        print(json.dumps({'candidate': name, 'passed': record['passed'], 'calls': len(record.get('calls', [])), 'failure': record.get('failure')}, ensure_ascii=False), flush=True)
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    assert credential['password'] not in payload and uri not in payload
    output.write_text(payload, encoding='utf-8')
    print(str(output))
    if not report['candidates'][0]['passed'] or (args.toolbox and not report['candidates'][-1]['passed']):
        raise SystemExit(1)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', required=True)
    parser.add_argument('--report', default=str(ROOT / 'docs/implementation/evidence/oss-postgis-mcp-2026-10-01.json'))
    parser.add_argument('--toolbox', action='store_true')
    asyncio.run(main(parser.parse_args()))
