[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$skillRoot = 'C:\Users\Administrator\.codex\skills\laogao-tencent-deploy'
$config = & ([scriptblock]::Create((Get-Content -LiteralPath (Join-Path $skillRoot 'references\server-config.psd1') -Raw)))
$knownHosts = Join-Path $skillRoot $config.Local.KnownHosts
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$remoteScript = '/srv/laogao/staging/geod-agent-20260928-65b5e65d-69a6c52d/configure-server-secrets.py'

$secure = Read-Host 'DeepSeek API key' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if (-not $key) { throw 'No API key entered.' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $ssh
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Arguments = (@(
        '-T',
        '-i', $config.Local.SshPrivateKey,
        '-o', 'BatchMode=yes',
        '-o', 'PasswordAuthentication=no',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$knownHosts",
        '-o', 'ConnectTimeout=15',
        ('{0}@{1}' -f $config.Server.User, $config.Server.PublicIp),
        'python3', $remoteScript,
        '--studio-env', '/srv/laogao/secrets/geod-studio.env',
        '--agent-env', '/srv/laogao/secrets/geod-agent.env'
    ) -join ' ')
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.WriteLine($key)
        $process.StandardInput.Close()
        $key = $null
        $output = $process.StandardOutput.ReadToEnd()
        $diagnostics = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "Pinned SSH secret installation failed: $diagnostics"
        }
        Write-Output $output.Trim()
    } finally {
        $process.Dispose()
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
}
