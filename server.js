const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const HISTORY_LENGTH = 36; // 36 seconds of rolling 1s telemetry slots

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default configuration with 8 kiosks
const DEFAULT_CONFIG = {
  heartbeatIntervalSeconds: 5,
  warningThresholdSeconds: 10,
  crashTimeoutSeconds: 15,
  autoRegisterUnknownKiosks: true,
  smtp: {
    enabled: false,
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: '"kMonitor Alert" <alerts@example.com>',
    to: 'admin@example.com',
    alertOnRecovery: true,
    cooldownSeconds: 300
  },
  kiosks: Array.from({ length: 8 }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      id: `kiosk-${num}`,
      name: `Kiosk ${num}`,
      location: `Zone ${Math.ceil((i + 1) / 2)} - Station ${(i % 2) + 1}`,
      expectedUrl: `http://localhost:3000/demo-kiosk.html?kioskId=kiosk-${num}`,
      maintenance: false
    };
  })
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        smtp: { ...DEFAULT_CONFIG.smtp, ...(parsed.smtp || {}) },
        kiosks: Array.isArray(parsed.kiosks)
          ? parsed.kiosks
          : DEFAULT_CONFIG.kiosks
      };
    }
  } catch (err) {
    console.error('Error loading config.json, using defaults:', err.message);
  }
  saveConfig(DEFAULT_CONFIG);
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config.json:', err.message);
  }
}

function loadEvents() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading events.json:', err.message);
  }
  return [];
}

function saveEvents(events) {
  try {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.slice(0, 200), null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving events.json:', err.message);
  }
}

let config = loadConfig();
let eventLog = loadEvents();

// Runtime state for each kiosk
const kioskState = new Map();

function createInitialHistory() {
  return Array.from({ length: HISTORY_LENGTH }, () => ({
    beat: false,
    status: 'STANDBY'
  }));
}

function initKioskStates() {
  const validIds = new Set();
  for (const k of config.kiosks) {
    validIds.add(k.id);
    const existing = kioskState.get(k.id);
    kioskState.set(k.id, {
      id: k.id,
      name: k.name,
      location: k.location || '',
      expectedUrl: k.expectedUrl || '',
      maintenance: Boolean(k.maintenance),
      status: existing ? existing.status : 'STANDBY', // STANDBY | ONLINE | WARNING | CRASHED | MAINTENANCE
      lastHeartbeatAt: existing ? existing.lastHeartbeatAt : null,
      prevHeartbeatAt: existing ? existing.prevHeartbeatAt : null,
      lastIntervalSec: existing ? existing.lastIntervalSec : null,
      firstSeenAt: existing ? existing.firstSeenAt : null,
      lastCrashAt: existing ? existing.lastCrashAt : null,
      lastEmailAlertAt: existing ? existing.lastEmailAlertAt : null,
      heartbeatCount: existing ? existing.heartbeatCount : 0,
      crashCount: existing ? existing.crashCount : 0,
      wsConnected: existing ? existing.wsConnected : false,
      simulated: existing ? existing.simulated : false,
      beatInCurrentTick: existing ? existing.beatInCurrentTick : false,
      pulseHistory: existing && Array.isArray(existing.pulseHistory)
        ? existing.pulseHistory
        : createInitialHistory(),
      metrics: existing ? existing.metrics : {
        url: null,
        title: null,
        ip: null,
        userAgent: null,
        viewport: null,
        memoryMB: null,
        pageUptimeSec: null,
        visibilityState: null,
        watchdogActive: false,
        lastWatchdogPingAt: null
      }
    });
    if (k.maintenance) {
      kioskState.get(k.id).status = 'MAINTENANCE';
    } else if (kioskState.get(k.id).status === 'MAINTENANCE') {
      kioskState.get(k.id).status = kioskState.get(k.id).lastHeartbeatAt ? 'ONLINE' : 'STANDBY';
    }
  }
  // Remove deleted kiosks
  for (const id of kioskState.keys()) {
    if (!validIds.has(id)) {
      kioskState.delete(id);
    }
  }
}

initKioskStates();

