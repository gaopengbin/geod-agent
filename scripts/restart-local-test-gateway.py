"""Back up the current development ledger, verify its PID, then restart locally."""
from pathlib import Path
import json, os, sqlite3, subprocess, sys, tempfile, datetime
root=Path(__file__).resolve().parents[1]
logs=Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/dev-logs'
pid=int((logs/'local-gateway.pid').read_text())
probe=subprocess.run(['powershell','-NoProfile','-Command',f'Get-CimInstance Win32_Process -Filter "ProcessId={pid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],capture_output=True,text=True,check=True)
process=json.loads(probe.stdout)
if process['ProcessId']!=pid or 'local-desktop-gateway.mjs' not in process['CommandLine']:
    raise SystemExit('Recorded PID is not the GeoD local test gateway')
target=logs/'local-gateway.sqlite'
sources=sorted(Path(tempfile.gettempdir()).glob('geod-desktop-gateway-*/gateway.sqlite'),key=lambda p:p.stat().st_mtime,reverse=True)
if not target.exists() and sources:
    with sqlite3.connect(sources[0].as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(target) as destination:
        source.backup(destination)
    print('Current local test ledger retained using SQLite backup')
if target.exists():
    backup=logs/('local-gateway-backup-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite')
    with sqlite3.connect(target.as_uri()+'?mode=ro',uri=True) as source:
        if source.execute("SELECT COUNT(*) FROM model_generations WHERE state IN ('reserved','streaming')").fetchone()[0]:
            raise SystemExit('A model request is still active; finish it before restarting')
        with sqlite3.connect(backup) as destination: source.backup(destination)
    print('Existing local test ledger backed up before restart')
subprocess.run(['taskkill','/PID',str(pid),'/F'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
subprocess.run([sys.executable,'-X','utf8',str(root/'services/geod-agent-model-gateway/dev/start-local-gateway.py'),'--existing-config'],check=True)
