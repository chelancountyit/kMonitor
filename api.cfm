<cfscript>
cfheader(name="Access-Control-Allow-Origin", value="*");
cfheader(name="Access-Control-Allow-Methods", value="GET, POST, PUT, DELETE, OPTIONS");
cfheader(name="Access-Control-Allow-Headers", value="Content-Type");
cfheader(name="Cache-Control", value="no-store, no-cache, must-revalidate, max-age=0");

if (cgi.request_method == "OPTIONS") {
    cfheader(statuscode="204");
    abort;
}

cfcontent(type="application/json; charset=utf-8");

action = lCase(trim(url.action ?: "state"));

// Parse JSON request body if present
body = {};
reqData = getHttpRequestData();
if (structKeyExists(reqData, "content")) {
    rawContent = "";
    if (isBinary(reqData.content)) {
        rawContent = charsetEncode(reqData.content, "utf-8");
    } else if (isSimpleValue(reqData.content)) {
        rawContent = toString(reqData.content);
    }
    rawContent = trim(rawContent);
    if (len(rawContent) && (left(rawContent, 1) == "{" || left(rawContent, 1) == "[")) {
        try {
            body = deserializeJSON(rawContent);
        } catch (any e) {
            body = {};
        }
    }
}

svc = application.monitorService;
response = {};

try {
    switch (action) {
        case "state":
            response = svc.getFullSnapshot();
            break;

        case "heartbeat":
            kioskId = trim(body.kioskId ?: (url.kioskId ?: ""));
            if (!len(kioskId)) {
                cfheader(statuscode="400");
                response = { "ok": false, "error": "kioskId is required" };
            } else {
                clientIp = cgi.remote_addr ?: "unknown";
                if (len(cgi.http_x_forwarded_for ?: "")) {
                    clientIp = trim(listFirst(cgi.http_x_forwarded_for));
                }
                kiosk = svc.processHeartbeat(kioskId, body, clientIp);
                cfg = svc.getConfig();
                hasKiosk = isStruct(kiosk) && structKeyExists(kiosk, "status");
                response = {
                    "ok": hasKiosk,
                    "serverTime": dateTimeFormat(now(), "yyyy-mm-dd'T'HH:nn:ss.lXXX"),
                    "heartbeatIntervalSeconds": cfg.heartbeatIntervalSeconds,
                    "status": hasKiosk ? kiosk.status : "IGNORED"
                };
            }
            break;

        case "kiosk_create":
            response = svc.addKiosk(body);
            if (!response.ok) {
                cfheader(statuscode=response.status ?: 400);
            }
            break;

        case "kiosk_update":
            targetId = trim(url.id ?: (body.originalId ?: (body.id ?: "")));
            response = svc.updateKiosk(targetId, body);
            if (!response.ok) {
                cfheader(statuscode=response.status ?: 400);
            }
            break;

        case "kiosk_delete":
            targetId = trim(url.id ?: (body.id ?: ""));
            response = svc.deleteKiosk(targetId);
            if (!response.ok) {
                cfheader(statuscode=response.status ?: 404);
            }
            break;

        case "kiosk_action":
            targetId = trim(url.id ?: (body.id ?: ""));
            kioskAct = trim(body.action ?: (body.kioskAction ?: (url.kioskAction ?: "")));
            response = svc.kioskAction(targetId, kioskAct);
            if (!response.ok) {
                cfheader(statuscode=response.status ?: 400);
            }
            break;

        case "simulator":
            simAct = trim(body.action ?: (url.simAction ?: ""));
            if (!len(simAct) && structKeyExists(body, "enabled")) {
                simAct = body.enabled ? "start_all" : "stop_all";
            }
            response = svc.simulatorAction(simAct);
            break;

        case "config":
            if (cgi.request_method == "PUT" || cgi.request_method == "POST") {
                response = svc.updateConfig(body);
            } else {
                cfg = duplicate(svc.getConfig());
                if (structKeyExists(cfg, "smtp") && isStruct(cfg.smtp)) {
                    cfg.smtp.pass = len(cfg.smtp.pass ?: "") ? "••••••••" : "";
                }
                response = cfg;
            }
            break;

        case "config_save":
            response = svc.updateConfig(body);
            break;

        case "events_clear":
            response = svc.clearEvents();
            break;

        case "test_email":
            smtpOverride = (structKeyExists(body, "smtp") && isStruct(body.smtp)) ? body.smtp : body;
            response = svc.sendTestEmail(smtpOverride);
            if (!response.ok) {
                cfheader(statuscode="400");
            }
            break;

        case "watchdog":
            kioskId = trim(url.kioskId ?: (body.kioskId ?: ""));
            response = svc.getWatchdogStatus(kioskId);
            if (!response.found) {
                cfheader(statuscode="404");
            }
            break;

        case "watchdog_event":
            response = svc.recordWatchdogEvent(body);
            break;

        default:
            cfheader(statuscode="400");
            response = { "ok": false, "error": "Unknown action: #action#" };
            break;
    }
} catch (any err) {
    cfheader(statuscode="500");
    response = {
        "ok": false,
        "error": err.message,
        "detail": err.detail ?: ""
    };
}

writeOutput(serializeJSON(response));
</cfscript>
