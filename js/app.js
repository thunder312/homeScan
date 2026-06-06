import { initMap, updateMap, resizeMap } from './map.js';

const API = '/api';

// ── Interface-Icons (SVG) ──────────────────────────────────────────────────────
const SRC_LABEL = { fritzbox: 'FritzBox', rtt: 'Ping-Heuristik', oui: 'MAC-Heuristik' };

function iconVpn() {
  return `<span class="iface-wrap" data-tip="VPN-Tunnel (gleiche MAC wie primäres Gerät)"><svg class="iface-icon iface-icon--vpn" viewBox="0 0 20 20" aria-label="VPN">
  <rect x="3" y="9" width="14" height="9" rx="2" fill="none" stroke-width="2"/>
  <path d="M7 9V6a3 3 0 0 1 6 0v3" fill="none" stroke-width="2" stroke-linecap="round"/>
  <circle cx="10" cy="13.5" r="1.5"/>
</svg></span>`;
}

function iconWifi(src) {
  const cls   = src === 'fritzbox' ? '' : ' iface-icon--heuristic';
  const label = `WLAN · Quelle: ${SRC_LABEL[src] || src}`;
  return `<span class="iface-wrap" data-tip="${label}"><svg class="iface-icon iface-icon--wifi${cls}" viewBox="0 0 20 16" aria-label="${label}">
  <circle cx="10" cy="14" r="2"/>
  <path d="M6.5 10.8a5 5 0 0 1 7 0" fill="none" stroke-width="2" stroke-linecap="round"/>
  <path d="M3 7.5a10 10 0 0 1 14 0"  fill="none" stroke-width="2" stroke-linecap="round"/>
</svg></span>`;
}

function iconLan(src) {
  const cls   = src === 'fritzbox' ? '' : ' iface-icon--heuristic';
  const label = `LAN / Kabel · Quelle: ${SRC_LABEL[src] || src}`;
  return `<span class="iface-wrap" data-tip="${label}"><svg class="iface-icon iface-icon--lan${cls}" viewBox="0 0 20 20" aria-label="${label}">
  <rect x="5" y="2" width="10" height="10" rx="1.5" fill="none" stroke-width="2"/>
  <line x1="8"  y1="2" x2="8"  y2="6" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="2" x2="12" y2="6" stroke-width="2" stroke-linecap="round"/>
  <line x1="10" y1="12" x2="10" y2="18" stroke-width="2" stroke-linecap="round"/>
</svg></span>`;
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const scanBtn       = document.getElementById('scanBtn');
const progressWrap  = document.getElementById('progressWrap');
const progressFill  = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const deviceList    = document.getElementById('deviceList');
const statsBar      = document.getElementById('statsBar');
const scanMeta      = document.getElementById('scanMeta');
const searchInput   = document.getElementById('searchInput');
const scanAgeWrap   = document.getElementById('scanAgeWrap');
const scanAgeDate   = document.getElementById('scanAgeDate');
const scanAgeRel    = document.getElementById('scanAgeRel');
const sourcesBadge  = document.getElementById('sourcesBadge');

// ── State ──────────────────────────────────────────────────────────────────────
let allDevices   = [];
let deviceMap    = {};
let sortCol      = 'ip';
let sortDir      = 'asc';
let searchQuery  = '';
let activeSource = null;
let ageTimer     = null;

// ── Zeitanzeige ────────────────────────────────────────────────────────────────

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m <  2) return 'gerade eben';
  if (m < 60) return `vor ${m} Minute${m !== 1 ? 'n' : ''}`;
  if (h < 24) return `vor ${h} Stunde${h !== 1 ? 'n' : ''}`;
  return `vor ${d} Tag${d !== 1 ? 'en' : ''}`;
}

function showScanAge(iso) {
  if (!iso) return;
  const date = new Date(iso);
  scanAgeDate.textContent = date.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' Uhr';

  const updateRel = () => { scanAgeRel.textContent = relativeTime(iso); };
  updateRel();
  scanAgeWrap.hidden = false;

  // Jede Minute den Relativwert aktualisieren
  if (ageTimer) clearInterval(ageTimer);
  ageTimer = setInterval(updateRel, 60000);
}

// ── Cache laden beim Start ─────────────────────────────────────────────────────

