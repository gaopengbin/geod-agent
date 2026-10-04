[CmdletBinding()]
param(
    [ValidateRange(1,90)][int]$Days = 7,
    [string]$Until,
    [string]$OutputDirectory,
    [string]$SshHelper = "$env:USERPROFILE\.codex\skills\laogao-tencent-deploy\scripts\Invoke-LaogaoTencent.ps1"
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$reportScript = Join-Path $repositoryRoot 'services\geod-analytics\report.py'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repositoryRoot ('artifacts\analytics\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if (-not (Test-Path -LiteralPath $SshHelper)) { throw 'Pinned-key Tencent SSH helper was not found.' }
$pythonCommand = (Get-Command python -ErrorAction Stop).Source
$source = [IO.File]::ReadAllText($reportScript, [Text.Encoding]::UTF8)
$sourceBytes = [Text.Encoding]::UTF8.GetBytes($source)
$buffer = New-Object IO.MemoryStream
$compressed = New-Object IO.Compression.GZipStream($buffer, [IO.Compression.CompressionMode]::Compress, $true)
$compressed.Write($sourceBytes, 0, $sourceBytes.Length)
$compressed.Dispose()
$encodedSource = [Convert]::ToBase64String($buffer.ToArray())
$buffer.Dispose()
$remoteArguments = "collect --days $Days"
if ($Until) {
    if ($Until -notmatch '(Z|[+-]\d{2}:\d{2})$') { throw 'Until must include a timezone, for example 2026-10-02T10:00:00+08:00.' }
    $cutoff = [DateTimeOffset]::Parse($Until).ToString('o')
    $remoteArguments += " --until '$cutoff'"
}
# Code executes from stdin; no upload, installation, service restart or DB write.
$remoteCommand = 'printf %s ' + $encodedSource + ' | base64 -d | gzip -d | python3 - ' + $remoteArguments
$response = (& $SshHelper -Command $remoteCommand) -join "`n"
$parsed = $response | ConvertFrom-Json
if ($parsed.product -ne 'geod' -or $parsed.schema_version -ne 1) { throw 'Unexpected analytics response.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$snapshot = Join-Path $OutputDirectory 'snapshot.json'
[IO.File]::WriteAllText($snapshot, $response, (New-Object Text.UTF8Encoding($false)))
& $pythonCommand -X utf8 $reportScript render $snapshot $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'GeoD report rendering failed.' }
$unavailable = @($parsed.sources.PSObject.Properties | Where-Object { $_.Value.status -ne 'ok' } | ForEach-Object { $_.Name })
if ($unavailable.Count) { Write-Warning ('Sources unavailable: ' + ($unavailable -join ', ')) }
