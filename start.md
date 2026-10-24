# Starting kMonitor After a Server Reboot

**kMonitor** now includes a native **Adobe ColdFusion 2025 + IIS** backend (`Application.cfc`, `MonitorService.cfc`, `api.cfm`, `index.cfm`, `demo-kiosk.cfm`) in addition to the optional Node.js server.

---

## Option 1: ColdFusion 2025 + IIS (Recommended — Automatic on Reboot)

Because IIS (`W3SVC`) and **ColdFusion 2025 Application Server** (`ColdFusion 2025 Application Server`) run as automatic Windows Services, **kMonitor starts automatically whenever the Windows server reboots**.

### 1. Open the ColdFusion Dashboard
- **Dashboard URL**: `http://localhost/kMonitor/` (or `http://YOUR_SERVER_IP/kMonitor/index.cfm`)
- **Demo Kiosk Test Page**: `http://localhost/kMonitor/demo-kiosk.cfm?kioskId=kiosk-01`
- **ColdFusion JSON API Endpoint**: `http://localhost/kMonitor/api.cfm?action=state`

### 2. Verify ColdFusion & IIS Services After Reboot (If Needed)
If the page does not respond after a maintenance reboot, open PowerShell and verify both services are running:

```powershell
Get-Service "ColdFusion 2025 Application Server", "W3SVC"
```

To start or restart ColdFusion 2025:
```powershell
Restart-Service "ColdFusion 2025 Application Server"
```

### 3. Embed Snippet for Kiosk Web Apps (ColdFusion Backend)
Add this snippet before `</body>` in any kiosk web application:

```html
<script src="http://YOUR_SERVER_IP/kMonitor/kiosk-heartbeat.js"
        data-kiosk-id="kiosk-01"
        data-kiosk-name="Kiosk 01"
        data-show-indicator="true"></script>
```

---

## Option 2: Starting the Auto-Restart Watchdog on a Kiosk PC

On each physical kiosk machine (`kiosk-01` through `kiosk-08`), run [`Kiosk-Watchdog.ps1`](file:///c:/inetpub/kMonitor/Kiosk-Watchdog.ps1) to launch Chrome/Edge in `--kiosk` mode and automatically restart the browser if it crashes or stops sending heartbeats to ColdFusion:

```powershell
cd C:\inetpub\kMonitor
powershell.exe -ExecutionPolicy Bypass -File .\Kiosk-Watchdog.ps1 `
  -KioskId "kiosk-01" `
  -MonitorServerUrl "http://YOUR_SERVER_IP/kMonitor" `
  -KioskAppUrl "http://YOUR_SERVER_IP/kMonitor/demo-kiosk.cfm?kioskId=kiosk-01" `
  -Browser "auto"
```
