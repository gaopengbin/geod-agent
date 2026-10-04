"""Remove only owned QA passwords and check saved files and live child processes."""
from pathlib import Path
import json, os, psutil, shutil, subprocess

repo=Path(__file__).resolve().parents[1]
root=(repo/'artifacts/product-gaps-20261004/encrypted-documents').resolve()
state=json.loads((root/'qa-state.json').read_text(encoding='utf-8'))
assert state['cleaned'], 'Complete the actual recovery and cleanup checks first'
private=(root/'private-passwords.json').resolve(strict=True)
assert private.parent==root and not private.is_symlink()
passwords=set(json.loads(private.read_text(encoding='utf-8')).values())-{''}
assert passwords
patterns=set()
for password in passwords:
    patterns.add(password.encode('utf-8'))
    patterns.add(password.encode('utf-16-le'))
    patterns.add(json.dumps(password,ensure_ascii=True)[1:-1].encode('ascii'))

# Inspect live argv/environment first, then release WebView locks through normal exit.
expected=(repo/'apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe').resolve()
instances=[p for p in psutil.process_iter(['name']) if p.info['name']=='geod-agent-desktop.exe' and Path(p.exe()).resolve()==expected]
assert len(instances)==2
processes={p.pid:p for parent in instances for p in [parent,*parent.children(recursive=True)]}
process_leaks=[]
for pid,process in processes.items():
    try:
        values=process.cmdline()+list(process.environ().values())
        if any(password in value for password in passwords for value in values):process_leaks.append(pid)
    except psutil.NoSuchProcess:pass
stop=subprocess.run([shutil.which('node'),'scripts/stop-encrypted-desktop.mjs'],cwd=repo,capture_output=True,
    creationflags=subprocess.CREATE_NO_WINDOW)
assert stop.returncode==0,'Normal desktop/companion stop failed; private QA material retained'
for process in processes.values():
    try:process.wait(timeout=30)
    except psutil.NoSuchProcess:pass
private.unlink()

app=Path(os.environ['APPDATA'])/'dev.geod-agent.desktop'
backup=Path(state['backup']['path']).resolve(strict=True)
assert (backup/'manifest.json').is_file()
roots=[root,app,backup,Path(os.environ['LOCALAPPDATA'])/'GeoD Agent/dev-logs']
excluded={'node_modules','models','tmp-models','.git'}
checked=0;unreadable=[];violations=[];seen=set();overlap=max(map(len,patterns))
for start in roots:
    for directory,folders,files in os.walk(start,followlinks=False):
        folders[:]=[name for name in folders if name not in excluded and not (Path(directory)/name).is_symlink()]
        for name in files:
            file=Path(directory)/name
            if file.is_symlink() or file.resolve() in seen:continue
            seen.add(file.resolve())
            try:
                with file.open('rb') as stream:
                    tail=b''
                    while part:=stream.read(1024*1024):
                        data=tail+part
                        if any(pattern in data for pattern in patterns):
                            violations.append(str(file));break
                        tail=data[-overlap:]
                checked+=1
            except OSError:unreadable.append(str(file))

result=dict(passed=not violations and not process_leaks and not unreadable,passwordsRemoved=True,
    testedNonemptyPasswords=len(passwords),filesChecked=checked,processesChecked=len(processes),
    scope=['current QA files','mutable native and WebView records','exact complete backup','development logs','live desktop and child argv/environment'],
    excludedDirectories=sorted(excluded),unreadableFiles=unreadable,
    plaintextPasswordFiles=violations,processPasswordLeaks=process_leaks,normalDesktopAndCompanionExit=True)
(root/'password-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({key:value for key,value in result.items() if key not in ['unreadableFiles','scope','excludedDirectories']},ensure_ascii=False))
assert result['passed'], 'Local document password persistence audit failed; see file/PID evidence'