// Add an event to the incident log
function recordEvent(type, kioskId, message, details = {}) {
  const kiosk = kioskState.get(kioskId);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    type, // 'CRASH' | 'RECOVERY' | 'WARNING' | 'WATCHDOG' | 'EMAIL' | 'INFO'
    kioskId,
    kioskName: kiosk ? kiosk.name : kioskId,
    location: kiosk ? kiosk.location : '',
    message,
    details
  };
  eventLog.unshift(entry);
  if (eventLog.length > 200) {
    eventLog.length = 200;
  }
  saveEvents(eventLog);
  broadcastToDashboards({ type: 'event', event: entry });
  return entry;
}

// Send Email Alert via Nodemailer
async function sendCrashEmailAlert(kiosk, reason, isRecovery = false) {
  if (!config.smtp || !config.smtp.enabled) return;
  if (isRecovery && !config.smtp.alertOnRecovery) return;

  const now = Date.now();
  const cooldownMs = (config.smtp.cooldownSeconds || 300) * 1000;
  if (!isRecovery && kiosk.lastEmailAlertAt && (now - kiosk.lastEmailAlertAt) < cooldownMs) {
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: Number(config.smtp.port) || 587,
      secure: Boolean(config.smtp.secure),
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined
    });

    const subject = isRecovery
      ? `[RESOLVED] Kiosk Browser Recovered: ${kiosk.name} (${kiosk.id})`
      : `[ALERT] Kiosk Browser CRASHED: ${kiosk.name} (${kiosk.id})`;

    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <div style="background: ${isRecovery ? '#16a34a' : '#dc2626'}; color: #ffffff; padding: 16px 20px;">
          <h2 style="margin: 0; font-size: 18px;">${subject}</h2>
        </div>
        <div style="padding: 20px; color: #1e293b; line-height: 1.5;">
          <p><strong>Kiosk:</strong> ${kiosk.name} (<code>${kiosk.id}</code>)</p>
          <p><strong>Location:</strong> ${kiosk.location || 'N/A'}</p>
          <p><strong>Status:</strong> ${isRecovery ? 'ONLINE (Recovered)' : 'CRASHED / UNRESPONSIVE'}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p><strong>Last Heartbeat:</strong> ${kiosk.lastHeartbeatAt ? new Date(kiosk.lastHeartbeatAt).toLocaleString() : 'Never'}</p>
          <p><strong>Last Active URL:</strong> ${kiosk.metrics.url || 'N/A'}</p>
          <p><strong>IP Address:</strong> ${kiosk.metrics.ip || 'N/A'}</p>
          <p style="margin-top: 20px; font-size: 12px; color: #64748b;">Sent by kMonitor Kiosk Heartbeat Server at ${new Date().toLocaleString()}</p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: config.smtp.from || '"kMonitor Alert" <alerts@localhost>',
      to: config.smtp.to,
      subject,
      html
    });

    if (!isRecovery) {
      kiosk.lastEmailAlertAt = now;
    }
    recordEvent('EMAIL', kiosk.id, `Sent ${isRecovery ? 'recovery' : 'crash'} email alert to ${config.smtp.to}`);
  } catch (err) {
    console.error('SMTP Email Alert failed:', err.message);
    recordEvent('EMAIL', kiosk.id, `Failed to send email alert: ${err.message}`);
  }
}

