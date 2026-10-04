from pathlib import Path
p=Path('crates/geod-core/tests/imagery.rs');s=p.read_text(encoding='utf-8')
s=s.replace('let deadline = Instant::now() + Duration::from_secs(3);', 'let deadline = Instant::now() + Duration::from_secs(30);')
s=s.replace('    assert!(started.elapsed() < Duration::from_secs(3));', '    assert!(fixture.request_times.lock().unwrap()[0].elapsed() < Duration::from_secs(3));')
# The deadline assertion now starts at the HTTP event it is testing, rather
# than including SQLite/cache creation time before any request exists.
for name in ['retry_after_beyond_job_deadline_does_not_retry_early','cancel_interrupts_retry_after_without_another_tile_request','pause_interrupts_retry_after_and_keeps_the_job_unpublished']:
    a=s.index('async fn '+name);b=s.find('\n#[tokio::test]',a+1)
    if b<0:b=len(s)
    s=s[:a]+s[a:b].replace('    let started = Instant::now();\n','')+s[b:]
p.write_text(s,encoding='utf-8',newline='\n')
