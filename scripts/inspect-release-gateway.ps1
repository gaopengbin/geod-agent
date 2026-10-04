$ErrorActionPreference = 'Stop'
$releaseAudit = @'
python3 - <<'PY'
import hashlib, json, pathlib, re, subprocess
rows=json.loads(subprocess.check_output(['pm2','jlist']))
result=[]
for item in rows:
    if 'geod-agent' not in item.get('name',''):
        continue
    env=item.get('pm2_env',{})
    script=pathlib.Path(env.get('pm_exec_path',''))
    server=script.parent/'server.mjs'
    source=server.read_text() if server.is_file() else ''
    wrapper=script.read_text() if script.is_file() else ''
    envfiles=[p for p in re.findall(r"['\"](/srv/[^'\"\n]+)['\"]",wrapper) if p.endswith('.env')]
    settings={}
    allowed={'GEOD_AGENT_DB_PATH','GEOD_AGENT_QUOTA_MODE','GEOD_AGENT_TOKEN_LIMIT','GEOD_AGENT_LISTEN_PORT','DEEPSEEK_MODEL'}
    for filename in envfiles:
        p=pathlib.Path(filename)
        if p.is_file():
            for line in p.read_text().splitlines():
                name,sep,value=line.partition('=')
                if sep and name in allowed: settings[name]=value.strip().strip('\"').strip("'")
    processenv={}
    if item.get('pid') and env.get('status')=='online':
        processenv=dict(entry.split('=',1) for entry in pathlib.Path('/proc/'+str(item['pid'])+'/environ').read_text().split(chr(0)) if '=' in entry)
    for values in [env.get('env',{}),env,processenv]:
        for name in allowed:
            if name in values: settings[name]=values[name]
    package=script.parent/'package.json'
    result.append({'name':item['name'],'status':env.get('status'),'script':str(script.resolve()),
        'nodeVersion':env.get('node_version'),'sourceFile':str(server),'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),
        'codexStreamImplemented':'/api/agent/codex/generations/stream' in source,
        'paymentHostImplemented':'createPaymentHost' in source,
        'sponsorsImplemented':'/api/agent/sponsors' in source,
        'envFiles':envfiles,'nonSecretSettings':settings,'pid':item.get('pid') if env.get('status')=='online' else None,
        'paymentConfigured':'GEOD_AGENT_PAYMENT_CONFIG' in processenv,
        'dependencies':json.loads(package.read_text()).get('dependencies',{}) if package.is_file() else None})
print(json.dumps({'readOnly':True,'libc':subprocess.check_output(['getconf','GNU_LIBC_VERSION'],text=True).strip(),'services':result},ensure_ascii=False))
PY
'@
$releaseAudit = $releaseAudit.Replace("`r`n", "`n")
$releasePython = ($releaseAudit -split "`n", 2)[1]
$releasePython = $releasePython.Substring(0, $releasePython.LastIndexOf("`nPY"))
$releasePayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($releasePython))
$releaseCommand = "python3 - <<'PY'`nimport base64`nexec(base64.b64decode('$releasePayload'))`nPY"
& 'C:/Users/Administrator/.codex/skills/laogao-tencent-deploy/scripts/Invoke-LaogaoTencent.ps1' -Command $releaseCommand