// Process an incoming heartbeat from a kiosk
function processHeartbeat(kioskId, payload = {}, clientIp = null) {
  if (!kioskId) return null;

  let kiosk = kioskState.get(kioskId);
  if (!kiosk) {
    if (!config.autoRegisterUnknownKiosks) {
      return null;
    }
    // Auto-register unknown kiosk
    const newKioskCfg = {
      id: kioskId,
      name: payload.kioskName || kioskId,
      location: payload.location || 'Auto-Registered',
      expectedUrl: payload.url || '',
      maintenance: false
    };
    config.kiosks.push(newKioskCfg);
    saveConfig(config);
    initKioskStates();
    kiosk = kioskState.get(kioskId);
    recordEvent('INFO', kioskId, `Auto-registered new kiosk "${newKioskCfg.name}"`);
  }

  const now = Date.now();
  const prevStatus = kiosk.status;

  if (kiosk.lastHeartbeatAt) {
    kiosk.prevHeartbeatAt = kiosk.lastHeartbeatAt;
    kiosk.lastIntervalSec = Number(((now - kiosk.lastHeartbeatAt) / 1000).toFixed(1));
  }
  kiosk.lastHeartbeatAt = now;
  kiosk.beatInCurrentTick = true;

  // Also mark the latest history slot immediately so UI feels instantaneous
  if (kiosk.pulseHistory.length > 0) {
    kiosk.pulseHistory[kiosk.pulseHistory.length - 1] = {
      beat: true,
      status: kiosk.maintenance ? 'MAINTENANCE' : 'ONLINE'
    };
  }

  if (!kiosk.firstSeenAt) {
    kiosk.firstSeenAt = now;
  }
  kiosk.heartbeatCount += 1;

  // Update telemetry metrics
  if (payload.url !== undefined) kiosk.metrics.url = payload.url;
  if (payload.title !== undefined) kiosk.metrics.title = payload.title;
  if (clientIp) kiosk.metrics.ip = clientIp;
  if (payload.userAgent !== undefined) kiosk.metrics.userAgent = payload.userAgent;
  if (payload.viewport !== undefined) kiosk.metrics.viewport = payload.viewport;
  if (payload.memoryMB !== undefined) kiosk.metrics.memoryMB = payload.memoryMB;
  if (payload.pageUptimeSec !== undefined) kiosk.metrics.pageUptimeSec = payload.pageUptimeSec;
  if (payload.visibilityState !== undefined) kiosk.metrics.visibilityState = payload.visibilityState;

  if (!kiosk.maintenance) {
    kiosk.status = 'ONLINE';
    if (prevStatus === 'CRASHED') {
      const downtimeSec = kiosk.lastCrashAt ? Math.round((now - kiosk.lastCrashAt) / 1000) : 0;
      recordEvent('RECOVERY', kiosk.id, `Kiosk browser recovered after ${downtimeSec}s offline`, { downtimeSec });
      sendCrashEmailAlert(kiosk, `Heartbeat resumed after ${downtimeSec}s`, true);
    } else if (prevStatus === 'STANDBY') {
      recordEvent('INFO', kiosk.id, `Kiosk connected and started sending heartbeats`, {
        url: kiosk.metrics.url,
        ip: kiosk.metrics.ip
      });
    }
  }

  return kiosk;
}

// Express middleware
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get client IP
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// REST API: Receive heartbeat (supports both fetch JSON and navigator.sendBeacon text/plain)
app.post('/api/heartbeat', (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const kioskId = body.kioskId || req.query.kioskId;
  if (!kioskId) {
    return res.status(400).json({ error: 'Missing kioskId' });
  }

  const kiosk = processHeartbeat(kioskId, body, getClientIp(req));
  if (!kiosk) {
    return res.status(404).json({ error: `Unknown kioskId: ${kioskId}` });
  }

  broadcastStateUpdate();
  res.json({
    ok: true,
    kioskId: kiosk.id,
    status: kiosk.status,
    heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
    serverTime: new Date().toISOString()
  });
});

// REST API: Create / Add a new Kiosk
app.post('/api/kiosks', (req, res) => {
  const { id, name, location, expectedUrl, maintenance } = req.body || {};
  const cleanId = String(id || '').trim();
  const cleanName = String(name || '').trim();

  if (!cleanId || !cleanName) {
    return res.status(400).json({ ok: false, error: 'Kiosk ID and Display Name are required.' });
  }

  if (config.kiosks.some((k) => k.id.toLowerCase() === cleanId.toLowerCase())) {
    return res.status(409).json({ ok: false, error: `A kiosk with ID "${cleanId}" already exists.` });
  }

  const newKiosk = {
    id: cleanId,
    name: cleanName,
    location: String(location || '').trim(),
    expectedUrl: String(expectedUrl || '').trim(),
    maintenance: Boolean(maintenance)
  };

  config.kiosks.push(newKiosk);
  saveConfig(config);
  initKioskStates();
  recordEvent('INFO', cleanId, `Added new kiosk "${cleanName}" (${cleanId})`);
  broadcastStateUpdate();

  res.status(201).json({ ok: true, kiosk: kioskState.get(cleanId) });
});

