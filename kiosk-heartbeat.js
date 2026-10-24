/**
 * kMonitor - Embedded Kiosk Browser Heartbeat Agent (ColdFusion 2025 & IIS Ready)
 *
 * Usage (Option 1 - Script Tag Attributes):
 *   <script src="http://YOUR_SERVER/kMonitor/kiosk-heartbeat.js"
 *           data-kiosk-id="kiosk-01"
 *           data-kiosk-name="Lobby Kiosk 1"
 *           data-show-indicator="true"></script>
 *
 * Usage (Option 2 - URL Query Parameter on first load, persisted in localStorage):
 *   https://your-kiosk-app.local/?kioskId=kiosk-01
 */
(function () {
  'use strict';

  if (window.KMonitor && window.KMonitor._initialized) {
    return;
  }

  const currentScript = document.currentScript || (function () {
    const scripts = document.querySelectorAll('script[src*="kiosk-heartbeat"]');
    return scripts[scripts.length - 1] || null;
  })();

  // Determine Monitor Server Base Directory URL from the script src or window.KMonitorConfig
  function resolveServerBaseUrl() {
    if (window.KMonitorConfig && window.KMonitorConfig.serverUrl) {
      return window.KMonitorConfig.serverUrl.replace(/\/+$/, '');
    }
    if (currentScript && currentScript.dataset && currentScript.dataset.serverUrl) {
      return currentScript.dataset.serverUrl.replace(/\/+$/, '');
    }
    if (currentScript && currentScript.src) {
      try {
        const url = new URL(currentScript.src, window.location.href);
        const dirPath = url.pathname.replace(/\/[^/]*$/, '');
        return `${url.origin}${dirPath}`.replace(/\/+$/, '');
      } catch {
        // Fallback to current directory
      }
    }
    const locDir = window.location.pathname.replace(/\/[^/]*$/, '');
    return `${window.location.origin}${locDir}`.replace(/\/+$/, '');
  }

  // Determine Kiosk ID from URL ?kioskId=..., script data-kiosk-id, window.KMonitorConfig, or localStorage
  function resolveKioskId() {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('kioskId') || params.get('kiosk_id');
      if (fromUrl) {
        try { localStorage.setItem('kMonitor_kioskId', fromUrl); } catch {}
        return fromUrl;
      }
    } catch {}

    if (window.KMonitorConfig && window.KMonitorConfig.kioskId) {
      return window.KMonitorConfig.kioskId;
    }

    if (currentScript && currentScript.dataset && currentScript.dataset.kioskId) {
      return currentScript.dataset.kioskId;
    }

    try {
      const saved = localStorage.getItem('kMonitor_kioskId');
      if (saved) return saved;
    } catch {}

    return 'kiosk-01';
  }

  const serverBaseUrl = resolveServerBaseUrl();
  let kioskId = resolveKioskId();
  const kioskName = (window.KMonitorConfig && window.KMonitorConfig.kioskName) ||
    (currentScript && currentScript.dataset && currentScript.dataset.kioskName) ||
    undefined;
  const showIndicator = (window.KMonitorConfig && window.KMonitorConfig.showIndicator) ||
    (currentScript && currentScript.dataset && currentScript.dataset.showIndicator === 'true');

  let intervalSec = Number(
    (window.KMonitorConfig && window.KMonitorConfig.intervalSeconds) ||
    (currentScript && currentScript.dataset && currentScript.dataset.interval) ||
    5
  );

  const pageLoadTime = Date.now();
  let timerId = null;
  let isPaused = false;
  let indicatorDot = null;

  function createIndicator() {
    if (!showIndicator || indicatorDot || !document.body) return;
    indicatorDot = document.createElement('div');
    indicatorDot.id = 'kmonitor-heartbeat-indicator';
    indicatorDot.title = `kMonitor Active (${kioskId})`;
    Object.assign(indicatorDot.style, {
      position: 'fixed',
      bottom: '8px',
      right: '8px',
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      backgroundColor: '#22c55e',
      boxShadow: '0 0 6px rgba(34, 197, 94, 0.8)',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transition: 'transform 0.2s ease, background-color 0.3s ease'
    });
    document.body.appendChild(indicatorDot);
  }

  function pulseIndicator(ok) {
    if (!indicatorDot) createIndicator();
    if (!indicatorDot) return;
    indicatorDot.style.backgroundColor = ok ? '#22c55e' : '#ef4444';
    indicatorDot.style.transform = 'scale(1.35)';
    setTimeout(() => {
      if (indicatorDot) indicatorDot.style.transform = 'scale(1)';
    }, 200);
  }

  function collectPayload() {
    let memoryMB = null;
    if (window.performance && window.performance.memory && window.performance.memory.usedJSHeapSize) {
      memoryMB = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
    }
    return {
      type: 'heartbeat',
      kioskId,
      kioskName,
      url: window.location.href,
      title: document.title || window.location.pathname,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      memoryMB,
      pageUptimeSec: Math.round((Date.now() - pageLoadTime) / 1000),
      visibilityState: document.visibilityState || 'visible',
      clientTime: new Date().toISOString()
    };
  }

  async function sendHeartbeat() {
    if (isPaused) return;
    const payload = collectPayload();

    try {
      const res = await fetch(`${serverBaseUrl}/api.cfm?action=heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      });
      if (res.ok) {
        const data = await res.json();
        pulseIndicator(true);
        if (data.heartbeatIntervalSeconds && Number(data.heartbeatIntervalSeconds) !== intervalSec) {
          intervalSec = Number(data.heartbeatIntervalSeconds);
          restartInterval();
        }
      } else {
        pulseIndicator(false);
      }
    } catch {
      pulseIndicator(false);
    }
  }

  function restartInterval() {
    if (timerId) clearInterval(timerId);
    if (!isPaused) {
      timerId = setInterval(sendHeartbeat, Math.max(1000, intervalSec * 1000));
    }
  }

  function start() {
    isPaused = false;
    createIndicator();
    sendHeartbeat();
    restartInterval();
  }

  function stop() {
    isPaused = true;
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    if (indicatorDot) {
      indicatorDot.style.backgroundColor = '#ef4444';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.KMonitor = {
    _initialized: true,
    getKioskId: () => kioskId,
    setKioskId: (newId) => {
      kioskId = newId;
      try { localStorage.setItem('kMonitor_kioskId', newId); } catch {}
      stop();
      start();
    },
    sendHeartbeat,
    start,
    stop,
    isPaused: () => isPaused
  };
})();

