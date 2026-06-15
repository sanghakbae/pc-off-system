# PC monitoring Windows agent (PowerShell, no install required)
#
# Reports power_on / lock / unlock / heartbeat / shutdown to the server.
# Same payload format as the macOS agent (POST /api/report).
# Robust: reports power_on first, logs to a file, and keeps running even if
# lock/unlock detection cannot be set up on this machine.
#
# Env / params: PMON_SERVER, PMON_TOKEN, PMON_INTERVAL (heartbeat seconds)

param(
  [string]$Server   = $(if ($env:PMON_SERVER)   { $env:PMON_SERVER }   else { 'http://127.0.0.1:4501' }),
  [string]$Token    = $(if ($env:PMON_TOKEN)    { $env:PMON_TOKEN }    else { 'change-me-pmon-token' }),
  [int]   $Interval = $(if ($env:PMON_INTERVAL) { [int]$env:PMON_INTERVAL } else { 30 })
)

$ErrorActionPreference = 'Continue'
$AgentVersion = 2026061003
$AutoUpdate = if ($env:PMON_AUTO_UPDATE) { $env:PMON_AUTO_UPDATE -ne '0' } else { $true }
$UpdateInterval = if ($env:PMON_UPDATE_INTERVAL) { [int]$env:PMON_UPDATE_INTERVAL } else { 3600 }
$LastUpdateCheck = [DateTime]::MinValue

$LogDir  = Join-Path $env:LOCALAPPDATA 'pmon-agent'
$LogFile = Join-Path $LogDir 'agent.log'
try { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null } catch {}
function Log($m) {
  $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line } catch {}
}

function Invoke-SelfUpdate {
  if (-not $AutoUpdate) { return }
  if (-not $PSCommandPath) { return }
  if ((([DateTime]::UtcNow - $script:LastUpdateCheck).TotalSeconds) -lt $UpdateInterval) { return }
  $script:LastUpdateCheck = [DateTime]::UtcNow
  $tmp = Join-Path $env:TEMP ("pmon-agent-update-{0}.ps1" -f $PID)
  try {
    Invoke-WebRequest -Uri "$Server/download/windows/pmon-agent.ps1" -OutFile $tmp -UseBasicParsing -TimeoutSec 15
    $firstLines = Get-Content -Path $tmp -TotalCount 40 -ErrorAction Stop
    $remoteLine = $firstLines | Where-Object { $_ -match '^\$AgentVersion\s*=' } | Select-Object -First 1
    if (-not $remoteLine) { return }
    $remoteVersion = [int64]([regex]::Match($remoteLine, '\d+').Value)
    if ($remoteVersion -le $AgentVersion) { return }
    Copy-Item -Path $tmp -Destination $PSCommandPath -Force
    Log "agent self-update applied"
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
      '-Server', "`"$Server`"", '-Token', "`"$Token`"", '-Interval', "$Interval"
    ) -WindowStyle Hidden
    exit 0
  } catch {
    Log "self-update skipped: $($_.Exception.Message)"
  } finally {
    try { Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue } catch {}
  }
}

$Hostname = $env:COMPUTERNAME
$Username = $env:USERNAME
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $OS = "$($os.Caption) $($os.Version)"
  $BootMs = [int64]([DateTimeOffset]$os.LastBootUpTime).ToUnixTimeMilliseconds()
} catch { $OS = 'Windows'; $BootMs = 0 }

$Mac = ''; $LanIp = ''
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
  $Mac = (Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop).MacAddress
  if ($Mac) { $Mac = $Mac.Replace('-', ':').ToLower() }
  $LanIp = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
} catch { Log "net info unavailable: $($_.Exception.Message)" }
function Get-VpnIp {
  try {
    return (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -match '^192\.168\.52\.([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$' } |
            Select-Object -First 1).IPAddress
  } catch {
    return ''
  }
}

function Test-AnyPath {
  param([string[]]$Paths)
  foreach ($Path in $Paths) {
    if ($Path -and (Test-Path $Path)) { return $true }
  }
  return $false
}

function Test-AnyProcess {
  param([string[]]$Patterns)
  try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop
    foreach ($Process in $processes) {
      $name = [string]$Process.Name
      $commandLine = [string]$Process.CommandLine
      foreach ($Pattern in $Patterns) {
        if ($name -match $Pattern -or $commandLine -match $Pattern) { return $true }
      }
    }
  } catch {
    foreach ($Pattern in $Patterns) {
      if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $Pattern } | Select-Object -First 1) {
        return $true
      }
    }
  }
  return $false
}