// REST API: Update / Edit an existing Kiosk
app.put('/api/kiosks/:id', (req, res) => {
  const originalId = req.params.id;
  const idx = config.kiosks.findIndex((k) => k.id === originalId);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: `Kiosk "${originalId}" not found.` });
  }

  const { id, name, location, expectedUrl, maintenance } = req.body || {};
  const newId = String(id || originalId).trim();
  const newName = String(name || config.kiosks[idx].name).trim();

  if (!newId || !newName) {
    return res.status(400).json({ ok: false, error: 'Kiosk ID and Display Name are required.' });
  }

  if (newId !== originalId && config.kiosks.some((k) => k.id.toLowerCase() === newId.toLowerCase())) {
    return res.status(409).json({ ok: false, error: `Another kiosk with ID "${newId}" already exists.` });
  }

  // Preserve runtime state if ID is renamed
  const existingRuntime = kioskState.get(originalId);
  if (newId !== originalId && existingRuntime) {
    stopKioskSimulation(originalId);
    kioskState.delete(originalId);
    existingRuntime.id = newId;
    kioskState.set(newId, existingRuntime);
  }

  config.kiosks[idx] = {
    id: newId,
    name: newName,
    location: location !== undefined ? String(location).trim() : config.kiosks[idx].location,
    expectedUrl: expectedUrl !== undefined ? String(expectedUrl).trim() : config.kiosks[idx].expectedUrl,
    maintenance: maintenance !== undefined ? Boolean(maintenance) : Boolean(config.kiosks[idx].maintenance)
  };

  saveConfig(config);
  initKioskStates();
  recordEvent('INFO', newId, `Updated kiosk settings for "${newName}" (${newId})`);
  broadcastStateUpdate();

  res.json({ ok: true, kiosk: kioskState.get(newId) });
});

// REST API: Delete a Kiosk
app.delete('/api/kiosks/:id', (req, res) => {
  const targetId = req.params.id;
  const idx = config.kiosks.findIndex((k) => k.id === targetId);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: `Kiosk "${targetId}" not found.` });
  }

  const removed = config.kiosks[idx];
  stopKioskSimulation(targetId);
  config.kiosks.splice(idx, 1);
  kioskState.delete(targetId);
  saveConfig(config);
  recordEvent('INFO', targetId, `Deleted kiosk "${removed.name}" (${targetId})`);
  broadcastStateUpdate();

  res.json({ ok: true });
});

// REST API: Watchdog status check & event reporting (used by PowerShell auto-restart script on kiosk)
app.get('/api/kiosks/:id/watchdog', (req, res) => {
  const kiosk = kioskState.get(req.params.id);
  if (!kiosk) {
    return res.status(404).json({ error: 'Kiosk not found' });
  }
  const now = Date.now();
  kiosk.metrics.watchdogActive = true;
  kiosk.metrics.lastWatchdogPingAt = now;

  const ageSeconds = kiosk.lastHeartbeatAt
    ? Math.round((now - kiosk.lastHeartbeatAt) / 1000)
    : null;

  res.json({
    id: kiosk.id,
    name: kiosk.name,
    status: kiosk.status,
    maintenance: kiosk.maintenance,
    lastHeartbeatAgeSeconds: ageSeconds,
    crashTimeoutSeconds: config.crashTimeoutSeconds,
    expectedUrl: kiosk.expectedUrl,
    shouldRestartBrowser: !kiosk.maintenance && kiosk.status === 'CRASHED'
  });
});

app.post('/api/watchdog-event', (req, res) => {
  const { kioskId, event, message, details } = req.body || {};
  if (!kioskId) {
    return res.status(400).json({ error: 'Missing kioskId' });
  }
  const kiosk = kioskState.get(kioskId);
  if (kiosk) {
    kiosk.metrics.watchdogActive = true;
    kiosk.metrics.lastWatchdogPingAt = Date.now();
    if (event === 'PROCESS_CRASHED' && !kiosk.maintenance && kiosk.status !== 'CRASHED') {
      kiosk.status = 'CRASHED';
      kiosk.lastCrashAt = Date.now();
      kiosk.crashCount += 1;
      const reason = message || 'Watchdog detected browser process terminated unexpectedly';
      recordEvent('CRASH', kiosk.id, reason, details || {});
      sendCrashEmailAlert(kiosk, reason, false);
    } else {
      recordEvent('WATCHDOG', kiosk.id, message || `Watchdog event: ${event}`, details || {});
    }
    broadcastStateUpdate();
  }
  res.json({ ok: true });
});

// REST API: Full dashboard snapshot
app.get('/api/state', (req, res) => {
  res.json(getFullSnapshot());
});