async function initFromCache() {
  try {
    const res  = await fetch(`${API}/devices`);
    const data = await res.json();
    if (data.devices && data.devices.length > 0) {
      loadDevices(data.devices);
      showScanAge(data.scannedAt);
      scanBtn.textContent = 'Neu scannen';
    }
  } catch {
    // Backend noch nicht bereit — kein Problem
  }
}

function loadDevices(devices) {
  allDevices = devices;
  deviceMap  = {};
  devices.forEach((d, i) => { deviceMap[d.ip] = i; });
  render();
}

// ── Data ───────────────────────────────────────────────────────────────────────

function getFiltered() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return allDevices;
  return allDevices.filter(d =>
    (d.ip         || '').toLowerCase().includes(q) ||
    (d.mac        || '').toLowerCase().includes(q) ||
    (d.customName || '').toLowerCase().includes(q) ||
    (d.hostname   || '').toLowerCase().includes(q) ||
    (d.aliasName  || '').toLowerCase().includes(q) ||
    (d.vendor     || '').toLowerCase().includes(q)
  );
}

function getSorted(list) {
  return [...list].sort((a, b) => {
    let av, bv;
    if (sortCol === 'ip') {
      av = (a.ip || '').split('.').map(n => n.padStart(3, '0')).join('');
      bv = (b.ip || '').split('.').map(n => n.padStart(3, '0')).join('');
    } else if (sortCol === 'iface') {
      // ethernet → wifi → vpn → unbekannt
      const order = { ethernet: 0, wifi: 1, vpn: 2 };
      av = a.iface != null ? (order[a.iface] ?? 3) : 4;
      bv = b.iface != null ? (order[b.iface] ?? 3) : 4;
    } else if (sortCol === 'hostname') {
      // Angezeigter Name: customName hat Vorrang vor hostname
      av = (a.customName || a.aliasName || a.hostname || '￿').toLowerCase();
      bv = (b.customName || b.aliasName || b.hostname || '￿').toLowerCase();
    } else {
      // Nulls ans Ende
      av = (a[sortCol] ?? '￿').toLowerCase();
      bv = (b[sortCol] ?? '￿').toLowerCase();
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

// ── Render ─────────────────────────────────────────────────────────────────────

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const NAME_SRC_LABEL = {
  fritzbox: 'FritzBox',
  netbios:  'NetBIOS',
  ssdp:     'UPnP/SSDP',
  http:     'HTTP-Webseite',
};

function hostnameCell(d) {
  const primary   = d.customName || d.hostname;
  const secondary = d.customName && d.hostname && d.customName !== d.hostname
    ? d.hostname : null;

  const srcLabel = d.customNameSrc ? NAME_SRC_LABEL[d.customNameSrc] : null;
  const badge    = (d.customNameSrc === 'http' || d.customNameSrc === 'ssdp')
    ? `<span class="name-src-badge" title="Quelle: ${srcLabel}">${srcLabel}</span>`
    : '';

  // Offene Ports für namenlose Geräte anzeigen
  const portHtml = (!primary && d.ports && d.ports.length)
    ? d.ports.map(p =>
        `<span class="port-badge" title="Port ${p.port} offen">${esc(p.service)}</span>`
      ).join('')
    : '';

  // VPN: primäres Gerät als Referenz anzeigen
  if (d.iface === 'vpn' && d.vpnOf) {
    return `<span class="dev-name">VPN-Tunnel</span><span class="dev-fqdn">Interface von ${esc(d.vpnOf)}</span>`;
  }

  // Alias: Zweit-Interface eines bekannten Geräts (gleicher SSH-Banner)
  if (d.aliasOf) {
    const name = d.aliasName || d.aliasOf;
    return `<span class="dev-name">${esc(name)}</span>`
         + `<span class="dev-fqdn">Zweit-Interface · ${esc(d.aliasOf)}</span>`;
  }

  if (!primary) {
    return portHtml
      ? `<span class="dev-ports">${portHtml}</span>`
      : '<span class="muted">&mdash;</span>';
  }

  return secondary
    ? `<span class="dev-name">${esc(primary)}${badge}</span><span class="dev-fqdn">${esc(secondary)}</span>`
    : `<span class="dev-name">${esc(primary)}${badge}</span>`;
}

let renderQueued = false;
function scheduleRender() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
      if (currentView === 'map' && mapInited) updateMap(allDevices);
    });
  }
}

