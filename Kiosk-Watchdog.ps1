<#
.SYNOPSIS
  kMonitor Kiosk Browser Watchdog & Auto-Restart Script (ColdFusion 2025 / IIS Ready)
.DESCRIPTION
  Runs continuously on a Kiosk PC. Monitors both:
    1. Local browser process health (Chrome or Edge in Kiosk mode)
    2. Heartbeat status on the central ColdFusion kMonitor server (catches frozen tabs / "Aw, Snap!" renderer crashes)
  Automatically kills hung browser processes and relaunches the kiosk browser when a crash or freeze is detected.
.EXAMPLE
  powershell.exe -ExecutionPolicy Bypass -File .\Kiosk-Watchdog.ps1 -KioskId "kiosk-01" -MonitorServerUrl "http://YOUR_SERVER/kMonitor" -KioskAppUrl "https://your-kiosk-app.local/?kioskId=kiosk-01"
#>

param(
  [Parameter(Mandatory = $false)]
  [string]$KioskId = "kiosk-01",

  [Parameter(Mandatory = $false)]
  [string]$MonitorServerUrl = "http://localhost/kMonitor",

  [Parameter(Mandatory = $false)]
  [string]$KioskAppUrl = "http://localhost/kMonitor/demo-kiosk.cfm?kioskId=kiosk-01",

  [Parameter(Mandatory = $false)]
  [ValidateSet("msedge", "chrome", "auto")]
  [string]$Browser = "auto",

  [Parameter(Mandatory = $false)]
  [int]$CheckIntervalSeconds = 5,

  [Parameter(Mandatory = $false)]
  [int]$StartupGracePeriodSeconds = 25
)

$ErrorActionPreference = "SilentlyContinue"
$MonitorServerUrl = $MonitorServerUrl.TrimEnd('/')

function Resolve-BrowserExecutable {
  param([string]$Preferred)

  $candidates = @()
  if ($Preferred -eq "chrome" -or $Preferred -eq "auto") {
    $candidates += @(
      @{ Name = "chrome"; Path = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" },
      @{ Name = "chrome"; Path = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" },
      @{ Name = "chrome"; Path = "$env:LocalAppData\Google\Chrome\Application\chrome.exe" }
    )
  }
  if ($Preferred -eq "msedge" -or $Preferred -eq "auto") {
    $candidates += @(
      @{ Name = "msedge"; Path = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" },
      @{ Name = "msedge"; Path = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
    )
  }

  foreach ($c in $candidates) {
    if (Test-Path $c.Path) {
      return $c
    }
  }
  return @{ Name = "msedge"; Path = "msedge.exe" }
}

function Send-WatchdogEvent {
  param(
    [string]$EventType,
    [string]$Message
  )
  try {
    $body = @{
      kioskId = $KioskId
      event   = $EventType
      message = $Message
      details = @{
        hostname = $env:COMPUTERNAME
        browser  = $browserInfo.Name
      }
    } | ConvertTo-Json -Compress

    Invoke-RestMethod -Uri "$MonitorServerUrl/api.cfm?action=watchdog_event" `
      -Method Post `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 4 | Out-Null
  } catch {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Warning: Could not reach ColdFusion kMonitor at $MonitorServerUrl" -ForegroundColor Yellow
  }
}

$browserInfo = Resolve-BrowserExecutable -Preferred $Browser
$lastLaunchTime = [DateTime]::MinValue

function Start-KioskBrowser {
  param([string]$Reason)

  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Launching $($browserInfo.Name) for $KioskId ($Reason)..." -ForegroundColor Cyan

  # Terminate any lingering hung browser processes
  Get-Process -Name $browserInfo.Name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  $arguments = @(
    "--kiosk `"$KioskAppUrl`"",
    "--no-first-run",
    "--disable-infobars",
    "--disable-session-crashed-bubble",
    "--noerrdialogs"
  ) -join " "

  Start-Process -FilePath $browserInfo.Path -ArgumentList $arguments
  $script:lastLaunchTime = Get-Date
  Send-WatchdogEvent -EventType "BROWSER_LAUNCHED" -Message "Watchdog launched $($browserInfo.Name) in kiosk mode ($Reason)"
}

Write-Host "=====================================================" -ForegroundColor Green
Write-Host "  kMonitor Kiosk Watchdog Active (ColdFusion Backend)" -ForegroundColor Green
Write-Host "  Kiosk ID:     $KioskId"
Write-Host "  Monitor URL:  $MonitorServerUrl"
Write-Host "  Target URL:   $KioskAppUrl"
Write-Host "  Browser:      $($browserInfo.Name) ($($browserInfo.Path))"
Write-Host "=====================================================" -ForegroundColor Green

# Initial launch if browser is not already running
$running = Get-Process -Name $browserInfo.Name -ErrorAction SilentlyContinue
if (-not $running) {
  Start-KioskBrowser -Reason "Initial watchdog startup"
} else {
  $lastLaunchTime = Get-Date
  Send-WatchdogEvent -EventType "WATCHDOG_STARTED" -Message "Watchdog attached to existing $($browserInfo.Name) process on $env:COMPUTERNAME"
}

while ($true) {
  Start-Sleep -Seconds $CheckIntervalSeconds

  # 1. Check if the browser process is still alive locally
  $procs = Get-Process -Name $browserInfo.Name -ErrorAction SilentlyContinue
  if (-not $procs) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ALERT: Browser process ($($browserInfo.Name)) is not running!" -ForegroundColor Red
    Send-WatchdogEvent -EventType "PROCESS_CRASHED" -Message "Browser process ($($browserInfo.Name)) terminated unexpectedly on $env:COMPUTERNAME"
    Start-KioskBrowser -Reason "Process crashed or closed"
    continue
  }

  # 2. Check with ColdFusion kMonitor server whether the browser's JS heartbeat has timed out
  $secondsSinceLaunch = ((Get-Date) - $lastLaunchTime).TotalSeconds
  if ($secondsSinceLaunch -lt $StartupGracePeriodSeconds) {
    continue
  }

  try {
    $status = Invoke-RestMethod -Uri "$MonitorServerUrl/api.cfm?action=watchdog&kioskId=$KioskId" -Method Get -TimeoutSec 4
    if ($status.maintenance) {
      continue
    }
    if ($status.shouldRestartBrowser) {
      Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ALERT: ColdFusion kMonitor reported missed heartbeats ($($status.lastHeartbeatAgeSeconds)s). Restarting frozen browser..." -ForegroundColor Red
      Start-KioskBrowser -Reason "Heartbeat timeout ($($status.lastHeartbeatAgeSeconds)s unresponsive)"
    }
  } catch {
    # If kMonitor server is temporarily unreachable on the network, do not kill a running local browser
  }
}