// REST API: Reset / Acknowledge a crashed kiosk back to STANDBY or toggle maintenance
app.post('/api/kiosks/:id/action', (req, res) => {
  const kiosk = kioskState.get(req.params.id);
  if (!kiosk) {
    return res.status(404).json({ error: 'Kiosk not found' });
  }
  const { action } = req.body || {};

  if (action === 'acknowledge' || action === 'reset') {
    kiosk.status = kiosk.maintenance ? 'MAINTENANCE' : 'STANDBY';
    kiosk.lastHeartbeatAt = null;
    kiosk.prevHeartbeatAt = null;
    kiosk.lastIntervalSec = null;
    kiosk.pulseHistory = createInitialHistory();
    if (simulatorIntervals.has(kiosk.id)) {
      stopKioskSimulation(kiosk.id);
    }
    recordEvent('INFO', kiosk.id, 'Kiosk status manually reset to Standby');
  } else if (action === 'toggle_maintenance') {
    kiosk.maintenance = !kiosk.maintenance;
    const cfgKiosk = config.kiosks.find((k) => k.id === kiosk.id);
    if (cfgKiosk) {
      cfgKiosk.maintenance = kiosk.maintenance;
      saveConfig(config);
    }
    kiosk.status = kiosk.maintenance
      ? 'MAINTENANCE'
      : (kiosk.lastHeartbeatAt && (Date.now() - kiosk.lastHeartbeatAt) < config.crashTimeoutSeconds * 1000 ? 'ONLINE' : 'STANDBY');
    recordEvent('INFO', kiosk.id, `Maintenance mode ${kiosk.maintenance ? 'ENABLED' : 'DISABLED'}`);
  } else if (action === 'simulate_start') {
    startKioskSimulation(kiosk.id);
  } else if (action === 'simulate_crash') {
    simulateKioskCrash(kiosk.id);
  }

  broadcastStateUpdate();
  res.json({ ok: true, kiosk });
});

// REST API: Simulate all kiosks start / stop
app.post('/api/simulator', (req, res) => {
  const { action } = req.body || {};
  if (action === 'start_all') {
    for (const k of kioskState.values()) {
      if (!k.maintenance) startKioskSimulation(k.id);
    }
    recordEvent('INFO', 'SYSTEM', 'Started heartbeat simulator for all active kiosks');
  } else if (action === 'stop_all') {
    for (const id of simulatorIntervals.keys()) {
      stopKioskSimulation(id);
    }
    for (const k of kioskState.values()) {
      if (!k.maintenance) {
        k.status = 'STANDBY';
        k.lastHeartbeatAt = null;
        k.prevHeartbeatAt = null;
        k.lastIntervalSec = null;
        k.pulseHistory = createInitialHistory();
      }
    }
    recordEvent('INFO', 'SYSTEM', 'Stopped all simulated kiosks and reset to Standby');
  }
  broadcastStateUpdate();
  res.json({ ok: true });
});

// REST API: Update configuration
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  const incoming = req.body || {};
  if (incoming.heartbeatIntervalSeconds) {
    config.heartbeatIntervalSeconds = Math.max(1, Number(incoming.heartbeatIntervalSeconds));
  }
  if (incoming.warningThresholdSeconds) {
    config.warningThresholdSeconds = Math.max(2, Number(incoming.warningThresholdSeconds));
  }
  if (incoming.crashTimeoutSeconds) {
    config.crashTimeoutSeconds = Math.max(3, Number(incoming.crashTimeoutSeconds));
  }
  if (incoming.autoRegisterUnknownKiosks !== undefined) {
    config.autoRegisterUnknownKiosks = Boolean(incoming.autoRegisterUnknownKiosks);
  }
  if (incoming.smtp) {
    config.smtp = { ...config.smtp, ...incoming.smtp };
  }
  if (Array.isArray(incoming.kiosks)) {
    config.kiosks = incoming.kiosks;
  }

  saveConfig(config);
  initKioskStates();
  broadcastStateUpdate();
  recordEvent('INFO', 'SYSTEM', 'System configuration updated');
  res.json({ ok: true, config });
});

// REST API: Clear Event Log
app.delete('/api/events', (req, res) => {
  eventLog = [];
  saveEvents(eventLog);
  broadcastStateUpdate();
  res.json({ ok: true });
});

