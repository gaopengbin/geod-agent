"""Build and start the existing development profile, never the installed app."""
import os,sys,json,subprocess,socket
from pathlib import Path
from windows_detached_process import independent_entrypoint,spawn_hidden_detached
if independent_entrypoint(__file__,sys.argv[1:],label='development-desktop'):raise SystemExit(0)
repo=Path(__file__).resolve().parents[1];desktop=repo/'apps/geod-agent-desktop';out=repo/'artifacts/boundary-export-20261021';out.mkdir(exist_ok=True)
env=dict(os.environ);env['TAURI_CONFIG']=json.dumps({'identifier':'dev.geod-agent.desktop-preview','build':{'devUrl':'http://127.0.0.1:1426'},'app':{'windows':[{'label':'main','title':'GeoD Agent 开发版','decorations':False,'width':1440,'height':900,'minWidth':960,'minHeight':660}]}})
if '--skip-build' not in sys.argv:
 with (out/'build.log').open('w',encoding='utf8') as log:subprocess.run(['cargo','build','--locked','--offline','--jobs','2','--bin','geod-agent-desktop'],cwd=desktop/'src-tauri',env=env,check=True,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
env.pop('TAURI_CONFIG',None);env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']='--remote-debugging-port=9233';env['GEOD_CODEX_NODE']=str(desktop/'src-tauri/resources/codex/node.exe');env['GEOD_CODEX_EXE']=str(desktop/'src-tauri/resources/codex/codex.exe')
def launch(command,log):
 return subprocess.Popen(command,cwd=desktop,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
vite=None
with socket.socket() as probe:ready=probe.connect_ex(('127.0.0.1',1426))==0
if not ready:
 with (out/'vite.log').open('ab') as log:vite=launch(['node',str(desktop/'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1426','--strictPort'],log)
with (out/'desktop.log').open('ab') as log:app=launch([str(desktop/'src-tauri/target/debug/geod-agent-desktop.exe')],log)
(out/'started.json').write_text(json.dumps({'appPid':app.pid,'vitePid':vite.pid if vite else None,'reusedFrontend':ready,'port':1426}),encoding='utf8')
