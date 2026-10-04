"""Verify and restore a native backup only into a fresh isolated directory."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('backup', type=Path)
parser.add_argument('--marker-key', required=True)
parser.add_argument('--marker-value', required=True)
parser.add_argument('--command-id', required=True)
args = parser.parse_args()
backup = args.backup.resolve(strict=True)
manifest = json.loads((backup / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['schemaVersion'] == 1
assert manifest['workspaceFilesIncluded'] is False
clone = Path(tempfile.mkdtemp(prefix='geod-record-restore-')).resolve()
sqlite_count = history_count = 0
try:
    for record in manifest['records']:
        source = (backup / record['file']).resolve(strict=True)
        assert source.is_relative_to(backup)
        assert hashlib.sha256(source.read_bytes()).hexdigest() == record['sha256']
        assert source.stat().st_size == record['bytes']
        restored = (clone / record['path']).resolve()
        assert restored.is_relative_to(clone)
        restored.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, restored)
        if record['kind'] == 'sqlite':
            with closing(sqlite3.connect(restored.as_uri() + '?mode=ro', uri=True)) as db:
                assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
            sqlite_count += 1
        if restored.suffix == '.jsonl':
            history_count += 1
    ui = manifest['uiState']
    ui_file = backup / ui['file']
    assert hashlib.sha256(ui_file.read_bytes()).hexdigest() == ui['sha256']
    entries = dict(json.loads(ui_file.read_text(encoding='utf-8'))['entries'])
    assert entries[args.marker_key] == args.marker_value
    conversations = []
    for key, value in entries.items():
        if key.startswith('geod-agent-conversations-0.1'):
            conversations.extend(json.loads(value))
    assert len(conversations) >= 30, 'Existing chat records missing'
    command_found = False
    for record in manifest['records']:
        if record['kind'] != 'sqlite':
            continue
        restored = clone / record['path']
        with closing(sqlite3.connect(restored.as_uri() + '?mode=ro', uri=True)) as db:
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for table in tables:
                if 'command' not in table:
                    continue
                quoted = '"' + table.replace('"', '""') + '"'
                for row in db.execute('SELECT * FROM ' + quoted):
                    if args.command_id in row:
                        command_found = True
    assert command_found, 'Actual command ledger record missing'
    assert sqlite_count > 0 and history_count > 0
    shutil.copyfile(ui_file, clone / 'ui-state.json')
    print(json.dumps({'passed': True, 'isolatedRestore': True, 'nativeRecords': len(manifest['records']),
        'sqliteIntegrityChecks': sqlite_count, 'engineHistoryFiles': history_count,
        'uiEntries': len(entries), 'retainedConversations': len(conversations),
        'actualCommandRetained': command_found, 'workspaceFilesCopied': False,
        'liveDataOverwritten': False}, ensure_ascii=False))
finally:
    assert clone.resolve().parent == Path(tempfile.gettempdir()).resolve()
    shutil.rmtree(clone)