// REST API: Test SMTP Email
app.post('/api/test-email', async (req, res) => {
  const smtpCfg = req.body?.smtp || config.smtp;
  try {
    const transporter = nodemailer.createTransport({
      host: smtpCfg.host,
      port: Number(smtpCfg.port) || 587,
      secure: Boolean(smtpCfg.secure),
      auth: smtpCfg.user ? { user: smtpCfg.user, pass: smtpCfg.pass } : undefined
    });

    await transporter.sendMail({
      from: smtpCfg.from || '"kMonitor Alert" <alerts@localhost>',
      to: smtpCfg.to,
      subject: '[TEST] kMonitor Kiosk Crash Alert System',
      html: `
        <div style="font-family: system-ui, sans-serif; padding: 20px; border: 1px solid #cbd5e1; border-radius: 8px;">
          <h2 style="color: #0f172a; margin-top: 0;">kMonitor SMTP Test Successful</h2>
          <p>Your SMTP email settings are working properly. You will receive alerts at <strong>${smtpCfg.to}</strong> whenever any of your kiosks stop sending heartbeats.</p>
          <p style="font-size: 12px; color: #64748b;">Timestamp: ${new Date().toLocaleString()}</p>
        </div>
      `
    });
    recordEvent('EMAIL', 'SYSTEM', `Test email sent successfully to ${smtpCfg.to}`);
    res.json({ ok: true, message: `Test email sent to ${smtpCfg.to}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Built-in Kiosk Simulator for testing crash detection without physical kiosks
const simulatorIntervals = new Map();

function startKioskSimulation(kioskId) {
  stopKioskSimulation(kioskId);
  const kiosk = kioskState.get(kioskId);
  if (!kiosk) return;

  kiosk.simulated = true;
  const startTime = Date.now();

  const sendSimBeat = () => {
    const k = kioskState.get(kioskId);
    if (!k || k.maintenance) return;
    processHeartbeat(
      kioskId,
      {
        url: k.expectedUrl || `http://kiosk-app.local/station?id=${kioskId}`,
        title: `${k.name} - Interactive Portal`,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36 (Simulated Kiosk)',
        viewport: '1920x1080',
        memoryMB: Math.round(140 + Math.sin(Date.now() / 10000) * 15),
        pageUptimeSec: Math.round((Date.now() - startTime) / 1000),
        visibilityState: 'visible'
      },
      '127.0.0.1 (Sim)'
    );
    broadcastStateUpdate();
  };

  sendSimBeat();
  const timer = setInterval(sendSimBeat, Math.max(1000, config.heartbeatIntervalSeconds * 1000));
  simulatorIntervals.set(kioskId, timer);
}

function stopKioskSimulation(kioskId) {
  const timer = simulatorIntervals.get(kioskId);
  if (timer) {
    clearInterval(timer);
    simulatorIntervals.delete(kioskId);
  }
  const kiosk = kioskState.get(kioskId);
  if (kiosk) {
    kiosk.simulated = false;
  }
}

function simulateKioskCrash(kioskId) {
  stopKioskSimulation(kioskId);
  const kiosk = kioskState.get(kioskId);
  if (!kiosk) return;
  if (!kiosk.lastHeartbeatAt) {
    kiosk.lastHeartbeatAt = Date.now() - (config.crashTimeoutSeconds * 1000);
  }
  recordEvent('WARNING', kiosk.id, `Simulated browser freeze/crash initiated on ${kiosk.name} (heartbeats stopped)`);
}

// WebSocket Server for real-time dashboard updates + live kiosk connections
const wss = new WebSocketServer({ server, path: '/ws' });
const dashboardClients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const role = url.searchParams.get('role') || 'dashboard';
  const kioskId = url.searchParams.get('kioskId');

  if (role === 'kiosk' && kioskId) {
    const clientIp = req.socket.remoteAddress;
    const kiosk = kioskState.get(kioskId);
    if (kiosk) {
      kiosk.wsConnected = true;
      broadcastStateUpdate();
    }

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'heartbeat') {
          processHeartbeat(kioskId, data, clientIp);
          broadcastStateUpdate();
          ws.send(JSON.stringify({
            type: 'ack',
            serverTime: Date.now(),
            heartbeatIntervalSeconds: config.heartbeatIntervalSeconds
          }));
        } else if (data.type === 'unload') {
          recordEvent('INFO', kioskId, `Browser page unloaded (${data.reason || 'navigation'})`);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      const k = kioskState.get(kioskId);
      if (k) {
        k.wsConnected = false;
        broadcastStateUpdate();
      }
    });
  } else {
    // Dashboard client
    dashboardClients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', data: getFullSnapshot() }));

    ws.on('close', () => {
      dashboardClients.delete(ws);
    });
  }
});

