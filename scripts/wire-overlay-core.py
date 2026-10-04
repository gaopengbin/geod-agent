from pathlib import Path
p=Path('crates/geod-core/src/imagery.rs');s=p.read_text(encoding='utf-8')
# Preserve legacy caches for ordinary imagery; composition is a separate cache binding.
s=s.replace('let binding = format!("{}:{}", config.plan_hash, source.configuration_revision());', 'let binding = format!("{}:{}", config.plan_hash, source.configuration_revision());')
start=s.index('async fn fetch_bundle_internal') if 'async fn fetch_bundle_internal' in s else s.index('    let mut completed_tiles = 0u64;')
a=s[:start]; b=s[start:]
b=b.replace('get_tile_with_retry(\n                            client_ref,\n                            url,\n                            source,', 'get_composite_tile(\n                            client_ref,\n                            url,\n                            source, &request.overlays, grid, x, y,')
s=a+b
s=s.replace('_ => raster_export::write_streaming_tiff(&path, &spool, grid, &crop,', '_ if request.export_options.elevation_encoding.is_some() => raster_export::write_dem(&path, &spool, grid, &crop, source.tile_size, request.boundary.as_ref(), request.export_options.compression, request.export_options.build_pyramid, check)?,\n                _ => raster_export::write_streaming_tiff(&path, &spool, grid, &crop,')
p.write_text(s,encoding='utf-8',newline='\n')
