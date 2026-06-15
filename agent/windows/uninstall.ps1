# Windows agent uninstall
$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'pmon-agent'
$InstallDir = Join-Path $env:LOCALAPPDATA 'pmon-agent'

Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*pmon-agent.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -Recurse -Force -Path $InstallDir
Write-Host '[pmon] Agent removed.'
