<cfcomponent output="false">

  <cffunction name="init" access="public" returnType="any" output="false">
    <cfargument name="dataDir" type="string" required="true">
    <cfscript>
      variables.dataDir = arguments.dataDir;
      variables.configFile = variables.dataDir & "/config.json";
      variables.eventsFile = variables.dataDir & "/events.json";
      variables.historyLength = 36;
      variables.lastTickMs = getTickCount();

      if (!directoryExists(variables.dataDir)) {
        directoryCreate(variables.dataDir, true);
      }

      variables.config = loadConfig();
      variables.eventLog = loadEvents();
      variables.kioskState = {};
      initKioskStates();
      return this;
    </cfscript>
  </cffunction>

  <cffunction name="getDefaultConfig" access="private" returnType="struct" output="false">
    <cfscript>
      var kiosks = [];
      for (var i = 1; i <= 8; i++) {
        var num = numberFormat(i, "00");
        arrayAppend(kiosks, {
          "id": "kiosk-" & num,
          "name": "Kiosk " & num,
          "location": "Zone " & ceiling(i / 2) & " - Station " & (((i - 1) % 2) + 1),
          "expectedUrl": "demo-kiosk.cfm?kioskId=kiosk-" & num,
          "maintenance": false
        });
      }
      return {
        "heartbeatIntervalSeconds": 5,
        "warningThresholdSeconds": 10,
        "crashTimeoutSeconds": 15,
        "autoRegisterUnknownKiosks": true,
        "smtp": {
          "enabled": false,
          "host": "",
          "port": 587,
          "secure": false,
          "user": "",
          "pass": "",
          "from": "alerts@chelancounty.gov",
          "to": "it-support@chelancounty.gov",
          "alertOnRecovery": true,
          "cooldownSeconds": 300
        },
        "kiosks": kiosks
      };
    </cfscript>
  </cffunction>

  <cffunction name="loadConfig" access="private" returnType="struct" output="false">
    <cfscript>
      var def = getDefaultConfig();
      try {
        if (fileExists(variables.configFile)) {
          var raw = fileRead(variables.configFile, "utf-8");
          var parsed = deserializeJSON(raw);
          structAppend(def, parsed, true);
          if (structKeyExists(parsed, "smtp") && isStruct(parsed.smtp)) {
            var mergedSmtp = getDefaultConfig().smtp;
            structAppend(mergedSmtp, parsed.smtp, true);
            def.smtp = mergedSmtp;
          }
          if (!structKeyExists(def, "kiosks") || !isArray(def.kiosks)) {
            def.kiosks = getDefaultConfig().kiosks;
          }
          return def;
        }
      } catch (any e) {
        // Fallback to default config
      }
      saveConfig(def);
      return def;
    </cfscript>
  </cffunction>

  <cffunction name="saveConfig" access="private" returnType="void" output="false">
    <cfargument name="cfg" type="struct" required="true">
    <cfscript>
      try {
        fileWrite(variables.configFile, serializeJSON(arguments.cfg), "utf-8");
      } catch (any e) {}
    </cfscript>
  </cffunction>

  <cffunction name="loadEvents" access="private" returnType="array" output="false">
    <cfscript>
      try {
        if (fileExists(variables.eventsFile)) {
          var parsed = deserializeJSON(fileRead(variables.eventsFile, "utf-8"));
          if (isArray(parsed)) return parsed;
        }
      } catch (any e) {}
      return [];
    </cfscript>
  </cffunction>

  <cffunction name="saveEvents" access="private" returnType="void" output="false">
    <cfscript>
      try {
        if (arrayLen(variables.eventLog) > 200) {
          variables.eventLog = arraySlice(variables.eventLog, 1, 200);
        }
        fileWrite(variables.eventsFile, serializeJSON(variables.eventLog), "utf-8");
      } catch (any e) {}
    </cfscript>
  </cffunction>

  <cffunction name="createInitialHistory" access="private" returnType="array" output="false">
    <cfscript>
      var arr = [];
      for (var i = 1; i <= variables.historyLength; i++) {
        arrayAppend(arr, {
          "beat": false,
          "status": "STANDBY"
        });
      }
      return arr;
    </cfscript>
  </cffunction>

  <cffunction name="initKioskStates" access="private" returnType="void" output="false">
    <cfscript>
      var validIds = {};
      for (var k in variables.config.kiosks) {
        validIds[k.id] = true;
        var hasExisting = structKeyExists(variables.kioskState, k.id);
        var existing = hasExisting ? variables.kioskState[k.id] : {};
        var isMaint = structKeyExists(k, "maintenance") && isBoolean(k.maintenance) ? (k.maintenance ? true : false) : false;

        var stateItem = {
          "id": k.id,
          "name": k.name,
          "location": structKeyExists(k, "location") ? k.location : "",
          "expectedUrl": structKeyExists(k, "expectedUrl") ? k.expectedUrl : "",
          "maintenance": isMaint,
          "status": hasExisting && structKeyExists(existing, "status") ? existing.status : "STANDBY",
          "lastHeartbeatAt": hasExisting && structKeyExists(existing, "lastHeartbeatAt") ? val(existing.lastHeartbeatAt) : 0,
          "prevHeartbeatAt": hasExisting && structKeyExists(existing, "prevHeartbeatAt") ? val(existing.prevHeartbeatAt) : 0,
          "lastIntervalSec": hasExisting && structKeyExists(existing, "lastIntervalSec") ? val(existing.lastIntervalSec) : 0,
          "firstSeenAt": hasExisting && structKeyExists(existing, "firstSeenAt") ? val(existing.firstSeenAt) : 0,
          "lastCrashAt": hasExisting && structKeyExists(existing, "lastCrashAt") ? val(existing.lastCrashAt) : 0,
          "lastEmailAlertAt": hasExisting && structKeyExists(existing, "lastEmailAlertAt") ? val(existing.lastEmailAlertAt) : 0,
          "heartbeatCount": hasExisting && structKeyExists(existing, "heartbeatCount") ? val(existing.heartbeatCount) : 0,
          "crashCount": hasExisting && structKeyExists(existing, "crashCount") ? val(existing.crashCount) : 0,
          "wsConnected": false,
          "simulated": hasExisting && structKeyExists(existing, "simulated") ? (existing.simulated ? true : false) : false,
          "simStartedAt": hasExisting && structKeyExists(existing, "simStartedAt") ? val(existing.simStartedAt) : 0,
          "lastSimBeatAt": hasExisting && structKeyExists(existing, "lastSimBeatAt") ? val(existing.lastSimBeatAt) : 0,
          "beatInCurrentTick": hasExisting && structKeyExists(existing, "beatInCurrentTick") ? (existing.beatInCurrentTick ? true : false) : false,
          "pulseHistory": hasExisting && structKeyExists(existing, "pulseHistory") && isArray(existing.pulseHistory)
            ? existing.pulseHistory
            : createInitialHistory(),
          "metrics": hasExisting && structKeyExists(existing, "metrics") ? existing.metrics : {
            "url": "",
            "title": "",
            "ip": "",
            "userAgent": "",
            "viewport": "",
            "memoryMB": 0,
            "pageUptimeSec": 0,
            "visibilityState": "",
            "watchdogActive": false,
            "lastWatchdogPingAt": 0
          }
        };

        if (isMaint) {
          stateItem.status = "MAINTENANCE";
        } else if (stateItem.status == "MAINTENANCE") {
          stateItem.status = (stateItem.lastHeartbeatAt > 0) ? "ONLINE" : "STANDBY";
        }

        variables.kioskState[k.id] = stateItem;
      }

      // Remove deleted kiosks
      var existingKeys = structKeyArray(variables.kioskState);
      for (var key in existingKeys) {
        if (!structKeyExists(validIds, key)) {
          structDelete(variables.kioskState, key);
        }
      }
    </cfscript>
  </cffunction>

  <cffunction name="isoTimestamp" access="private" returnType="string" output="false">
    <cfargument name="dt" type="date" default="#now()#">
    <cfreturn dateTimeFormat(arguments.dt, "yyyy-mm-dd'T'HH:nn:ss.lXXX")>
  </cffunction>

  <cffunction name="recordEvent" access="public" returnType="struct" output="false">
    <cfargument name="type" type="string" required="true">
    <cfargument name="kioskId" type="string" required="true">
    <cfargument name="message" type="string" required="true">
    <cfargument name="details" type="struct" default="#structNew()#">
    <cfscript>
      var kiosk = structKeyExists(variables.kioskState, arguments.kioskId) ? variables.kioskState[arguments.kioskId] : {};
      var entry = {
        "id": getTickCount() & "-" & right(createUUID(), 6),
        "timestamp": isoTimestamp(),
        "type": arguments.type,
        "kioskId": arguments.kioskId,
        "kioskName": structKeyExists(kiosk, "name") ? kiosk.name : arguments.kioskId,
        "location": structKeyExists(kiosk, "location") ? kiosk.location : "",
        "message": arguments.message,
        "details": arguments.details
      };
      arrayPrepend(variables.eventLog, entry);
      saveEvents();
      return entry;
    </cfscript>
  </cffunction>

  <cffunction name="sendCrashEmailAlert" access="private" returnType="void" output="false">
    <cfargument name="kiosk" type="struct" required="true">
    <cfargument name="reason" type="string" required="true">
    <cfargument name="isRecovery" type="boolean" default="false">

    <cfif NOT structKeyExists(variables.config, "smtp") OR NOT variables.config.smtp.enabled>
      <cfreturn>
    </cfif>
    <cfif arguments.isRecovery AND NOT variables.config.smtp.alertOnRecovery>
      <cfreturn>
    </cfif>

    <cfset var nowMs = getTickCount()>
    <cfset var cooldownMs = (val(variables.config.smtp.cooldownSeconds) GT 0 ? val(variables.config.smtp.cooldownSeconds) : 300) * 1000>
    <cfif NOT arguments.isRecovery AND val(arguments.kiosk.lastEmailAlertAt) GT 0>
      <cfif (nowMs - val(arguments.kiosk.lastEmailAlertAt)) LT cooldownMs>
        <cfreturn>
      </cfif>
    </cfif>

    <cfset var smtp = variables.config.smtp>
    <cfset var subject = arguments.isRecovery
      ? "[RESOLVED] Kiosk Browser Recovered: #arguments.kiosk.name# (#arguments.kiosk.id#)"
      : "[ALERT] Kiosk Browser CRASHED: #arguments.kiosk.name# (#arguments.kiosk.id#)">
    <cfset var headerBg = arguments.isRecovery ? "##16a34a" : "##dc2626">
    <cfset var statusLabel = arguments.isRecovery ? "ONLINE (Recovered)" : "CRASHED / UNRESPONSIVE">
    <cfset var lastUrl = len(arguments.kiosk.metrics.url ?: "") ? arguments.kiosk.metrics.url : "N/A">
    <cfset var lastIp = len(arguments.kiosk.metrics.ip ?: "") ? arguments.kiosk.metrics.ip : "N/A">

    <cftry>
      <cfif len(trim(smtp.host)) AND smtp.host NEQ "smtp.example.com">
        <cfif len(trim(smtp.user))>
          <cfmail
            from="#smtp.from#"
            to="#smtp.to#"
            subject="#subject#"
            type="html"
            server="#smtp.host#"
            port="#val(smtp.port) ?: 587#"
            useSSL="#smtp.secure ? true : false#"
            username="#smtp.user#"
            password="#smtp.pass#">
            <div style="font-family: system-ui, sans-serif; max-width: 600px; border: 1px solid ##e2e8f0; border-radius: 8px; overflow: hidden;">
              <div style="background: #headerBg#; color: ##ffffff; padding: 16px 20px;">
                <h2 style="margin: 0; font-size: 18px;">#encodeForHTML(subject)#</h2>
              </div>
              <div style="padding: 20px; color: ##1e293b; line-height: 1.5;">
                <p><strong>Kiosk:</strong> #encodeForHTML(arguments.kiosk.name)# (<code>#encodeForHTML(arguments.kiosk.id)#</code>)</p>
                <p><strong>Status:</strong> #encodeForHTML(statusLabel)#</p>
                <p><strong>Reason:</strong> #encodeForHTML(arguments.reason)#</p>
                <p><strong>Last Active URL:</strong> #encodeForHTML(lastUrl)#</p>
                <p><strong>IP Address:</strong> #encodeForHTML(lastIp)#</p>
                <p style="margin-top: 20px; font-size: 12px; color: ##64748b;">Sent by ColdFusion kMonitor Server at #dateTimeFormat(now(), "yyyy-mm-dd HH:nn:ss")#</p>
              </div>
            </div>
          </cfmail>
        <cfelse>
          <cfmail
            from="#smtp.from#"
            to="#smtp.to#"
            subject="#subject#"
            type="html"
            server="#smtp.host#"
            port="#val(smtp.port) ?: 587#"
            useSSL="#smtp.secure ? true : false#">
            <div style="font-family: system-ui, sans-serif; max-width: 600px; border: 1px solid ##e2e8f0; border-radius: 8px; overflow: hidden;">
              <div style="background: #headerBg#; color: ##ffffff; padding: 16px 20px;">
                <h2 style="margin: 0; font-size: 18px;">#encodeForHTML(subject)#</h2>
              </div>
              <div style="padding: 20px; color: ##1e293b; line-height: 1.5;">
                <p><strong>Kiosk:</strong> #encodeForHTML(arguments.kiosk.name)# (<code>#encodeForHTML(arguments.kiosk.id)#</code>)</p>
                <p><strong>Status:</strong> #encodeForHTML(statusLabel)#</p>
                <p><strong>Reason:</strong> #encodeForHTML(arguments.reason)#</p>
                <p><strong>Last Active URL:</strong> #encodeForHTML(lastUrl)#</p>
                <p><strong>IP Address:</strong> #encodeForHTML(lastIp)#</p>
                <p style="margin-top: 20px; font-size: 12px; color: ##64748b;">Sent by ColdFusion kMonitor Server at #dateTimeFormat(now(), "yyyy-mm-dd HH:nn:ss")#</p>
              </div>
            </div>
          </cfmail>
        </cfif>
      <cfelse>
        <!--- Use default ColdFusion Administrator Mail Server --->
        <cfmail
          from="#smtp.from#"
          to="#smtp.to#"
          subject="#subject#"
          type="html">
          <div style="font-family: system-ui, sans-serif; max-width: 600px; border: 1px solid ##e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background: #headerBg#; color: ##ffffff; padding: 16px 20px;">
              <h2 style="margin: 0; font-size: 18px;">#encodeForHTML(subject)#</h2>
            </div>
            <div style="padding: 20px; color: ##1e293b; line-height: 1.5;">
              <p><strong>Kiosk:</strong> #encodeForHTML(arguments.kiosk.name)# (<code>#encodeForHTML(arguments.kiosk.id)#</code>)</p>
              <p><strong>Status:</strong> #encodeForHTML(statusLabel)#</p>
              <p><strong>Reason:</strong> #encodeForHTML(arguments.reason)#</p>
              <p><strong>Last Active URL:</strong> #encodeForHTML(lastUrl)#</p>
              <p><strong>IP Address:</strong> #encodeForHTML(lastIp)#</p>
              <p style="margin-top: 20px; font-size: 12px; color: ##64748b;">Sent by ColdFusion kMonitor Server at #dateTimeFormat(now(), "yyyy-mm-dd HH:nn:ss")#</p>
            </div>
          </div>
        </cfmail>
      </cfif>

      <cfif NOT arguments.isRecovery>
        <cfset arguments.kiosk.lastEmailAlertAt = nowMs>
      </cfif>
      <cfset recordEvent("EMAIL", arguments.kiosk.id, "Sent #arguments.isRecovery ? 'recovery' : 'crash'# email alert to #smtp.to# via cfmail")>
    <cfcatch type="any">
      <cfset recordEvent("EMAIL", arguments.kiosk.id, "Failed to send email alert: #cfcatch.message#")>
    </cfcatch>
    </cftry>
  </cffunction>

  <cffunction name="sendTestEmail" access="public" returnType="struct" output="false">
    <cfargument name="smtpOverride" type="struct" default="#structNew()#">
    <cfset var smtp = duplicate(variables.config.smtp)>
    <cfset structAppend(smtp, arguments.smtpOverride, true)>

    <cftry>
      <cfif len(trim(smtp.host)) AND smtp.host NEQ "smtp.example.com">
        <cfif len(trim(smtp.user))>
          <cfmail
            from="#smtp.from#"
            to="#smtp.to#"
            subject="[TEST] ColdFusion kMonitor Crash Alert System"
            type="html"
            server="#smtp.host#"
            port="#val(smtp.port) ?: 587#"
            useSSL="#smtp.secure ? true : false#"
            username="#smtp.user#"
            password="#smtp.pass#">
            <div style="font-family: system-ui, sans-serif; padding: 20px; border: 1px solid ##cbd5e1; border-radius: 8px;">
              <h2 style="color: ##0f172a; margin-top: 0;">ColdFusion kMonitor SMTP Test Successful</h2>
              <p>Your ColdFusion <code>&lt;cfmail&gt;</code> settings are working properly. Alerts will be delivered to <strong>#encodeForHTML(smtp.to)#</strong>.</p>
            </div>
          </cfmail>
        <cfelse>
          <cfmail
            from="#smtp.from#"
            to="#smtp.to#"
            subject="[TEST] ColdFusion kMonitor Crash Alert System"
            type="html"
            server="#smtp.host#"
            port="#val(smtp.port) ?: 587#"
            useSSL="#smtp.secure ? true : false#">
            <div style="font-family: system-ui, sans-serif; padding: 20px; border: 1px solid ##cbd5e1; border-radius: 8px;">
              <h2 style="color: ##0f172a; margin-top: 0;">ColdFusion kMonitor SMTP Test Successful</h2>
              <p>Your ColdFusion <code>&lt;cfmail&gt;</code> settings are working properly. Alerts will be delivered to <strong>#encodeForHTML(smtp.to)#</strong>.</p>
            </div>
          </cfmail>
        </cfif>
      <cfelse>
        <cfmail
          from="#smtp.from#"
          to="#smtp.to#"
          subject="[TEST] ColdFusion kMonitor Crash Alert System"
          type="html">
          <div style="font-family: system-ui, sans-serif; padding: 20px; border: 1px solid ##cbd5e1; border-radius: 8px;">
            <h2 style="color: ##0f172a; margin-top: 0;">ColdFusion kMonitor SMTP Test Successful</h2>
            <p>Your ColdFusion default mail server settings are working properly. Alerts will be delivered to <strong>#encodeForHTML(smtp.to)#</strong>.</p>
          </div>
        </cfmail>
      </cfif>

      <cfset recordEvent("EMAIL", "SYSTEM", "Test email queued via ColdFusion cfmail to #smtp.to#")>
      <cfreturn { "ok": true, "message": "Test email sent to #smtp.to# via ColdFusion cfmail" }>
    <cfcatch type="any">
      <cfreturn { "ok": false, "error": cfcatch.message }>
    </cfcatch>
    </cftry>
  </cffunction>

  <cffunction name="processHeartbeat" access="public" returnType="struct" output="false">
    <cfargument name="kioskId" type="string" required="true">
    <cfargument name="payload" type="struct" default="#structNew()#">
    <cfargument name="clientIp" type="string" default="">

    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var cleanId = trim(arguments.kioskId);
        if (!len(cleanId)) return {};

        if (!structKeyExists(variables.kioskState, cleanId)) {
          if (!variables.config.autoRegisterUnknownKiosks) {
            return {};
          }
          var newKioskCfg = {
            "id": cleanId,
            "name": structKeyExists(arguments.payload, "kioskName") && len(arguments.payload.kioskName) ? arguments.payload.kioskName : cleanId,
            "location": structKeyExists(arguments.payload, "location") ? arguments.payload.location : "Auto-Registered",
            "expectedUrl": structKeyExists(arguments.payload, "url") ? arguments.payload.url : "",
            "maintenance": false
          };
          arrayAppend(variables.config.kiosks, newKioskCfg);
          saveConfig(variables.config);
          initKioskStates();
          recordEvent("INFO", cleanId, 'Auto-registered new kiosk "' & newKioskCfg.name & '"');
        }

        var kiosk = variables.kioskState[cleanId];
        var nowMs = getTickCount();
        var prevStatus = kiosk.status;

        if (val(kiosk.lastHeartbeatAt) > 0) {
          kiosk.prevHeartbeatAt = kiosk.lastHeartbeatAt;
          kiosk.lastIntervalSec = round(((nowMs - kiosk.lastHeartbeatAt) / 1000) * 10) / 10;
        }
        kiosk.lastHeartbeatAt = nowMs;
        kiosk.beatInCurrentTick = true;

        if (arrayLen(kiosk.pulseHistory) > 0) {
          kiosk.pulseHistory[arrayLen(kiosk.pulseHistory)] = {
            "beat": true,
            "status": kiosk.maintenance ? "MAINTENANCE" : "ONLINE"
          };
        }

        if (val(kiosk.firstSeenAt) == 0) {
          kiosk.firstSeenAt = nowMs;
        }
        kiosk.heartbeatCount = val(kiosk.heartbeatCount) + 1;

        if (structKeyExists(arguments.payload, "url") && !isNull(arguments.payload.url)) kiosk.metrics.url = toString(arguments.payload.url);
        if (structKeyExists(arguments.payload, "title") && !isNull(arguments.payload.title)) kiosk.metrics.title = toString(arguments.payload.title);
        if (len(arguments.clientIp)) kiosk.metrics.ip = arguments.clientIp;
        if (structKeyExists(arguments.payload, "userAgent") && !isNull(arguments.payload.userAgent)) kiosk.metrics.userAgent = toString(arguments.payload.userAgent);
        if (structKeyExists(arguments.payload, "viewport") && !isNull(arguments.payload.viewport)) kiosk.metrics.viewport = toString(arguments.payload.viewport);
        if (structKeyExists(arguments.payload, "memoryMB") && !isNull(arguments.payload.memoryMB)) kiosk.metrics.memoryMB = val(arguments.payload.memoryMB);
        if (structKeyExists(arguments.payload, "pageUptimeSec") && !isNull(arguments.payload.pageUptimeSec)) kiosk.metrics.pageUptimeSec = val(arguments.payload.pageUptimeSec);
        if (structKeyExists(arguments.payload, "visibilityState") && !isNull(arguments.payload.visibilityState)) kiosk.metrics.visibilityState = toString(arguments.payload.visibilityState);

        if (!kiosk.maintenance) {
          kiosk.status = "ONLINE";
          if (prevStatus == "CRASHED") {
            var downtimeSec = (val(kiosk.lastCrashAt) > 0)
              ? round((nowMs - val(kiosk.lastCrashAt)) / 1000)
              : 0;
            recordEvent("RECOVERY", kiosk.id, "Kiosk browser recovered after " & downtimeSec & "s offline", { "downtimeSec": downtimeSec });
            sendCrashEmailAlert(kiosk, "Heartbeat resumed after " & downtimeSec & "s", true);
          } else if (prevStatus == "STANDBY") {
            recordEvent("INFO", kiosk.id, "Kiosk connected and started sending heartbeats");
          }
        }

        return kiosk;
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="tick" access="public" returnType="void" output="false">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var nowMs = getTickCount();
        if ((nowMs - variables.lastTickMs) < 900) {
          return;
        }
        variables.lastTickMs = nowMs;

        var intervalMs = max(1000, val(variables.config.heartbeatIntervalSeconds) * 1000);
        var warnMs = val(variables.config.warningThresholdSeconds) * 1000;
        var crashMs = val(variables.config.crashTimeoutSeconds) * 1000;

        for (var cfgKiosk in variables.config.kiosks) {
          var kId = cfgKiosk.id;
          if (!structKeyExists(variables.kioskState, kId)) continue;
          var kiosk = variables.kioskState[kId];

          // Handle built-in simulator heartbeats
          if (kiosk.simulated && !kiosk.maintenance) {
            if ((nowMs - val(kiosk.lastSimBeatAt)) >= intervalMs) {
              kiosk.lastSimBeatAt = nowMs;
              processHeartbeat(
                kId,
                {
                  "url": len(kiosk.expectedUrl) ? kiosk.expectedUrl : "http://kiosk-app.local/station?id=" & kId,
                  "title": kiosk.name & " - Interactive Portal",
                  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ColdFusionSimulatedKiosk/1.0",
                  "viewport": "1920x1080",
                  "memoryMB": round(140 + sin(nowMs / 10000) * 15),
                  "pageUptimeSec": round((nowMs - val(kiosk.simStartedAt)) / 1000),
                  "visibilityState": "visible"
                },
                "127.0.0.1 (CF-Sim)"
              );
            }
          }

          if (kiosk.maintenance) {
            kiosk.status = "MAINTENANCE";
          } else if (val(kiosk.lastHeartbeatAt) > 0) {
            var elapsed = nowMs - val(kiosk.lastHeartbeatAt);
            if (elapsed >= crashMs) {
              if (kiosk.status != "CRASHED") {
                kiosk.status = "CRASHED";
                kiosk.lastCrashAt = nowMs;
                kiosk.crashCount = val(kiosk.crashCount) + 1;
                var secs = round(elapsed / 1000);
                var reason = "No heartbeat received for " & secs & "s (threshold: " & variables.config.crashTimeoutSeconds & "s)";
                recordEvent("CRASH", kiosk.id, reason, { "elapsedSeconds": secs });
                sendCrashEmailAlert(kiosk, reason, false);
              }
            } else if (elapsed >= warnMs) {
              if (kiosk.status == "ONLINE") {
                kiosk.status = "WARNING";
              }
            } else {
              kiosk.status = "ONLINE";
            }
          }

          // Advance 36-second rolling ECG pulseHistory
          arrayAppend(kiosk.pulseHistory, {
            "beat": kiosk.beatInCurrentTick ? true : false,
            "status": kiosk.status
          });
          if (arrayLen(kiosk.pulseHistory) > variables.historyLength) {
            arrayDeleteAt(kiosk.pulseHistory, 1);
          }
          kiosk.beatInCurrentTick = false;
        }
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="getFullSnapshot" access="public" returnType="struct" output="false">
    <cfscript>
      tick();
      var nowMs = getTickCount();
      var kiosksArr = [];
      var onlineCount = 0;
      var warningCount = 0;
      var crashedCount = 0;
      var standbyCount = 0;
      var maintCount = 0;

      for (var cfgKiosk in variables.config.kiosks) {
        var kId = cfgKiosk.id;
        if (!structKeyExists(variables.kioskState, kId)) continue;
        var k = variables.kioskState[kId];
        var hasBeat = val(k.lastHeartbeatAt) > 0;
        var ageSeconds = hasBeat
          ? max(0, round((nowMs - val(k.lastHeartbeatAt)) / 1000))
          : "";

        var kCopy = duplicate(k);
        kCopy["lastHeartbeatAgeSeconds"] = ageSeconds;
        arrayAppend(kiosksArr, kCopy);

        if (k.status == "ONLINE") onlineCount++;
        else if (k.status == "WARNING") warningCount++;
        else if (k.status == "CRASHED") crashedCount++;
        else if (k.status == "MAINTENANCE") maintCount++;
        else standbyCount++;
      }

      var safeSmtp = duplicate(variables.config.smtp);
      safeSmtp.pass = len(safeSmtp.pass) ? "••••••••" : "";

      var recentEvents = arrayLen(variables.eventLog) > 60
        ? arraySlice(variables.eventLog, 1, 60)
        : variables.eventLog;

      return {
        "backend": "ColdFusion 2025",
        "serverTime": isoTimestamp(),
        "config": {
          "heartbeatIntervalSeconds": variables.config.heartbeatIntervalSeconds,
          "warningThresholdSeconds": variables.config.warningThresholdSeconds,
          "crashTimeoutSeconds": variables.config.crashTimeoutSeconds,
          "autoRegisterUnknownKiosks": variables.config.autoRegisterUnknownKiosks,
          "smtp": safeSmtp,
          "kiosks": variables.config.kiosks
        },
        "summary": {
          "total": arrayLen(kiosksArr),
          "online": onlineCount,
          "warning": warningCount,
          "crashed": crashedCount,
          "standby": standbyCount,
          "maintenance": maintCount
        },
        "kiosks": kiosksArr,
        "events": recentEvents
      };
    </cfscript>
  </cffunction>

  <cffunction name="addKiosk" access="public" returnType="struct" output="false">
    <cfargument name="payload" type="struct" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var cleanId = trim(structKeyExists(arguments.payload, "id") ? arguments.payload.id : "");
        var cleanName = trim(structKeyExists(arguments.payload, "name") ? arguments.payload.name : "");

        if (!len(cleanId) || !len(cleanName)) {
          return { "ok": false, "status": 400, "error": "Kiosk ID and Display Name are required." };
        }

        for (var k in variables.config.kiosks) {
          if (lCase(k.id) == lCase(cleanId)) {
            return { "ok": false, "status": 409, "error": 'A kiosk with ID "' & cleanId & '" already exists.' };
          }
        }

        var newKiosk = {
          "id": cleanId,
          "name": cleanName,
          "location": trim(structKeyExists(arguments.payload, "location") ? arguments.payload.location : ""),
          "expectedUrl": trim(structKeyExists(arguments.payload, "expectedUrl") ? arguments.payload.expectedUrl : ""),
          "maintenance": structKeyExists(arguments.payload, "maintenance") && isBoolean(arguments.payload.maintenance) ? (arguments.payload.maintenance ? true : false) : false
        };

        arrayAppend(variables.config.kiosks, newKiosk);
        saveConfig(variables.config);
        initKioskStates();
        recordEvent("INFO", cleanId, 'Added new kiosk "' & cleanName & '" (' & cleanId & ')');

        return { "ok": true, "status": 201, "kiosk": variables.kioskState[cleanId] };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="updateKiosk" access="public" returnType="struct" output="false">
    <cfargument name="originalId" type="string" required="true">
    <cfargument name="payload" type="struct" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var origId = trim(arguments.originalId);
        var idx = 0;
        for (var i = 1; i <= arrayLen(variables.config.kiosks); i++) {
          if (variables.config.kiosks[i].id == origId) {
            idx = i;
            break;
          }
        }
        if (idx == 0) {
          return { "ok": false, "status": 404, "error": 'Kiosk "' & origId & '" not found.' };
        }

        var newId = trim(structKeyExists(arguments.payload, "id") && len(arguments.payload.id) ? arguments.payload.id : origId);
        var newName = trim(structKeyExists(arguments.payload, "name") && len(arguments.payload.name) ? arguments.payload.name : variables.config.kiosks[idx].name);

        if (newId != origId) {
          for (var k in variables.config.kiosks) {
            if (lCase(k.id) == lCase(newId)) {
              return { "ok": false, "status": 409, "error": 'Another kiosk with ID "' & newId & '" already exists.' };
            }
          }
          if (structKeyExists(variables.kioskState, origId)) {
            var existingState = variables.kioskState[origId];
            structDelete(variables.kioskState, origId);
            existingState.id = newId;
            variables.kioskState[newId] = existingState;
          }
        }

        variables.config.kiosks[idx] = {
          "id": newId,
          "name": newName,
          "location": structKeyExists(arguments.payload, "location") ? trim(arguments.payload.location) : variables.config.kiosks[idx].location,
          "expectedUrl": structKeyExists(arguments.payload, "expectedUrl") ? trim(arguments.payload.expectedUrl) : variables.config.kiosks[idx].expectedUrl,
          "maintenance": structKeyExists(arguments.payload, "maintenance") && isBoolean(arguments.payload.maintenance)
            ? (arguments.payload.maintenance ? true : false)
            : variables.config.kiosks[idx].maintenance
        };

        saveConfig(variables.config);
        initKioskStates();
        recordEvent("INFO", newId, 'Updated kiosk settings for "' & newName & '" (' & newId & ')');

        return { "ok": true, "status": 200, "kiosk": variables.kioskState[newId] };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="deleteKiosk" access="public" returnType="struct" output="false">
    <cfargument name="targetId" type="string" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var idx = 0;
        for (var i = 1; i <= arrayLen(variables.config.kiosks); i++) {
          if (variables.config.kiosks[i].id == arguments.targetId) {
            idx = i;
            break;
          }
        }
        if (idx == 0) {
          return { "ok": false, "status": 404, "error": 'Kiosk "' & arguments.targetId & '" not found.' };
        }
        var removedName = variables.config.kiosks[idx].name;
        arrayDeleteAt(variables.config.kiosks, idx);
        structDelete(variables.kioskState, arguments.targetId);
        saveConfig(variables.config);
        recordEvent("INFO", arguments.targetId, 'Deleted kiosk "' & removedName & '" (' & arguments.targetId & ')');
        return { "ok": true, "status": 200 };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="kioskAction" access="public" returnType="struct" output="false">
    <cfargument name="targetId" type="string" required="true">
    <cfargument name="action" type="string" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        if (!structKeyExists(variables.kioskState, arguments.targetId)) {
          return { "ok": false, "status": 404, "error": "Kiosk not found" };
        }
        var kiosk = variables.kioskState[arguments.targetId];
        var act = arguments.action;
        var nowMs = getTickCount();

        if (act == "acknowledge" || act == "reset") {
          kiosk.simulated = false;
          kiosk.status = kiosk.maintenance ? "MAINTENANCE" : "STANDBY";
          kiosk.lastHeartbeatAt = 0;
          kiosk.prevHeartbeatAt = 0;
          kiosk.lastIntervalSec = 0;
          kiosk.pulseHistory = createInitialHistory();
          recordEvent("INFO", kiosk.id, "Kiosk status manually reset to Standby");
        } else if (act == "toggle_maintenance") {
          kiosk.maintenance = !kiosk.maintenance;
          for (var cfgKiosk in variables.config.kiosks) {
            if (cfgKiosk.id == kiosk.id) {
              cfgKiosk.maintenance = kiosk.maintenance;
            }
          }
          saveConfig(variables.config);
          kiosk.status = kiosk.maintenance ? "MAINTENANCE" : "STANDBY";
          recordEvent("INFO", kiosk.id, "Maintenance mode " & (kiosk.maintenance ? "ENABLED" : "DISABLED"));
        } else if (act == "simulate_start") {
          kiosk.simulated = true;
          kiosk.simStartedAt = nowMs;
          kiosk.lastSimBeatAt = nowMs;
          processHeartbeat(
            kiosk.id,
            {
              "url": len(kiosk.expectedUrl) ? kiosk.expectedUrl : "http://kiosk-app.local/station?id=" & kiosk.id,
              "title": kiosk.name & " - Interactive Portal",
              "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ColdFusionSimulatedKiosk/1.0",
              "viewport": "1920x1080",
              "memoryMB": 142,
              "pageUptimeSec": 1,
              "visibilityState": "visible"
            },
            "127.0.0.1 (CF-Sim)"
          );
        } else if (act == "simulate_crash") {
          kiosk.simulated = false;
          if (val(kiosk.lastHeartbeatAt) == 0) {
            kiosk.lastHeartbeatAt = nowMs - (val(variables.config.crashTimeoutSeconds) * 1000);
          }
          recordEvent("WARNING", kiosk.id, "Simulated browser freeze/crash initiated on " & kiosk.name & " (heartbeats stopped)");
        }

        return { "ok": true, "status": 200, "kiosk": kiosk };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="simulatorAction" access="public" returnType="struct" output="false">
    <cfargument name="action" type="string" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var nowMs = getTickCount();
        if (arguments.action == "start_all") {
          for (var cfgKiosk in variables.config.kiosks) {
            var k = variables.kioskState[cfgKiosk.id];
            if (!k.maintenance) {
              k.simulated = true;
              k.simStartedAt = nowMs;
              k.lastSimBeatAt = nowMs;
              processHeartbeat(
                k.id,
                {
                  "url": len(k.expectedUrl) ? k.expectedUrl : "http://kiosk-app.local/station?id=" & k.id,
                  "title": k.name & " - Interactive Portal",
                  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ColdFusionSimulatedKiosk/1.0",
                  "viewport": "1920x1080",
                  "memoryMB": 142,
                  "pageUptimeSec": 1,
                  "visibilityState": "visible"
                },
                "127.0.0.1 (CF-Sim)"
              );
            }
          }
          recordEvent("INFO", "SYSTEM", "Started ColdFusion heartbeat simulator for all active kiosks");
        } else if (arguments.action == "stop_all") {
          for (var cfgKiosk in variables.config.kiosks) {
            var k = variables.kioskState[cfgKiosk.id];
            k.simulated = false;
            if (!k.maintenance) {
              k.status = "STANDBY";
              k.lastHeartbeatAt = 0;
              k.prevHeartbeatAt = 0;
              k.lastIntervalSec = 0;
              k.pulseHistory = createInitialHistory();
            }
          }
          recordEvent("INFO", "SYSTEM", "Stopped all simulated kiosks and reset to Standby");
        }
        return { "ok": true };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="getConfig" access="public" returnType="struct" output="false">
    <cfreturn variables.config>
  </cffunction>

  <cffunction name="updateConfig" access="public" returnType="struct" output="false">
    <cfargument name="incoming" type="struct" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        if (structKeyExists(arguments.incoming, "heartbeatIntervalSeconds")) {
          variables.config.heartbeatIntervalSeconds = max(1, val(arguments.incoming.heartbeatIntervalSeconds));
        }
        if (structKeyExists(arguments.incoming, "warningThresholdSeconds")) {
          variables.config.warningThresholdSeconds = max(2, val(arguments.incoming.warningThresholdSeconds));
        }
        if (structKeyExists(arguments.incoming, "crashTimeoutSeconds")) {
          variables.config.crashTimeoutSeconds = max(3, val(arguments.incoming.crashTimeoutSeconds));
        }
        if (structKeyExists(arguments.incoming, "smtp") && isStruct(arguments.incoming.smtp)) {
          structAppend(variables.config.smtp, arguments.incoming.smtp, true);
        }
        if (structKeyExists(arguments.incoming, "kiosks") && isArray(arguments.incoming.kiosks)) {
          variables.config.kiosks = arguments.incoming.kiosks;
        }
        saveConfig(variables.config);
        initKioskStates();
        recordEvent("INFO", "SYSTEM", "System configuration updated");
        return { "ok": true, "config": variables.config };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="clearEvents" access="public" returnType="struct" output="false">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfset variables.eventLog = []>
      <cfset saveEvents()>
      <cfreturn { "ok": true }>
    </cflock>
  </cffunction>

  <cffunction name="getWatchdogStatus" access="public" returnType="struct" output="false">
    <cfargument name="kioskId" type="string" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        tick();
        if (!structKeyExists(variables.kioskState, arguments.kioskId)) {
          return { "found": false };
        }
        var kiosk = variables.kioskState[arguments.kioskId];
        var nowMs = getTickCount();
        kiosk.metrics.watchdogActive = true;
        kiosk.metrics.lastWatchdogPingAt = nowMs;

        var hasBeat = val(kiosk.lastHeartbeatAt) > 0;
        var ageSeconds = hasBeat
          ? round((nowMs - val(kiosk.lastHeartbeatAt)) / 1000)
          : "";

        return {
          "found": true,
          "id": kiosk.id,
          "name": kiosk.name,
          "status": kiosk.status,
          "maintenance": kiosk.maintenance,
          "lastHeartbeatAgeSeconds": ageSeconds,
          "crashTimeoutSeconds": variables.config.crashTimeoutSeconds,
          "expectedUrl": kiosk.expectedUrl,
          "shouldRestartBrowser": (!kiosk.maintenance && kiosk.status == "CRASHED") ? true : false
        };
      </cfscript>
    </cflock>
  </cffunction>

  <cffunction name="recordWatchdogEvent" access="public" returnType="struct" output="false">
    <cfargument name="payload" type="struct" required="true">
    <cflock name="kMonitorStateLock" type="exclusive" timeout="10">
      <cfscript>
        var kId = structKeyExists(arguments.payload, "kioskId") ? trim(arguments.payload.kioskId) : "";
        var evType = structKeyExists(arguments.payload, "event") ? arguments.payload.event : "WATCHDOG";
        var msg = structKeyExists(arguments.payload, "message") ? arguments.payload.message : ("Watchdog event: " & evType);

        if (len(kId) && structKeyExists(variables.kioskState, kId)) {
          var kiosk = variables.kioskState[kId];
          var nowMs = getTickCount();
          kiosk.metrics.watchdogActive = true;
          kiosk.metrics.lastWatchdogPingAt = nowMs;

          if (evType == "PROCESS_CRASHED" && !kiosk.maintenance && kiosk.status != "CRASHED") {
            kiosk.status = "CRASHED";
            kiosk.lastCrashAt = nowMs;
            kiosk.crashCount = val(kiosk.crashCount) + 1;
            recordEvent("CRASH", kiosk.id, msg);
            sendCrashEmailAlert(kiosk, msg, false);
          } else {
            recordEvent("WATCHDOG", kiosk.id, msg);
          }
        }
        return { "ok": true };
      </cfscript>
    </cflock>
  </cffunction>

</cfcomponent>

