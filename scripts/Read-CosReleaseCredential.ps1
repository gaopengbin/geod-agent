param([Parameter(Mandatory=$true)][string]$CredentialFile)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -le 5) {
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
}
# Called only as an internal child; stdout is captured in memory by Python.
$releaseCredential = Import-Clixml -LiteralPath $CredentialFile
$releaseNetworkCredential = $releaseCredential.GetNetworkCredential()
@{ SecretId = $releaseCredential.UserName; SecretKey = $releaseNetworkCredential.Password } | ConvertTo-Json -Compress