function render() {
  const list = getSorted(getFiltered());
  updateStats(list.length);

  if (list.length === 0) {
    deviceList.innerHTML = allDevices.length === 0
      ? `<tr class="empty-row"><td colspan="5">Noch kein Scan durchgeführt &mdash; klicke auf &ldquo;Netzwerk scannen&rdquo;.</td></tr>`
      : `<tr class="empty-row"><td colspan="5">Keine Treffer für &ldquo;${esc(searchQuery)}&rdquo;.</td></tr>`;
    return;
  }

  deviceList.innerHTML = list.map(d => {
    const pending   = d.vendor === undefined;
    const statusCell = d.iface === 'vpn'      ? iconVpn()
                     : d.iface === 'wifi'     ? iconWifi(d.ifaceSrc)
                     : d.iface === 'ethernet' ? iconLan(d.ifaceSrc)
                     : `<span class="dot dot--on" title="Online (Typ unbekannt)"></span>`;
    return `<tr class="device-row">
      <td class="col-status"><span class="status-cell">${statusCell}</span></td>
      <td class="col-hostname">${hostnameCell(d)}</td>
      <td class="col-ip">${esc(d.ip)}</td>
      <td class="col-mac">${esc(d.mac)}</td>
      <td class="col-vendor${pending ? ' col-vendor--loading' : ''}">${
        pending
          ? '<span class="vendor-loading"></span>'
          : (esc(d.vendor) || '<span class="muted">&mdash;</span>')
      }</td>
    </tr>`;
  }).join('');
}

function updateStats(visibleCount) {
  const total = allDevices.length;
  if (total === 0) { statsBar.innerHTML = ''; return; }
  const countHtml = visibleCount === total
    ? `<span class="stats-count">${total}</span>`
    : `<span class="stats-count">${visibleCount}</span><span class="stats-of">/ ${total}</span>`;
  statsBar.innerHTML = `<span class="stats-label">Geräte</span>${countHtml}`;
}

// ── Sort ───────────────────────────────────────────────────────────────────────

function setSort(col) {
  sortDir = sortCol === col && sortDir === 'asc' ? 'desc' : 'asc';
  sortCol = col;
  updateSortHeaders();
  render();
}

function updateSortHeaders() {
  document.querySelectorAll('th[data-col]').forEach(th => {
    const active = th.dataset.col === sortCol;
    th.classList.toggle('sort-active', active);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = active ? (sortDir === 'asc' ? '↑' : '↓') : '';
  });
}

// ── Progress ───────────────────────────────────────────────────────────────────

function setProgress(pct, label) {
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = label;
}

function showProgress(visible) {
  progressWrap.hidden = !visible;
}

// ── Scan ───────────────────────────────────────────────────────────────────────

