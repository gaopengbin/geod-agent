from pathlib import Path
import re
for base in ['crates/geod-core','crates/geod-task-engine','apps/geod-agent-desktop/src-tauri']:
    for folder in ['src','tests','examples']:
        for p in (Path(base)/folder).rglob('*.rs'):
            s=p.read_text(encoding='utf-8')
            s=re.sub(r'HttpSource\s*\{\s*(?=id:)', 'HttpSource { elevation_encoding: None, ', s)
            s=re.sub(r'SourceDescriptor\s*\{\s*(?=schema_version:)', 'SourceDescriptor { elevation_encoding: None, ', s)
            # Production save_source supplies the real source encoding below.
            s=s.replace('SourceDescriptor { elevation_encoding: None, schema_version: crate::SchemaVersion::V0_1,', 'SourceDescriptor { schema_version: crate::SchemaVersion::V0_1,')
            p.write_text(s,encoding='utf-8',newline='\n')
