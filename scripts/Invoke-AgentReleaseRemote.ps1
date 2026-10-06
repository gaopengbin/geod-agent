[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ScriptFile)
$ErrorActionPreference = 'Stop'
$releaseScript = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ScriptFile).Path)
$releasePayload = [Convert]::ToBase64String($releaseScript)
$releaseCommand = "python3 - <<'PY'`nimport base64`nexec(compile(base64.b64decode('$releasePayload'), '<agent-release>', 'exec'))`nPY"
& 'C:/Users/Administrator/.codex/skills/laogao-tencent-deploy/scripts/Invoke-LaogaoTencent.ps1' -Command $releaseCommand

