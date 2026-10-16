param([string]$CredentialFile = "$env:USERPROFILE\.codex\secrets\geod-cos-publisher.xml")
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -le 5) {
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
}
if (Test-Path -LiteralPath $CredentialFile) {
    throw 'Credential file already exists; review it before replacing.'
}
$releaseSecretId = Read-Host 'COS publisher SecretId'
$releaseSecretKey = Read-Host 'COS publisher SecretKey' -AsSecureString
if (-not $releaseSecretId -or $releaseSecretKey.Length -eq 0) { throw 'Empty release credential' }
$releaseCredential = [System.Management.Automation.PSCredential]::new($releaseSecretId, $releaseSecretKey)
$releaseFolder = Split-Path -Parent $CredentialFile
New-Item -ItemType Directory -Force -Path $releaseFolder | Out-Null
$releaseCredential | Export-Clixml -LiteralPath $CredentialFile
Write-Output 'Publisher credential saved with Windows DPAPI encryption for this user and machine.'