function getFullSnapshot() {
  const now = Date.now();
  const kiosks = Array.from(kioskState.values()).map((k) => {
    const ageSeconds = k.lastHeartbeatAt ? Math.max(0, Math.round((now - k.lastHeartbeatAt) / 1000)) : null;
    return {
      ...k,
      lastHeartbeatAgeSeconds: ageSeconds
    };
  });

  const summary = {
    total: kiosks.length,
    online: kiosks.filter((k) => k.status === 'ONLINE').length,
    warning: kiosks.filter((k) => k.status === 'WARNING').length,
    crashed: kiosks.filter((k) => k.status === 'CRASHED').length,
    standby: kiosks.filter((k) => k.status === 'STANDBY').length,
    maintenance: kiosks.filter((k) => k.status === 'MAINTENANCE').length
  };

  return {
    serverTime: new Date(now).toISOString(),
    config: {
      heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
      warningThresholdSeconds: config.warningThresholdSeconds,
      crashTimeoutSeconds: config.crashTimeoutSeconds,
      autoRegisterUnknownKiosks: config.autoRegisterUnknownKiosks,
      smtp: {
        ...config.smtp,
        pass: config.smtp.pass ? '••••••••' : ''
      },
      kiosks: config.kiosks
    },
    summary,
    kiosks,
    events: eventLog.slice(0, 60)
  };
}

function broadcastToDashboards(payload) {
  const msg = JSON.stringify(payload);
  for (const client of dashboardClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

function broadcastStateUpdate() {
  broadcastToDashboards({ type: 'snapshot', data: getFullSnapshot() });
}

// Periodic Monitor Loop (runs every 1 second to evaluate heartbeat ages and advance the ECG graph history)
setInterval(() => {
  const now = Date.now();
  const warnMs = config.warningThresholdSeconds * 1000;
  const crashMs = config.crashTimeoutSeconds * 1000;
  let stateChanged = false;

  for (const kiosk of kioskState.values()) {
    if (kiosk.maintenance) {
      if (kiosk.status !== 'MAINTENANCE') {
        kiosk.status = 'MAINTENANCE';
        stateChanged = true;
      }
    } else if (kiosk.lastHeartbeatAt) {
      const elapsed = now - kiosk.lastHeartbeatAt;

      if (elapsed >= crashMs) {
        if (kiosk.status !== 'CRASHED') {
          kiosk.status = 'CRASHED';
          kiosk.lastCrashAt = now;
          kiosk.crashCount += 1;
          stateChanged = true;

          const secs = Math.round(elapsed / 1000);
          const reason = `No heartbeat received for ${secs}s (threshold: ${config.crashTimeoutSeconds}s)`;
          recordEvent('CRASH', kiosk.id, reason, { elapsedSeconds: secs, lastUrl: kiosk.metrics.url });
          sendCrashEmailAlert(kiosk, reason, false);
        }
      } else if (elapsed >= warnMs) {
        if (kiosk.status === 'ONLINE') {
          kiosk.status = 'WARNING';
          stateChanged = true;
        }
      } else {
        if (kiosk.status !== 'ONLINE') {
          kiosk.status = 'ONLINE';
          stateChanged = true;
        }
      }
    }

    // Push 1-second slot into rolling ECG pulseHistory
    kiosk.pulseHistory.push({
      beat: Boolean(kiosk.beatInCurrentTick),
      status: kiosk.status
    });
    if (kiosk.pulseHistory.length > HISTORY_LENGTH) {
      kiosk.pulseHistory.shift();
    }
    kiosk.beatInCurrentTick = false;
  }

  if (dashboardClients.size > 0 || stateChanged) {
    broadcastStateUpdate();
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`=====================================================`);
  console.log(`  kMonitor - Kiosk Browser Heartbeat Monitor`);
  console.log(`  Dashboard:       http://localhost:${PORT}`);
  console.log(`  Demo Kiosk Page: http://localhost:${PORT}/demo-kiosk.html?kioskId=kiosk-01`);
  console.log(`  Embed Script:    http://localhost:${PORT}/kiosk-heartbeat.js`);
  console.log(`=====================================================`);
});
