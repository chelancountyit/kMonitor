# Starting kMonitor After a Reboot (`start.md`)

This guide covers how to start the **kMonitor Server** (`c:\inetpub\kMonitor`) and the **Kiosk Watchdog** (`Kiosk-Watchdog.ps1`) manually after a system reboot, as well as how to configure Windows to start them automatically on boot.

---

## Part 1: Manual Start After a Reboot

If you just rebooted the server and want to start **kMonitor** immediately:

1. Open **PowerShell** or **Command Prompt**.
2. Run:
   ```powershell
   cd C:\inetpub\kMonitor
   npm start
   ```
   *(Or run `node C:\inetpub\kMonitor\server.js` directly.)*
3. Open the dashboard at: **http://localhost:3000**

---

## Part 2: Auto-Start the kMonitor Server on Windows Reboot

Choose **one** of the options below so `kMonitor` starts automatically whenever the Windows server reboots—even before anyone logs in.

### Option A: Windows Task Scheduler (Built-in, No Extra Tools Required)

Run the following command in an **Administrator PowerShell** window to register a scheduled task named `kMonitor-Server` that starts automatically at boot:

```powershell
$NodePath = (Get-Command node).Source
$Action   = New-ScheduledTaskAction -Execute $NodePath -Argument "C:\inetpub\kMonitor\server.js" -WorkingDirectory "C:\inetpub\kMonitor"
$Trigger  = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "kMonitor-Server" `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -User "SYSTEM" `
  -RunLevel Highest `
  -Force
```

#### Useful Task Scheduler Commands:
- **Start the task immediately:**
  ```powershell
  Start-ScheduledTask -TaskName "kMonitor-Server"
  ```
- **Check if the task is running:**
  ```powershell
  Get-ScheduledTask -TaskName "kMonitor-Server" | Select-Object TaskName, State
  ```
- **Remove the scheduled task:**
  ```powershell
  Unregister-ScheduledTask -TaskName "kMonitor-Server" -Confirm:$false
  ```

---

### Option B: Using PM2 Process Manager (Auto-Restarts on Crash + Boot)

If you prefer **PM2** to manage the Node.js process and logs:

1. Install PM2 and the Windows startup helper globally in an **Administrator PowerShell**:
   ```powershell
   npm install -g pm2 pm2-windows-startup
   pm2-startup install
   ```
2. Start `kMonitor` under PM2 and save the process list:
   ```powershell
   cd C:\inetpub\kMonitor
   pm2 start server.js --name "kMonitor"
   pm2 save
   ```
3. Useful PM2 commands after reboot:
   ```powershell
   pm2 status
   pm2 logs kMonitor
   pm2 restart kMonitor
   ```

---

## Part 3: Auto-Start Each Kiosk Browser on Kiosk PC Reboot

To make each of your 8 kiosk PCs automatically launch the browser in `--kiosk` mode and self-heal after a reboot:

1. Copy [`scripts\Kiosk-Watchdog.ps1`](file:///c:/inetpub/kMonitor/scripts/Kiosk-Watchdog.ps1) to the kiosk PC (for example, `C:\kiosk\Kiosk-Watchdog.ps1`), or download it from `http://<MONITOR_SERVER_IP>:3000/Kiosk-Watchdog.ps1`.
2. On the **Kiosk PC**, open **PowerShell as Administrator** and register a Logon Scheduled Task (replace `kiosk-01`, `<MONITOR_SERVER_IP>`, and your kiosk app URL):

```powershell
$KioskId     = "kiosk-01"
$MonitorUrl  = "http://192.168.1.10:3000"
$KioskAppUrl = "https://your-kiosk-app.local/?kioskId=kiosk-01"

$Args = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"C:\kiosk\Kiosk-Watchdog.ps1`" -KioskId `"$KioskId`" -MonitorServerUrl `"$MonitorUrl`" -KioskAppUrl `"$KioskAppUrl`""

$Action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Args -WorkingDirectory "C:\kiosk"
$Trigger  = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "kMonitor-Kiosk-Watchdog" `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Force
```

---

## Part 4: Verify Firewall Port (First-Time Setup)

Ensure Windows Firewall on the **kMonitor Server** allows inbound traffic on port `3000` so the 8 kiosks can send heartbeats over the network:

```powershell
New-NetFirewallRule -DisplayName "kMonitor Server (TCP 3000)" `
  -Direction Inbound `
  -LocalPort 3000 `
  -Protocol TCP `
  -Action Allow
```

