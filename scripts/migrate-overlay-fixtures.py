from pathlib import Path
for base in ['crates/geod-core', 'crates/geod-task-engine']:
    for folder in ['tests', 'examples']:
        for p in (Path(base)/folder).glob('*.rs'):
            s=p.read_text(encoding='utf-8')
            if 'ImageryRequest {' in s:
                s=s.replace('export_options: geod_core::imagery::ExportOptions::default(),', 'export_options: geod_core::imagery::ExportOptions::default(), overlays: Vec::new(),')
                s=s.replace('export_options:ExportOptions { compression:TiffCompression::Deflate,build_pyramid:true,generate_sidecars:true,jpeg_quality:90 },', 'export_options:ExportOptions { compression:TiffCompression::Deflate,build_pyramid:true,generate_sidecars:true,jpeg_quality:90, ..Default::default() }, overlays: Vec::new(),')
            p.write_text(s,encoding='utf-8',newline='\n')