function Test-AnyService {
  param([string[]]$Patterns)
  try {
    $services = Get-CimInstance Win32_Service -ErrorAction Stop
    foreach ($Service in $services) {
      foreach ($Pattern in $Patterns) {
        if ($Service.Name -match $Pattern -or $Service.DisplayName -match $Pattern) { return $true }
      }
    }
  } catch {}
  return $false
}

function Get-SecurityTools {
  $v3Paths = @(
    "$env:ProgramFiles\AhnLab",
    "${env:ProgramFiles(x86)}\AhnLab",
    "$env:ProgramData\AhnLab"
  )
  $v3Patterns = @('AhnLab', 'V3', 'ASDSvc', 'V3Svc', 'V3Lite', 'V3UI', 'V3LSvc')
  $okPaths = @(
    "$env:ProgramFiles\OfficeKeeper",
    "${env:ProgramFiles(x86)}\OfficeKeeper",
    "$env:ProgramFiles\Jiran",
    "${env:ProgramFiles(x86)}\Jiran",
    "$env:ProgramData\Jiran"
  )
  $okPatterns = @('OfficeKeeper', 'Jiran', 'jkok', 'OKAgent', 'OKService')

  $v3Running = (Test-AnyProcess $v3Patterns) -or (Test-AnyService $v3Patterns)
  $okRunning = (Test-AnyProcess $okPatterns) -or (Test-AnyService $okPatterns)
  return @{
    v3 = @{
      installed = (Test-AnyPath $v3Paths) -or (Test-AnyService $v3Patterns) -or $v3Running
      running = $v3Running
    }
    officekeeper = @{
      installed = (Test-AnyPath $okPaths) -or (Test-AnyService $okPatterns) -or $okRunning
      running = $okRunning
    }
  }
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Send-Event {
  param([string]$Type, [int64]$Ts = (Now-Ms))
  $VpnIp = Get-VpnIp
  $body = @{
    hostname = $Hostname; username = $Username; os = $OS; mac = $Mac; local_ip = $LanIp
    vpn_connected = [bool]$VpnIp; vpn_ip = $VpnIp
    boot_time = $BootMs; security_tools = (Get-SecurityTools); type = $Type; ts = $Ts; token = $Token
  } | ConvertTo-Json -Compress
  try {
    $response = Invoke-RestMethod -Uri "$Server/api/report" -Method Post -ContentType 'application/json' `
      -Headers @{ 'X-Agent-Token' = $Token } -Body $body -TimeoutSec 10
    if ($response.disabled -eq $true) {
      Log "report disabled: stop collection"
      exit 0
    }
    Log "report ok: $Type"
  } catch {
    Log "report FAIL: $Type - $($_.Exception.Message)"
  }
}

function Test-WorkstationLocked {
  try {
    return [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

Log "pmon-agent start host=$Hostname user=$Username server=$Server mac=$Mac ip=$LanIp"
Invoke-SelfUpdate
# Report first so the machine shows up even if lock-detection setup fails below.
Send-Event 'power_on'
if (Test-WorkstationLocked) { Send-Event 'lock' }

# Lock/unlock detection is optional: degrade gracefully if it cannot be set up.
$haveForms = $false
try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop; $haveForms = $true }
catch { Log "System.Windows.Forms load failed: $($_.Exception.Message)" }

$subscribed = $false
$onSwitch = $null; $onEnding = $null
try {
  $onSwitch = {
    param($s, $e)
    if ($e.Reason -eq [Microsoft.Win32.SessionSwitchReason]::SessionLock)        { Send-Event 'lock' }
    elseif ($e.Reason -eq [Microsoft.Win32.SessionSwitchReason]::SessionUnlock)  { Send-Event 'unlock' }
  }
  [Microsoft.Win32.SystemEvents]::add_SessionSwitch($onSwitch)
  $onEnding = { param($s, $e) Send-Event 'shutdown' }
  [Microsoft.Win32.SystemEvents]::add_SessionEnding($onEnding)
  $subscribed = $true
  Log "lock/unlock detection: ON"
} catch { Log "lock/unlock detection OFF: $($_.Exception.Message)" }

$lastHb = [DateTime]::UtcNow
try {
  while ($true) {
    if ($haveForms) { [System.Windows.Forms.Application]::DoEvents() }
    Start-Sleep -Milliseconds 500
    if (([DateTime]::UtcNow - $lastHb).TotalSeconds -ge $Interval) {
      Invoke-SelfUpdate
      Send-Event 'heartbeat'
      $lastHb = [DateTime]::UtcNow
    }
  }
} finally {
  Send-Event 'shutdown'
  if ($subscribed) {
    try { [Microsoft.Win32.SystemEvents]::remove_SessionSwitch($onSwitch); [Microsoft.Win32.SystemEvents]::remove_SessionEnding($onEnding) } catch {}
  }
}
