$active = Invoke-RestMethod -Uri 'http://127.0.0.1:1421/rpc' -Method Post -ContentType 'application/json' -Body '{"command":"jobs_active","args":{}}'
if ($active.error -or $active.value.Count -gt 0) { throw 'Development desktop has active work; rebuild deferred.' }
$expected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe'))
foreach ($appProcess in @(Get-Process -Name geod-agent-desktop -ErrorAction SilentlyContinue)) {
    if ($appProcess.Path -eq $expected) {
        if (-not $appProcess.CloseMainWindow()) { throw 'Development window did not accept a normal close.' }
        if (-not $appProcess.WaitForExit(10000)) { throw 'Development desktop is still shutting down.' }
        Write-Output "Development desktop closed cleanly: $($appProcess.Id)"
    }
}
