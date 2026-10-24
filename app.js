(function () {
  'use strict';

  let currentSnapshot = null;
  let audioEnabled = true;
  let alarmSilenced = false;
  let previouslyCrashedIds = new Set();
  let audioCtx = null;
  let viewMode = localStorage.getItem('kMonitor_viewMode') === 'list' ? 'list' : 'grid';

  function getAppBaseUrl() {
    const dirPath = window.location.pathname.replace(/\/[^/]*$/, '');
    return `${window.location.origin}${dirPath}`.replace(/\/+$/, '');
  }

  // Sync Bootstrap 5.3 data-bs-theme with system prefers-color-scheme and listen for runtime changes
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyBootstrapTheme(isDark) {
    document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
  }
  applyBootstrapTheme(darkQuery.matches);
  darkQuery.addEventListener('change', (e) => applyBootstrapTheme(e.matches));

  // DOM References
  const wsStatusEl = document.getElementById('ws-status');
  const wsStatusText = document.getElementById('ws-status-text');
  const crashBanner = document.getElementById('crash-banner');
  const crashBannerText = document.getElementById('crash-banner-text');
  const btnSilenceAlarm = document.getElementById('btn-silence-alarm');
  const btnAudioToggle = document.getElementById('btn-audio-toggle');
  const audioToggleIcon = document.getElementById('audio-toggle-icon');
  const audioToggleLabel = document.getElementById('audio-toggle-label');

  const sumTotal = document.getElementById('sum-total');
  const sumOnline = document.getElementById('sum-online');
  const sumWarning = document.getElementById('sum-warning');
  const sumCrashed = document.getElementById('sum-crashed');
  const sumStandby = document.getElementById('sum-standby');

  const filterInput = document.getElementById('filter-input');
  const statusFilter = document.getElementById('status-filter');
  const btnViewGrid = document.getElementById('btn-view-grid');
  const btnViewList = document.getElementById('btn-view-list');
  const kiosksSection = document.getElementById('kiosks-section');
  const kioskGrid = document.getElementById('kiosk-grid');
  const kioskListWrapper = document.getElementById('kiosk-list-wrapper');
  const kioskListTbody = document.getElementById('kiosk-list-tbody');
  const eventList = document.getElementById('event-list');

  const btnSimStartAll = document.getElementById('btn-sim-start-all');
  const btnSimStopAll = document.getElementById('btn-sim-stop-all');
  const btnClearEvents = document.getElementById('btn-clear-events');

  // Dialogs
  const kioskModal = document.getElementById('kiosk-modal');
  const setupDialog = document.getElementById('setup-dialog');
  const settingsDialog = document.getElementById('settings-dialog');

  const btnAddKiosk = document.getElementById('btn-add-kiosk');
  const btnOpenSetup = document.getElementById('btn-open-setup');
  const btnCloseSetup = document.getElementById('btn-close-setup');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');

  // Add/Edit Kiosk Modal Controls
  const kioskForm = document.getElementById('kiosk-form');
  const kioskModalTitleText = document.getElementById('kiosk-modal-title-text');
  const kioskOriginalId = document.getElementById('kiosk-original-id');
  const kioskFieldId = document.getElementById('kiosk-field-id');
  const kioskFieldName = document.getElementById('kiosk-field-name');
  const kioskFieldLocation = document.getElementById('kiosk-field-location');
  const kioskFieldUrl = document.getElementById('kiosk-field-url');
  const kioskFieldMaint = document.getElementById('kiosk-field-maint');
  const kioskOpenSetupWrap = document.getElementById('kiosk-open-setup-wrap');
  const kioskOpenSetupAfter = document.getElementById('kiosk-open-setup-after');
  const kioskFormError = document.getElementById('kiosk-form-error');
  const btnCloseKioskModal = document.getElementById('btn-close-kiosk-modal');
  const btnCancelKioskModal = document.getElementById('btn-cancel-kiosk-modal');
  const btnDeleteKioskModal = document.getElementById('btn-delete-kiosk-modal');
  const btnSaveKioskModal = document.getElementById('btn-save-kiosk-modal');
  const btnSaveKioskLabel = document.getElementById('btn-save-kiosk-label');

  // Setup Dialog Controls
  const snippetKioskSelect = document.getElementById('snippet-kiosk-select');
  const snippetIntervalLabel = document.getElementById('snippet-interval-label');
  const embedCodeBlock = document.getElementById('embed-code-block');
  const watchdogCodeBlock = document.getElementById('watchdog-code-block');
  const btnCopyEmbed = document.getElementById('btn-copy-embed');
  const copyEmbedLabel = document.getElementById('copy-embed-label');
  const btnCopyWatchdog = document.getElementById('btn-copy-watchdog');
  const copyWatchdogLabel = document.getElementById('copy-watchdog-label');
  const btnLaunchDemoKiosk = document.getElementById('btn-launch-demo-kiosk');
  const btnEditFromSetup = document.getElementById('btn-edit-from-setup');

  // Light-dismiss fallback for browsers without native <dialog closedby="any"> support
  function attachDialogLightDismissFallback(dialog) {
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent = (
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        );
        if (isDialogContent) return;
        dialog.close();
      });
    }
  }

  attachDialogLightDismissFallback(kioskModal);
  attachDialogLightDismissFallback(setupDialog);
  attachDialogLightDismissFallback(settingsDialog);

  // View Mode Switcher (Cards vs LED List)
  function applyViewMode(mode) {
    viewMode = mode === 'list' ? 'list' : 'grid';
    try { localStorage.setItem('kMonitor_viewMode', viewMode); } catch {}

    const isList = viewMode === 'list';
    kioskGrid.hidden = isList;
    kioskListWrapper.hidden = !isList;

    btnViewGrid.classList.toggle('active', !isList);
    btnViewGrid.setAttribute('aria-pressed', String(!isList));
    btnViewList.classList.toggle('active', isList);
    btnViewList.setAttribute('aria-pressed', String(isList));

    if (currentSnapshot) {
      renderKioskStations(currentSnapshot.kiosks, currentSnapshot.config);
    }
  }

  btnViewGrid.addEventListener('click', () => applyViewMode('grid'));
  btnViewList.addEventListener('click', () => applyViewMode('list'));
  applyViewMode(viewMode);

  // Web Audio API Synthesized Alert Chime
  function playCrashAlertSound() {
    if (!audioEnabled || alarmSilenced) return;
    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) audioCtx = new AudioContextClass();
      }
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const now = audioCtx.currentTime;
      const playTone = (freq, startOffset, duration) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now + startOffset);
        gain.gain.setValueAtTime(0.12, now + startOffset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + duration);
      };

      playTone(880, 0, 0.18);
      playTone(660, 0.2, 0.25);
    } catch {
      // Ignore audio autoplay restrictions until user interacts
    }
  }

  function triggerBrowserNotification(kiosk) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(`ALERT: ${kiosk.name} Crashed!`, {
        body: `${kiosk.name} (${kiosk.location || kiosk.id}) stopped sending browser heartbeats.`
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  }

  btnAudioToggle.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    btnAudioToggle.setAttribute('aria-pressed', String(audioEnabled));
    audioToggleIcon.className = audioEnabled ? 'bi bi-volume-up-fill' : 'bi bi-volume-mute-fill';
    audioToggleLabel.textContent = `Sound: ${audioEnabled ? 'ON' : 'OFF'}`;
    if (audioEnabled && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  });

  btnSilenceAlarm.addEventListener('click', () => {
    alarmSilenced = true;
    crashBanner.hidden = true;
  });

  // Escape HTML helper
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Format relative seconds
  function formatSecondsAgo(sec) {
    if (sec === null || sec === undefined || sec === '') return 'Never';
    const num = Number(sec);
    if (isNaN(num)) return 'Never';
    if (num < 60) return `${num}s ago`;
    const mins = Math.floor(num / 60);
    const rem = num % 60;
    if (mins < 60) return `${mins}m ${rem}s ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m ago`;
  }

  // Compute ECG Path & Telemetry Readout for Card Graph
  function computeEcgData(kiosk, config, width, height, baselineY, flatlineY, peakY) {
    const history = Array.isArray(kiosk.pulseHistory) && kiosk.pulseHistory.length > 0
      ? kiosk.pulseHistory
      : Array.from({ length: 36 }, () => ({ beat: false, status: kiosk.status }));

    const count = history.length;
    const stepX = width / Math.max(1, count - 1);

    let graphColor = '#64748b';
    let readoutText = 'STANDBY';
    let shortReadout = 'Standby';
    let iconClass = 'bi-heart';

    const intervalCfg = (config && config.heartbeatIntervalSeconds) || 5;
    const nominalBpm = Math.round(60 / intervalCfg);

    if (kiosk.status === 'ONLINE') {
      graphColor = '#22c55e';
      iconClass = 'bi-heart-pulse-fill';
      const pulseInterval = kiosk.lastIntervalSec || intervalCfg;
      const bpm = pulseInterval > 0 ? Math.min(120, Math.round(60 / pulseInterval)) : nominalBpm;
      readoutText = `${bpm} BPM • ${pulseInterval}s pulse`;
      shortReadout = `${bpm} BPM (${pulseInterval}s)`;
    } else if (kiosk.status === 'WARNING') {
      graphColor = '#f59e0b';
      iconClass = 'bi-exclamation-triangle-fill';
      readoutText = `LATE PULSE (${kiosk.lastHeartbeatAgeSeconds || 0}s ago)`;
      shortReadout = `Late (${kiosk.lastHeartbeatAgeSeconds || 0}s)`;
    } else if (kiosk.status === 'CRASHED') {
      graphColor = '#ef4444';
      iconClass = 'bi-heartbreak-fill';
      readoutText = `0 BPM • FLATLINE (${kiosk.lastHeartbeatAgeSeconds || 0}s)`;
      shortReadout = `FLATLINE (${kiosk.lastHeartbeatAgeSeconds || 0}s)`;
    } else if (kiosk.status === 'MAINTENANCE') {
      graphColor = '#8b5cf6';
      iconClass = 'bi-tools';
      readoutText = 'MAINTENANCE (Alerts Muted)';
      shortReadout = 'Maint';
    }

    const pathSegments = [];
    let lastX = 0;
    let lastY = kiosk.status === 'CRASHED' ? flatlineY : baselineY;

    for (let i = 0; i < count; i++) {
      const slot = history[i];
      const x = Number((i * stepX).toFixed(1));
      const yBase = slot.status === 'CRASHED' ? flatlineY : baselineY;

      if (i === 0) {
        pathSegments.push(`M ${x} ${yBase}`);
        lastX = x;
        lastY = yBase;
        continue;
      }

      if (slot.beat) {
        const pWaveX = (x - stepX * 0.65).toFixed(1);
        const qDipX = (x - stepX * 0.35).toFixed(1);
        const rPeakX = (x - stepX * 0.1).toFixed(1);
        const sDipX = (x + stepX * 0.15).toFixed(1);
        const tWaveX = (x + stepX * 0.42).toFixed(1);

        pathSegments.push(
          `L ${pWaveX} ${yBase - 3}`,
          `L ${qDipX} ${yBase + 4}`,
          `L ${rPeakX} ${peakY}`,
          `L ${sDipX} ${yBase + 8}`,
          `L ${tWaveX} ${yBase - 4}`,
          `L ${x} ${yBase}`
        );
        lastX = x;
        lastY = yBase;
      } else {
        pathSegments.push(`L ${x} ${yBase}`);
        lastX = x;
        lastY = yBase;
      }
    }

    return {
      d: pathSegments.join(' '),
      lastX,
      lastY,
      graphColor,
      readoutText,
      shortReadout,
      iconClass
    };
  }

  // Build SVG ECG Waveform Graph for Card View
  function buildHeartbeatGraphSvg(kiosk, config) {
    const width = 300;
    const height = 50;
    const baselineY = 33;
    const flatlineY = 41;
    const ecg = computeEcgData(kiosk, config, width, height, baselineY, flatlineY, 7);

    const ageLabel = kiosk.lastHeartbeatAt
      ? `Last: ${formatSecondsAgo(kiosk.lastHeartbeatAgeSeconds)}`
      : 'No beats yet';

    return `
      <div class="heartbeat-graph-box" style="--graph-color: ${ecg.graphColor};">
        <div class="heartbeat-graph-header">
          <span class="pulse-rate-readout">
            <i class="bi ${ecg.iconClass} pulse-heart-icon" aria-hidden="true"></i>
            <span>${escapeHtml(ecg.readoutText)}</span>
          </span>
          <span>${escapeHtml(ageLabel)}</span>
        </div>
        <svg class="heartbeat-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
          <line class="ecg-grid-line" x1="0" y1="12" x2="${width}" y2="12"></line>
          <line class="ecg-grid-line" x1="0" y1="25" x2="${width}" y2="25"></line>
          <line class="ecg-grid-line" x1="0" y1="38" x2="${width}" y2="38"></line>
          <line class="ecg-grid-line" x1="75" y1="0" x2="75" y2="${height}"></line>
          <line class="ecg-grid-line" x1="150" y1="0" x2="150" y2="${height}"></line>
          <line class="ecg-grid-line" x1="225" y1="0" x2="225" y2="${height}"></line>
          <line class="ecg-baseline-guide" x1="0" y1="${baselineY}" x2="${width}" y2="${baselineY}"></line>
          <path class="ecg-wave-glow" d="${ecg.d}"></path>
          <path class="ecg-wave-line" d="${ecg.d}"></path>
          <circle class="ecg-head-dot" cx="${ecg.lastX}" cy="${ecg.lastY}" r="3.5"></circle>
        </svg>
      </div>
    `;
  }

  // Build Action Buttons for both Card and List Row
  function buildActionButtonsHtml(k) {
    const safeName = escapeHtml(k.name);
    const safeId = escapeHtml(k.id);

    let primaryActionButtons = '';
    if (k.status === 'CRASHED') {
      primaryActionButtons = `
        <div class="btn-group btn-group-sm" role="group" aria-label="Recovery actions for ${safeName}">
          <button type="button" class="btn btn-success icon-btn" data-action="simulate_start" data-id="${safeId}" title="Recover / Simulate Heartbeat">
            <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
            <span>Recover</span>
            <span class="visually-hidden"> ${safeName}</span>
          </button>
          <button type="button" class="btn btn-outline-secondary icon-btn" data-action="reset" data-id="${safeId}" title="Acknowledge &amp; Reset to Standby">
            <i class="bi bi-check2" aria-hidden="true"></i>
            <span class="visually-hidden">Acknowledge ${safeName}</span>
          </button>
        </div>
      `;
    } else if (k.status === 'ONLINE' || k.status === 'WARNING') {
      primaryActionButtons = `
        <button type="button" class="btn btn-sm btn-outline-danger icon-btn" data-action="simulate_crash" data-id="${safeId}" title="Simulate Browser Crash">
          <i class="bi bi-lightning-charge-fill" aria-hidden="true"></i>
          <span>Crash</span>
          <span class="visually-hidden"> ${safeName}</span>
        </button>
      `;
    } else if (k.status === 'STANDBY') {
      primaryActionButtons = `
        <button type="button" class="btn btn-sm btn-outline-primary icon-btn" data-action="simulate_start" data-id="${safeId}" title="Start Simulated Heartbeats">
          <i class="bi bi-play-fill" aria-hidden="true"></i>
          <span>Sim Beat</span>
          <span class="visually-hidden"> for ${safeName}</span>
        </button>
      `;
    } else {
      primaryActionButtons = `
        <button type="button" class="btn btn-sm btn-outline-secondary icon-btn" data-action="toggle_maintenance" data-id="${safeId}" title="Exit Maintenance Mode">
          <i class="bi bi-play-circle" aria-hidden="true"></i>
          <span>Resume</span>
          <span class="visually-hidden"> ${safeName}</span>
        </button>
      `;
    }

    const maintActiveClass = k.maintenance ? 'active btn-secondary' : 'btn-outline-secondary';

    const manageGroup = `
      <div class="btn-group btn-group-sm" role="group" aria-label="Manage ${safeName}">
        <button type="button" class="btn btn-outline-secondary icon-btn" data-action="open_setup" data-id="${safeId}" title="Embed &amp; Watchdog Setup">
          <i class="bi bi-code-slash" aria-hidden="true"></i>
          <span class="visually-hidden">Setup ${safeName}</span>
        </button>
        <button type="button" class="btn btn-outline-secondary icon-btn" data-action="edit_kiosk" data-id="${safeId}" title="Edit Kiosk Info">
          <i class="bi bi-pencil-square" aria-hidden="true"></i>
          <span class="visually-hidden">Edit ${safeName}</span>
        </button>
        <button type="button" class="btn ${maintActiveClass} icon-btn" data-action="toggle_maintenance" data-id="${safeId}" aria-pressed="${Boolean(k.maintenance)}" title="Toggle Maintenance Mode">
          <i class="bi bi-tools" aria-hidden="true"></i>
          <span class="visually-hidden">Toggle Maintenance for ${safeName}</span>
        </button>
        <button type="button" class="btn btn-outline-danger icon-btn" data-action="delete_kiosk" data-id="${safeId}" title="Delete Kiosk">
          <i class="bi bi-trash3" aria-hidden="true"></i>
          <span class="visually-hidden">Delete ${safeName}</span>
        </button>
      </div>
    `;

    return { primaryActionButtons, manageGroup };
  }

  // Render Dashboard State
  function renderDashboard(snapshot) {
    if (!snapshot || !snapshot.summary) return;
    currentSnapshot = snapshot;
    const { summary, kiosks, events, config } = snapshot;

    sumTotal.textContent = summary.total;
    sumOnline.textContent = summary.online;
    sumWarning.textContent = summary.warning;
    sumCrashed.textContent = summary.crashed;
    sumStandby.textContent = summary.standby + summary.maintenance;

    // Check for newly crashed kiosks to trigger sound/browser notification
    const currentCrashed = kiosks.filter((k) => k.status === 'CRASHED');
    const currentCrashedIds = new Set(currentCrashed.map((k) => k.id));

    for (const k of currentCrashed) {
      if (!previouslyCrashedIds.has(k.id)) {
        alarmSilenced = false;
        playCrashAlertSound();
        triggerBrowserNotification(k);
      }
    }
    previouslyCrashedIds = currentCrashedIds;

    if (currentCrashed.length > 0 && !alarmSilenced) {
      const names = currentCrashed.map((k) => `${k.name} (${k.id})`).join(', ');
      crashBannerText.textContent = `ALERT: ${currentCrashed.length} Kiosk Browser(s) Crashed / Unresponsive: ${names}`;
      crashBanner.hidden = false;
    } else if (currentCrashed.length === 0) {
      crashBanner.hidden = true;
      alarmSilenced = false;
    }

    renderKioskStations(kiosks, config);
    renderEventLog(events);
  }

  function getFilteredKiosks(kiosks) {
    const query = (filterInput.value || '').trim().toLowerCase();
    const statusVal = statusFilter.value;

    return kiosks.filter((k) => {
      if (statusVal !== 'ALL' && k.status !== statusVal) return false;
      if (!query) return true;
      return (
        k.id.toLowerCase().includes(query) ||
        k.name.toLowerCase().includes(query) ||
        (k.location || '').toLowerCase().includes(query)
      );
    });
  }

  function renderKioskStations(kiosks, config) {
    const filtered = getFilteredKiosks(kiosks);
    if (viewMode === 'list') {
      renderKioskList(filtered, config);
    } else {
      renderKioskCards(filtered, config);
    }
  }

  function renderKioskCards(filtered, config) {
    if (filtered.length === 0) {
      kioskGrid.innerHTML = `
        <li class="kiosk-card">
          <p class="mb-0 text-secondary">No kiosks match your filter. Click <strong>Add Kiosk</strong> to add a station.</p>
        </li>
      `;
      return;
    }

    kioskGrid.innerHTML = filtered.map((k) => {
      const channelBadge = k.simulated
        ? 'CF Simulated'
        : (k.lastHeartbeatAt ? 'HTTP Beacon' : 'Waiting');

      const memText = k.metrics && k.metrics.memoryMB ? `${k.metrics.memoryMB} MB` : '—';
      const viewportText = (k.metrics && k.metrics.viewport) || '—';
      const urlText = (k.metrics && k.metrics.url) || k.expectedUrl || '—';
      const safeName = escapeHtml(k.name);
      const safeId = escapeHtml(k.id);
      const safeStatus = escapeHtml(k.status);

      let statusIcon = 'bi-pause-circle';
      if (k.status === 'ONLINE') statusIcon = 'bi-check-circle-fill';
      else if (k.status === 'WARNING') statusIcon = 'bi-exclamation-triangle-fill';
      else if (k.status === 'CRASHED') statusIcon = 'bi-x-octagon-fill';
      else if (k.status === 'MAINTENANCE') statusIcon = 'bi-cone-striped';

      const { primaryActionButtons, manageGroup } = buildActionButtonsHtml(k);

      return `
        <li class="kiosk-card status-${safeStatus}">
          <div class="kiosk-header">
            <div>
              <h3 class="kiosk-title">
                <span class="led-light ${safeStatus}" aria-hidden="true" title="LED Status: ${safeStatus}"></span>
                <span>${safeName}</span>
              </h3>
              <p class="kiosk-sub">
                <code>${safeId}</code> &bull; <i class="bi bi-geo-alt" aria-hidden="true"></i> ${escapeHtml(k.location || 'Unassigned')}
              </p>
            </div>
            <span class="status-badge ${safeStatus}">
              <i class="bi ${statusIcon}" aria-hidden="true"></i>
              <span>${safeStatus}</span>
            </span>
          </div>

          ${buildHeartbeatGraphSvg(k, config)}

          <dl class="kiosk-metrics">
            <div>
              <dt><i class="bi bi-broadcast me-1" aria-hidden="true"></i>Channel / Beats</dt>
              <dd>${escapeHtml(channelBadge)} (${k.heartbeatCount})</dd>
            </div>
            <div>
              <dt><i class="bi bi-cpu me-1" aria-hidden="true"></i>Viewport / RAM</dt>
              <dd>${escapeHtml(viewportText)} &bull; ${escapeHtml(memText)}</dd>
            </div>
            <div>
              <dt><i class="bi bi-hdd-network me-1" aria-hidden="true"></i>IP Address</dt>
              <dd>${escapeHtml((k.metrics && k.metrics.ip) || '—')}</dd>
            </div>
            <div>
              <dt><i class="bi bi-exclamation-diamond me-1" aria-hidden="true"></i>Crashes Logged</dt>
              <dd>${k.crashCount}</dd>
            </div>
            <div class="full-row">
              <dt><i class="bi bi-link-45deg me-1" aria-hidden="true"></i>Target / Active URL</dt>
              <dd title="${escapeHtml(urlText)}">${escapeHtml(urlText)}</dd>
            </div>
          </dl>

          <div class="kiosk-actions">
            ${primaryActionButtons}
            ${manageGroup}
          </div>
        </li>
      `;
    }).join('');
  }

  function renderKioskList(filtered) {
    if (filtered.length === 0) {
      kioskListTbody.innerHTML = `
        <tr>
          <td colspan="5" class="text-secondary text-center py-4">No kiosks match your filter. Click <strong>Add Kiosk</strong> to add a station.</td>
        </tr>
      `;
      return;
    }

    kioskListTbody.innerHTML = filtered.map((k) => {
      const safeName = escapeHtml(k.name);
      const safeId = escapeHtml(k.id);
      const safeStatus = escapeHtml(k.status);
      const channelBadge = k.simulated
        ? 'CF Sim'
        : (k.lastHeartbeatAt ? 'HTTP' : 'Idle');
      const urlText = (k.metrics && k.metrics.url) || k.expectedUrl || '—';
      const memText = k.metrics && k.metrics.memoryMB ? `${k.metrics.memoryMB} MB` : '—';
      const viewportText = (k.metrics && k.metrics.viewport) || '—';

      let statusIcon = 'bi-pause-circle';
      if (k.status === 'ONLINE') statusIcon = 'bi-check-circle-fill';
      else if (k.status === 'WARNING') statusIcon = 'bi-exclamation-triangle-fill';
      else if (k.status === 'CRASHED') statusIcon = 'bi-x-octagon-fill';
      else if (k.status === 'MAINTENANCE') statusIcon = 'bi-cone-striped';

      const { primaryActionButtons, manageGroup } = buildActionButtonsHtml(k);

      return `
        <tr class="row-${safeStatus}">
          <th scope="row">
            <div class="d-flex align-items-center gap-2">
              <span class="led-light ${safeStatus}" aria-hidden="true" title="LED Status: ${safeStatus}"></span>
              <div>
                <div class="fw-bold">${safeName}</div>
                <div class="small text-secondary"><code>${safeId}</code></div>
              </div>
            </div>
          </th>
          <td class="text-nowrap">
            <span class="status-badge ${safeStatus}">
              <i class="bi ${statusIcon}" aria-hidden="true"></i>
              <span>${safeStatus}</span>
            </span>
          </td>
          <td class="text-nowrap">
            <div class="fw-semibold">${escapeHtml(formatSecondsAgo(k.lastHeartbeatAgeSeconds))}</div>
            <div class="small text-secondary">${escapeHtml(channelBadge)} &bull; ${k.heartbeatCount} beats &bull; ${k.crashCount} crashes</div>
          </td>
          <td class="url-cell">
            <div class="text-truncate fw-semibold" title="${escapeHtml(urlText)}">${escapeHtml(urlText)}</div>
            <div class="small text-secondary text-truncate">${escapeHtml(viewportText)} &bull; RAM: ${escapeHtml(memText)}</div>
          </td>
          <td class="text-end text-nowrap">
            <div class="d-inline-flex align-items-center gap-1 justify-content-end">
              ${primaryActionButtons}
              ${manageGroup}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function renderEventLog(events) {
    if (!events || events.length === 0) {
      eventList.innerHTML = `<li class="event-item INFO"><span class="log-ts">[--:--:--]</span> <span class="log-lvl">[IDLE]</span> <span class="log-msg">Waiting for incident or heartbeat events...</span></li>`;
      return;
    }

    eventList.innerHTML = events.map((ev) => {
      const d = new Date(ev.timestamp);
      const timeStr = isNaN(d.getTime()) ? String(ev.timestamp) : d.toTimeString().split(' ')[0];
      const lvl = String(ev.type || 'INFO').padEnd(8, ' ');
      const station = ev.kioskName && ev.kioskName !== ev.kioskId
        ? `${ev.kioskId} (${ev.kioskName})`
        : (ev.kioskId || 'SYSTEM');

      return `<li class="event-item ${escapeHtml(ev.type)}"><span class="log-ts">[${escapeHtml(timeStr)}]</span> <span class="log-lvl">[${escapeHtml(lvl)}]</span> <span class="log-kiosk">[${escapeHtml(station)}]</span> <span class="log-msg">${escapeHtml(ev.message)}</span></li>`;
    }).join('');
  }

  // Fetch and render state from ColdFusion
  async function refreshState() {
    try {
      const res = await fetch('api.cfm?action=state', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      wsStatusEl.classList.remove('disconnected');
      wsStatusText.textContent = 'CF Live Connected';
      renderDashboard(data);
    } catch {
      wsStatusEl.classList.add('disconnected');
      wsStatusText.textContent = 'Reconnecting...';
    }
  }

  // Suggest next available Kiosk ID (e.g., kiosk-09)
  function suggestNextKioskId() {
    const kiosks = currentSnapshot ? currentSnapshot.kiosks : [];
    let num = kiosks.length + 1;
    while (true) {
      const candidate = `kiosk-${String(num).padStart(2, '0')}`;
      if (!kiosks.some((k) => k.id.toLowerCase() === candidate.toLowerCase())) {
        return {
          id: candidate,
          name: `Kiosk ${String(num).padStart(2, '0')}`,
          zone: `Zone ${Math.ceil(num / 2)} - Station ${((num - 1) % 2) + 1}`
        };
      }
      num += 1;
    }
  }

  // Open Add or Edit Kiosk Modal
  function openKioskModal(existingKioskId = null) {
    kioskFormError.textContent = '';
    btnSaveKioskModal.disabled = false;
    const baseUrl = getAppBaseUrl();

    if (existingKioskId) {
      const kiosks = currentSnapshot ? currentSnapshot.kiosks : [];
      const k = kiosks.find((item) => item.id === existingKioskId);
      if (!k) return;

      kioskModalTitleText.textContent = `Edit Kiosk: ${k.name}`;
      kioskOriginalId.value = k.id;
      kioskFieldId.value = k.id;
      kioskFieldName.value = k.name;
      kioskFieldLocation.value = k.location || '';
      kioskFieldUrl.value = k.expectedUrl || '';
      kioskFieldMaint.checked = Boolean(k.maintenance);
      kioskOpenSetupWrap.style.display = 'none';
      kioskOpenSetupAfter.checked = false;
      btnDeleteKioskModal.hidden = false;
      btnSaveKioskLabel.textContent = 'Save Changes';
    } else {
      const next = suggestNextKioskId();
      kioskModalTitleText.textContent = 'Add & Setup New Kiosk';
      kioskOriginalId.value = '';
      kioskFieldId.value = next.id;
      kioskFieldName.value = next.name;
      kioskFieldLocation.value = next.zone;
      kioskFieldUrl.value = `${baseUrl}/demo-kiosk.cfm?kioskId=${next.id}`;
      kioskFieldMaint.checked = false;
      kioskOpenSetupWrap.style.display = 'block';
      kioskOpenSetupAfter.checked = true;
      btnDeleteKioskModal.hidden = true;
      btnSaveKioskLabel.textContent = 'Create Kiosk';
    }

    kioskModal.showModal();
  }

  // Clear error state on input per Modern Web Guidance
  kioskForm.addEventListener('input', () => {
    kioskFormError.textContent = '';
  });

  // Update default demo URL query param automatically when typing a new Kiosk ID in Add mode
  kioskFieldId.addEventListener('input', () => {
    if (!kioskOriginalId.value && kioskFieldUrl.value.includes('demo-kiosk')) {
      kioskFieldUrl.value = `${getAppBaseUrl()}/demo-kiosk.cfm?kioskId=${kioskFieldId.value.trim()}`;
    }
  });

  btnAddKiosk.addEventListener('click', () => openKioskModal(null));
  btnCloseKioskModal.addEventListener('click', () => kioskModal.close());
  btnCancelKioskModal.addEventListener('click', () => kioskModal.close());

  // Submit Add / Edit Kiosk Form
  kioskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    kioskFormError.textContent = '';

    const originalId = kioskOriginalId.value.trim();
    const payload = {
      originalId,
      id: kioskFieldId.value.trim(),
      name: kioskFieldName.value.trim(),
      location: kioskFieldLocation.value.trim(),
      expectedUrl: kioskFieldUrl.value.trim(),
      maintenance: kioskFieldMaint.checked
    };

    if (!payload.id || !payload.name) {
      kioskFormError.textContent = 'Kiosk Identifier and Display Name are required.';
      return;
    }

    btnSaveKioskModal.disabled = true;

    try {
      const isEdit = Boolean(originalId);
      const url = isEdit
        ? `api.cfm?action=kiosk_update&id=${encodeURIComponent(originalId)}`
        : 'api.cfm?action=kiosk_create';

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        kioskFormError.textContent = data.error || 'Could not save kiosk.';
        btnSaveKioskModal.disabled = false;
        return;
      }

      await refreshState();
      kioskModal.close();

      if (!isEdit && kioskOpenSetupAfter.checked) {
        openSetupDialog(payload.id);
      }
    } catch (err) {
      kioskFormError.textContent = `Network error: ${err.message}`;
      btnSaveKioskModal.disabled = false;
    }
  });

  // Delete Kiosk helper
  async function deleteKioskById(kioskId) {
    const kiosks = currentSnapshot ? currentSnapshot.kiosks : [];
    const target = kiosks.find((k) => k.id === kioskId);
    const label = target ? `${target.name} (${target.id})` : kioskId;

    if (!window.confirm(`Are you sure you want to delete kiosk "${label}"?`)) {
      return false;
    }

    const res = await fetch(`api.cfm?action=kiosk_delete&id=${encodeURIComponent(kioskId)}`, {
      method: 'POST'
    });
    await refreshState();
    return res.ok;
  }

  btnDeleteKioskModal.addEventListener('click', async () => {
    const originalId = kioskOriginalId.value.trim();
    if (!originalId) return;
    const deleted = await deleteKioskById(originalId);
    if (deleted) {
      kioskModal.close();
    }
  });

  // Event Delegation for Both Card Grid and LED List View Action Buttons
  kiosksSection.addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const kioskId = btn.dataset.id;

    if (action === 'open_setup') {
      openSetupDialog(kioskId);
      return;
    }
    if (action === 'edit_kiosk') {
      openKioskModal(kioskId);
      return;
    }
    if (action === 'delete_kiosk') {
      await deleteKioskById(kioskId);
      return;
    }

    await fetch(`api.cfm?action=kiosk_action&id=${encodeURIComponent(kioskId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    await refreshState();
  });

  filterInput.addEventListener('input', () => {
    if (currentSnapshot) renderKioskStations(currentSnapshot.kiosks, currentSnapshot.config);
  });

  statusFilter.addEventListener('change', () => {
    if (currentSnapshot) renderKioskStations(currentSnapshot.kiosks, currentSnapshot.config);
  });

  btnSimStartAll.addEventListener('click', async () => {
    await fetch('api.cfm?action=simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start_all' })
    });
    await refreshState();
  });

  btnSimStopAll.addEventListener('click', async () => {
    await fetch('api.cfm?action=simulator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop_all' })
    });
    await refreshState();
  });

  btnClearEvents.addEventListener('click', async () => {
    await fetch('api.cfm?action=events_clear', { method: 'POST' });
    await refreshState();
  });

  // Setup Dialog (Embed Snippet & Watchdog)
  function updateSetupSnippets(selectedId) {
    const baseUrl = getAppBaseUrl();
    const kiosks = currentSnapshot ? currentSnapshot.kiosks : [];
    const kiosk = kiosks.find((k) => k.id === selectedId) || {
      id: selectedId || 'kiosk-01',
      name: 'Kiosk 01',
      expectedUrl: `${baseUrl}/demo-kiosk.cfm?kioskId=${selectedId || 'kiosk-01'}`
    };

    if (currentSnapshot && currentSnapshot.config) {
      snippetIntervalLabel.textContent = currentSnapshot.config.heartbeatIntervalSeconds;
    }

    btnLaunchDemoKiosk.href = `demo-kiosk.cfm?kioskId=${encodeURIComponent(kiosk.id)}`;

    embedCodeBlock.textContent =
`<!-- Add before </body> in your kiosk web app -->
<script src="${baseUrl}/kiosk-heartbeat.js"
        data-kiosk-id="${kiosk.id}"
        data-kiosk-name="${kiosk.name}"
        data-show-indicator="true"></script>`;

    let targetUrl = kiosk.expectedUrl || `${baseUrl}/demo-kiosk.cfm?kioskId=${kiosk.id}`;
    if (!targetUrl.startsWith('http')) {
      targetUrl = `${baseUrl}/${targetUrl.replace(/^\/+/, '')}`;
    }
    watchdogCodeBlock.textContent =
`powershell.exe -ExecutionPolicy Bypass -File .\\Kiosk-Watchdog.ps1 \`
  -KioskId "${kiosk.id}" \`
  -MonitorServerUrl "${baseUrl}" \`
  -KioskAppUrl "${targetUrl}" \`
  -Browser "auto"`;
  }

  function openSetupDialog(preferredKioskId) {
    const kiosks = currentSnapshot ? currentSnapshot.kiosks : [];
    snippetKioskSelect.innerHTML = kiosks.map((k) =>
      `<option value="${escapeHtml(k.id)}">${escapeHtml(k.name)} (${escapeHtml(k.id)})</option>`
    ).join('');

    const targetId = preferredKioskId || (kiosks[0] && kiosks[0].id) || 'kiosk-01';
    snippetKioskSelect.value = targetId;
    updateSetupSnippets(targetId);
    setupDialog.showModal();
  }

  snippetKioskSelect.addEventListener('change', () => {
    updateSetupSnippets(snippetKioskSelect.value);
  });

  btnEditFromSetup.addEventListener('click', () => {
    const selectedId = snippetKioskSelect.value;
    setupDialog.close();
    openKioskModal(selectedId);
  });

  btnOpenSetup.addEventListener('click', () => openSetupDialog());
  btnCloseSetup.addEventListener('click', () => setupDialog.close());

  btnCopyEmbed.addEventListener('click', async () => {
    await navigator.clipboard.writeText(embedCodeBlock.textContent);
    copyEmbedLabel.textContent = 'Copied!';
    setTimeout(() => { copyEmbedLabel.textContent = 'Copy HTML Snippet'; }, 1500);
  });

  btnCopyWatchdog.addEventListener('click', async () => {
    await navigator.clipboard.writeText(watchdogCodeBlock.textContent);
    copyWatchdogLabel.textContent = 'Copied!';
    setTimeout(() => { copyWatchdogLabel.textContent = 'Copy PowerShell Command'; }, 1500);
  });

  // Settings Dialog & Bulk Kiosk Table
  const settingsForm = document.getElementById('settings-form');
  const cfgInterval = document.getElementById('cfg-interval');
  const cfgWarning = document.getElementById('cfg-warning');
  const cfgCrash = document.getElementById('cfg-crash');
  const smtpEnabled = document.getElementById('smtp-enabled');
  const smtpRecovery = document.getElementById('smtp-recovery');
  const smtpSecure = document.getElementById('smtp-secure');
  const smtpHost = document.getElementById('smtp-host');
  const smtpPort = document.getElementById('smtp-port');
  const smtpUser = document.getElementById('smtp-user');
  const smtpPass = document.getElementById('smtp-pass');
  const smtpFrom = document.getElementById('smtp-from');
  const smtpTo = document.getElementById('smtp-to');
  const btnTestEmail = document.getElementById('btn-test-email');
  const testEmailResult = document.getElementById('test-email-result');
  const kioskConfigTbody = document.getElementById('kiosk-config-tbody');
  const btnAddKioskRow = document.getElementById('btn-add-kiosk-row');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  function appendKioskConfigRow(k) {
    const tr = document.createElement('tr');
    const safeName = escapeHtml(k.name);
    tr.dataset.location = k.location || '';
    tr.innerHTML = `
      <td><input type="text" name="kioskIdRow" class="form-control form-control-sm k-id" value="${escapeHtml(k.id)}" required autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Kiosk ID for ${safeName}"></td>
      <td><input type="text" name="kioskNameRow" class="form-control form-control-sm k-name" value="${safeName}" required aria-label="Display Name for ${safeName}"></td>
      <td><input type="text" name="kioskUrlRow" class="form-control form-control-sm k-url" value="${escapeHtml(k.expectedUrl || '')}" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Target URL for ${safeName}"></td>
      <td class="text-end">
        <button type="button" class="btn btn-sm btn-outline-danger icon button-delete-row btn-remove-row" aria-label="Remove ${safeName} row" title="Remove row"></button>
      </td>
    `;
    kioskConfigTbody.appendChild(tr);
  }

  btnAddKioskRow.addEventListener('click', () => {
    const existingRowCount = kioskConfigTbody.querySelectorAll('tr').length + 1;
    const num = String(existingRowCount).padStart(2, '0');
    appendKioskConfigRow({
      id: `kiosk-${num}`,
      name: `Kiosk ${num}`,
      location: `Zone ${Math.ceil(existingRowCount / 2)}`,
      expectedUrl: `${getAppBaseUrl()}/demo-kiosk.cfm?kioskId=kiosk-${num}`
    });
  });

  kioskConfigTbody.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.btn-remove-row');
    if (removeBtn) {
      const tr = removeBtn.closest('tr');
      if (tr) tr.remove();
    }
  });

  btnOpenSettings.addEventListener('click', async () => {
    btnSaveSettings.disabled = false;
    const res = await fetch('api.cfm?action=config');
    const cfg = await res.json();

    cfgInterval.value = cfg.heartbeatIntervalSeconds || 5;
    cfgWarning.value = cfg.warningThresholdSeconds || 10;
    cfgCrash.value = cfg.crashTimeoutSeconds || 15;

    smtpEnabled.checked = Boolean(cfg.smtp?.enabled);
    smtpRecovery.checked = Boolean(cfg.smtp?.alertOnRecovery);
    smtpSecure.checked = Boolean(cfg.smtp?.secure);
    smtpHost.value = cfg.smtp?.host || '';
    smtpPort.value = cfg.smtp?.port || 587;
    smtpUser.value = cfg.smtp?.user || '';
    smtpPass.value = '';
    smtpFrom.value = cfg.smtp?.from || '';
    smtpTo.value = cfg.smtp?.to || '';
    testEmailResult.textContent = '';

    kioskConfigTbody.innerHTML = '';
    (cfg.kiosks || []).forEach((k) => appendKioskConfigRow(k));

    settingsDialog.showModal();
  });

  btnCloseSettings.addEventListener('click', () => settingsDialog.close());
  btnCancelSettings.addEventListener('click', () => settingsDialog.close());

  btnTestEmail.addEventListener('click', async () => {
    testEmailResult.textContent = 'Sending test email via ColdFusion cfmail...';
    const smtpPayload = {
      host: smtpHost.value.trim(),
      port: Number(smtpPort.value) || 587,
      secure: smtpSecure.checked,
      user: smtpUser.value.trim(),
      from: smtpFrom.value.trim(),
      to: smtpTo.value.trim()
    };
    if (smtpPass.value) {
      smtpPayload.pass = smtpPass.value;
    }

    try {
      const res = await fetch('api.cfm?action=test_email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ smtp: smtpPayload })
      });
      const data = await res.json();
      testEmailResult.textContent = data.ok ? data.message : `Error: ${data.error}`;
    } catch (err) {
      testEmailResult.textContent = `Error: ${err.message}`;
    }
  });

  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    btnSaveSettings.disabled = true;

    const rows = Array.from(kioskConfigTbody.querySelectorAll('tr'));
    const updatedKiosks = rows.map((tr) => ({
      id: tr.querySelector('.k-id').value.trim(),
      name: tr.querySelector('.k-name').value.trim(),
      location: tr.dataset.location || '',
      expectedUrl: tr.querySelector('.k-url').value.trim(),
      maintenance: false
    }));

    const smtpUpdate = {
      enabled: smtpEnabled.checked,
      alertOnRecovery: smtpRecovery.checked,
      secure: smtpSecure.checked,
      host: smtpHost.value.trim(),
      port: Number(smtpPort.value) || 587,
      user: smtpUser.value.trim(),
      from: smtpFrom.value.trim(),
      to: smtpTo.value.trim()
    };
    if (smtpPass.value) {
      smtpUpdate.pass = smtpPass.value;
    }

    try {
      await fetch('api.cfm?action=config_save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          heartbeatIntervalSeconds: Number(cfgInterval.value),
          warningThresholdSeconds: Number(cfgWarning.value),
          crashTimeoutSeconds: Number(cfgCrash.value),
          smtp: smtpUpdate,
          kiosks: updatedKiosks
        })
      });
      await refreshState();
      settingsDialog.close();
    } finally {
      btnSaveSettings.disabled = false;
    }
  });

  // Initial fetch + 1-second live polling loop against ColdFusion api.cfm
  refreshState();
  setInterval(refreshState, 1000);
})();
