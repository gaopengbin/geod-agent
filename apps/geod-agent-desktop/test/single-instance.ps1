[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Executable).Path
$processName = [System.IO.Path]::GetFileName($resolved)

function Get-AgentProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name = '$processName'")
}

if ((Get-AgentProcesses).Count -ne 0) {
    throw 'Close any existing GeoD Agent window before this single-instance check.'
}

$first = Start-Process -FilePath $resolved -PassThru -WindowStyle Hidden
$second = $null
try {
    Start-Sleep -Seconds 3
    if ($first.HasExited) {
        throw "The first GeoD Agent process exited with code $($first.ExitCode)."
    }

    $second = Start-Process -FilePath $resolved -PassThru -WindowStyle Hidden
    if (-not $second.WaitForExit(10000)) {
        throw 'The second GeoD Agent process did not exit within 10 seconds.'
    }

    $instances = @(Get-AgentProcesses)
    if ($instances.Count -ne 1 -or $instances[0].ProcessId -ne $first.Id) {
        throw "Expected only the original GeoD Agent process; found $($instances.Count)."
    }

    [pscustomobject]@{
        originalProcessId = $first.Id
        secondExitCode = $second.ExitCode
        runningInstances = $instances.Count
    } | ConvertTo-Json -Compress
}
finally {
    $owned = @(Get-AgentProcesses | Where-Object { $_.ExecutablePath -eq $resolved })
    foreach ($instance in $owned) {
        if ($instance.ProcessId -eq $first.Id -or ($second -and $instance.ProcessId -eq $second.Id)) {
            Stop-Process -Id $instance.ProcessId -ErrorAction Stop
        }
    }
}