function startScan() {
  if (activeSource) { activeSource.close(); activeSource = null; }

  allDevices = [];
  deviceMap  = {};
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scan läuft…';
  scanMeta.textContent = '';
  scanMeta.className = 'scan-meta';
  showProgress(true);
  setProgress(0, 'Verbinde…');
  render();

  const es = new EventSource(`${API}/scan`);
  activeSource = es;

  es.addEventListener('progress', (e) => {
    const { percent } = JSON.parse(e.data);
    setProgress(percent, `Ping-Sweep… ${percent}%`);
  });

  es.addEventListener('device', (e) => {
    const d = JSON.parse(e.data);
    if (deviceMap[d.ip] === undefined) {
      deviceMap[d.ip] = allDevices.length;
      allDevices.push(d);
      setProgress(100, 'Geräte gefunden — lade Herstellerdaten…');
      scheduleRender();
    }
  });

  es.addEventListener('vendor', (e) => {
    const { ip, vendor } = JSON.parse(e.data);
    const idx = deviceMap[ip];
    if (idx !== undefined) {
      allDevices[idx] = { ...allDevices[idx], vendor };
      scheduleRender();
    }
  });

  es.addEventListener('sources', (e) => {
    const { gateway, fritzbox } = JSON.parse(e.data);
    const parts = [`Gateway: ${gateway}`];
    if (fritzbox) parts.push('FritzBox ✓');
    parts.push('Ping-RTT', 'MAC-OUI');
    sourcesBadge.textContent = parts.join('  ·  ');
    sourcesBadge.hidden = false;
    sourcesBadge.className = `sources-badge${fritzbox ? '' : ' sources-badge--no-fritz'}`;
  });

  es.addEventListener('portScan', (e) => {
    const { ip, ports } = JSON.parse(e.data);
    const idx = deviceMap[ip];
    if (idx !== undefined) {
      allDevices[idx] = { ...allDevices[idx], ports };
      scheduleRender();
    }
  });

  es.addEventListener('alias', (e) => {
    const { ip, aliasOf, aliasName } = JSON.parse(e.data);
    const idx = deviceMap[ip];
    if (idx !== undefined) {
      allDevices[idx] = { ...allDevices[idx], aliasOf, aliasName };
      scheduleRender();
    }
  });

  es.addEventListener('nameUpdate', (e) => {
    const { ip, customName, customNameSrc } = JSON.parse(e.data);
    const idx = deviceMap[ip];
    if (idx !== undefined) {
      allDevices[idx] = { ...allDevices[idx], customName, customNameSrc };
      scheduleRender();
    }
  });

  es.addEventListener('done', (e) => {
    const { scannedAt } = JSON.parse(e.data);
    showScanAge(scannedAt);
    finish(false);
  });

  es.addEventListener('error', (e) => {
    let msg = 'Unbekannter Fehler';
    try { msg = JSON.parse(e.data).message; } catch {}
    finish(true, msg);
  });

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      finish(true, 'Verbindung zum Backend unterbrochen. Läuft "npm run dev"?');
    }
  };

  function finish(isError, errorMsg) {
    es.close();
    activeSource = null;
    scanBtn.disabled = false;
    scanBtn.textContent = 'Neu scannen';
    showProgress(false);
    if (isError) {
      scanMeta.textContent = `Fehler: ${errorMsg}`;
      scanMeta.className = 'scan-meta scan-meta--error';
    } else {
      scanMeta.textContent = '';
    }
    render();
  }
}

// ── Events ─────────────────────────────────────────────────────────────────────

scanBtn.addEventListener('click', startScan);

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  render();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; searchQuery = ''; render(); }
});

document.querySelectorAll('th[data-col]').forEach(th => {
  th.addEventListener('click', () => setSort(th.dataset.col));
});

// ── Karte ──────────────────────────────────────────────────────────────────────

const tabList      = document.getElementById('tabList');
const tabMap       = document.getElementById('tabMap');
const mapView      = document.getElementById('mapView');
const tableWrap    = document.querySelector('.table-wrap');
const networkMapEl = document.getElementById('networkMap');
const mapDetail    = document.getElementById('mapDetail');
const mapDetailClose    = document.getElementById('mapDetailClose');
const mapDetailContent  = document.getElementById('mapDetailContent');
let   mapInited    = false;
let   currentView  = 'list';

function switchView(view) {
  currentView = view;
  const showMap = view === 'map';
  mapView.hidden   = !showMap;
  tableWrap.hidden =  showMap;
  tabList.classList.toggle('view-tab--active', !showMap);
  tabMap.classList.toggle('view-tab--active',   showMap);

  if (showMap) {
    if (!mapInited) {
      initMap(networkMapEl, showMapDetail);
      mapInited = true;
    }
    updateMap(allDevices);
    resizeMap(networkMapEl);
  }
}

function showMapDetail(device) {
  if (!device) { mapDetail.hidden = true; return; }
  const iface = device.iface === 'ethernet' ? 'LAN (Kabel)'
              : device.iface === 'wifi'     ? 'WLAN'
              : device.iface === 'vpn'      ? 'VPN-Tunnel'
              : 'Unbekannt';
  const rows = [
    ['Name',       esc(device.customName || device.aliasName || device.hostname || '—')],
    ['IP',         `<code>${esc(device.ip)}</code>`],
    ['MAC',        `<code>${esc(device.mac)}</code>`],
    ['Verbindung', iface],
    ['Hersteller', esc(device.vendor || '—')],
  ];
  if (device.vpnOf)   rows.push(['VPN von', esc(device.vpnOf)]);
  if (device.aliasOf) rows.push(['Alias von', esc(device.aliasOf)]);
  if (device.ports?.length) {
    rows.push(['Ports', device.ports.map(p => `<span class="port-badge">${esc(p.service)}</span>`).join(' ')]);
  }
  mapDetailContent.innerHTML = rows
    .map(([k, v]) => `<div class="detail-row"><span class="detail-key">${k}</span><span class="detail-val">${v}</span></div>`)
    .join('');
  mapDetail.hidden = false;
}

