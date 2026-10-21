[CmdletBinding()]
param([ValidateRange(1,2160)][int]$Hours=48,[string]$Until,[string]$OutputFile)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Join-Path $root 'services/geod-analytics/agent_activity_report.py'
$encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes($source))
$arguments="--hours $Hours"
if($Until){
    if($Until -notmatch '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$'){throw 'Until must include a timezone.'}
    $arguments+=" --until '$Until'"
}
$helper=Join-Path $env:USERPROFILE '.codex/skills/laogao-tencent-deploy/scripts/Invoke-LaogaoTencent.ps1'
$result=(& $helper -Command "printf %s $encoded | base64 -d | python3 - $arguments") -join "`n"
$parsed=$result|ConvertFrom-Json
if($parsed.product -ne 'geod-agent'){throw 'Unexpected product'}
if($OutputFile){[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputFile),$result,(New-Object Text.UTF8Encoding($false)))}
$result
