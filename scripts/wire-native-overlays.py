from pathlib import Path
p=Path('apps/geod-agent-desktop/src-tauri/src/lib.rs');s=p.read_text(encoding='utf-8')
s=s.replace('source_auth::resolve(state, &mut source.endpoint)?;\n    let proxy', 'source_auth::resolve(state, &mut source.endpoint)?;\n    let mut overlays = store.plan_overlays(&stored.plan.spec, &source.descriptor)?;\n    for overlay in &mut overlays { source_auth::resolve(state, overlay)?; }\n    let proxy')
s=s.replace('source_auth::resolve(&state, &mut source.endpoint)?;\n    let fingerprint', 'source_auth::resolve(&state, &mut source.endpoint)?;\n    let mut overlays = store.plan_overlays(&plan.plan.spec, &source.descriptor)?;\n    for overlay in &mut overlays { source_auth::resolve(&state, overlay)?; }\n    let fingerprint')
s=s.replace('.run_job_with_control_proxy(', '.run_job_with_control_proxy_and_overlays(')
s=s.replace('&source.endpoint,\n                        Utc::now()', '&source.endpoint,\n                        &overlays,\n                        Utc::now()')
s=s.replace('&source.endpoint,\n                    Utc::now()', '&source.endpoint,\n                    &overlays,\n                    Utc::now()')
p.write_text(s,encoding='utf-8',newline='\n')
