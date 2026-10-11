$ErrorActionPreference='Stop'
$repoRoot='G:\code\geod-agent'
$output=Join-Path $repoRoot 'artifacts\monthly-plans-20261011'
try {
  $existing=Invoke-RestMethod -Uri 'http://127.0.0.1:1437/api/health' -TimeoutSec 2
  if ($existing.product -eq 'geod-agent-monthly-preview' -and $existing.fixture -eq $true -and $existing.realPayments -eq $false) {
    Write-Output 'The isolated monthly-plan preview is already running'
    exit 0
  }
} catch { }
if (Get-NetTCPConnection -State Listen -LocalPort 1436,1437 -ErrorAction SilentlyContinue) { throw 'Preview ports are already in use; inspect existing processes before starting another preview' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$env:GEOD_MONTHLY_PLAN_PREVIEW='1'
$gateway=Start-Process -FilePath (Get-Command node).Source -ArgumentList 'services/geod-agent-model-gateway/dev/monthly-plan-preview.mjs' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'preview-server.log') -RedirectStandardError (Join-Path $output 'preview-server-error.log')
$vite=Start-Process -FilePath (Get-Command node).Source -ArgumentList 'node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1436 --strictPort' -WorkingDirectory (Join-Path $repoRoot 'apps\geod-agent-desktop') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $output 'vite.log') -RedirectStandardError (Join-Path $output 'vite-error.log')
Remove-Item Env:\GEOD_MONTHLY_PLAN_PREVIEW
@{gatewayPid=$gateway.Id;vitePid=$vite.Id;url='http://127.0.0.1:1436/test/monthly-plans-harness.html';previewOnlyUrl='http://127.0.0.1:1436/test/monthly-plans-harness.html?preview=1';realPayments=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'preview-runtime.json') -Encoding UTF8
Write-Output 'Local monthly-plan preview started on ports 1436 and 1437'
