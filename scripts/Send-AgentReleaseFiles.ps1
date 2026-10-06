[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$RemoteDirectory
)
$ErrorActionPreference = 'Stop'
if ($RemoteDirectory -notmatch '^/srv/laogao/staging/geod-agent-[a-zA-Z0-9.-]+$') { throw 'Use a task-specific Agent staging directory.' }
$skillRoot = 'C:/Users/Administrator/.codex/skills/laogao-tencent-deploy'
$config = & ([scriptblock]::Create((Get-Content -LiteralPath "$skillRoot/references/server-config.psd1" -Raw)))
$knownHosts = Join-Path $skillRoot $config.Local.KnownHosts
$workspace = (Resolve-Path -LiteralPath "$PSScriptRoot/..").Path
$resolvedFiles = foreach ($file in $Files) {
    $path = (Resolve-Path -LiteralPath $file).Path
    if (!$path.StartsWith("$workspace\artifacts\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Upload only reviewed local artifacts.' }
    $path
}
$destination = '{0}@{1}:{2}/' -f $config.Server.User, $config.Server.PublicIp, $RemoteDirectory
$arguments = @('-i', $config.Local.SshPrivateKey, '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$knownHosts", '-o', 'ConnectTimeout=15') + @($resolvedFiles) + @($destination)
& scp.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "Artifact upload failed with exit code $LASTEXITCODE." }

