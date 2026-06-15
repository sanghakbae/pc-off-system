# Windows 에이전트 설치 — 현재 사용자 로그온 시 자동 시작되는 작업 스케줄러 등록
#
# 사용법 (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Server http://127.0.0.1:4501 -Token 우리팀토큰
#
# 세션 잠금/해제 이벤트는 대화형 로그온 세션에서만 발생하므로, '로그온 시' 트리거로
# 사용자 세션에서 실행되도록 등록합니다(관리자 권한 불필요).

param(
  [string]$Server   = 'http://127.0.0.1:4501',
  [string]$Token    = 'change-me-pmon-token',
  [int]   $Interval = 30
)

$ErrorActionPreference = 'Stop'
$TaskName  = 'pmon-agent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'pmon-agent'
$ScriptDst = Join-Path $InstallDir 'pmon-agent.ps1'
$ScriptSrc = Join-Path $PSScriptRoot 'pmon-agent.ps1'

Write-Host "[pmon] Server: $Server"
Write-Host "[pmon] Install dir: $InstallDir"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path $ScriptSrc -Destination $ScriptDst -Force

$pwsh = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptDst`" " +
        "-Server `"$Server`" -Token `"$Token`" -Interval $Interval"

$action   = New-ScheduledTaskAction -Execute $pwsh -Argument $args
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'PC 모니터링 에이전트' | Out-Null

# 지금 바로 시작
Start-ScheduledTask -TaskName $TaskName

Write-Host "[pmon] Installed. Status: Get-ScheduledTask -TaskName $TaskName"
Write-Host "[pmon] Log: $env:LOCALAPPDATA\pmon-agent\agent.log"
Write-Host "[pmon] Uninstall: powershell -ExecutionPolicy Bypass -File uninstall.ps1"