tabList.addEventListener('click', () => switchView('list'));
tabMap.addEventListener('click',  () => switchView('map'));
mapDetailClose.addEventListener('click', () => { mapDetail.hidden = true; });
window.addEventListener('resize', () => { if (currentView === 'map') resizeMap(networkMapEl); });

// ── Vendor-Spalte ein-/ausklappen ──────────────────────────────────────────────

const deviceTable       = document.getElementById('deviceTable');
const vendorCollapseBtn = document.getElementById('vendorCollapseBtn');

function setVendorCollapsed(collapsed) {
  deviceTable.classList.toggle('vendor-collapsed', collapsed);
  vendorCollapseBtn.title = collapsed ? 'Hersteller einblenden' : 'Hersteller ausblenden';
  localStorage.setItem('vendorCollapsed', collapsed);
}

vendorCollapseBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // Sortierung nicht auslösen
  setVendorCollapsed(!deviceTable.classList.contains('vendor-collapsed'));
});

// Zustand aus localStorage wiederherstellen
setVendorCollapsed(localStorage.getItem('vendorCollapsed') === 'true');

// ── Settings ───────────────────────────────────────────────────────────────────

const settingsBtn   = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const settingsClose = document.getElementById('settingsClose');
const cfgUsername   = document.getElementById('cfgUsername');
const cfgPassword   = document.getElementById('cfgPassword');
const cfgSave       = document.getElementById('cfgSave');
const cfgTest       = document.getElementById('cfgTest');
const cfgClear      = document.getElementById('cfgClear');
const cfgStatus     = document.getElementById('cfgStatus');

function showCfgStatus(msg, ok) {
  cfgStatus.textContent = msg;
  cfgStatus.className   = `cfg-status cfg-status--${ok ? 'ok' : 'err'}`;
  cfgStatus.hidden      = false;
}

async function openSettings() {
  const res  = await fetch(`${API}/config`);
  const data = await res.json();
  cfgUsername.value    = data.username || '';
  cfgPassword.value    = '';   // immer leer — kein Autofill-Ziel
  cfgPassword.placeholder = data.hasPassword
    ? 'Passwort gespeichert — neu eingeben zum Ändern'
    : 'Router-Passwort';
  cfgStatus.hidden     = true;
  settingsModal.hidden = false;
}

settingsBtn.addEventListener('click', openSettings);

settingsClose.addEventListener('click', () => { settingsModal.hidden = true; });

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true;
});

cfgSave.addEventListener('click', async () => {
  const password = cfgPassword.value.trim(); // leer = nicht ändern
  const res  = await fetch(`${API}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfgUsername.value, password }),
  });
  const data = await res.json();
  if (data.ok) cfgPassword.value = '';
  showCfgStatus(data.message, data.ok);
});

cfgTest.addEventListener('click', async () => {
  showCfgStatus('Teste Verbindung…', true);
  // Erst speichern falls neues Passwort eingegeben
  if (cfgPassword.value && cfgPassword.value !== '••••••••') {
    await fetch(`${API}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfgUsername.value, password: cfgPassword.value }),
    });
  }
  const res  = await fetch(`${API}/config/test`, { method: 'POST' });
  const data = await res.json();
  showCfgStatus(data.message, data.ok);
});

document.getElementById('cfgPwToggle').addEventListener('click', () => {
  const isHidden = cfgPassword.type === 'password';
  cfgPassword.type = isHidden ? 'text' : 'password';
  document.getElementById('pwEyeIcon').style.opacity = isHidden ? '1' : '0.4';
});

cfgClear.addEventListener('click', async () => {
  const res  = await fetch(`${API}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  const data = await res.json();
  cfgPassword.value = '';
  cfgUsername.value = '';
  showCfgStatus(data.message, data.ok);
});

// ── Init ───────────────────────────────────────────────────────────────────────

render();
updateSortHeaders();
initFromCache().then(() => {
  // Hash-Routing: #map öffnet direkt die Karte
  if (window.location.hash === '#map') switchView('map');
});
