import * as d3 from 'd3';

const C = {
  router:   '#58a6ff',
  ethernet: '#56d364',
  wifi:     '#79c0ff',
  vpn:      '#d2a8ff',
  unknown:  '#8b949e',
  bg:       '#0d1117',
  surface:  '#161b22',
  border:   '#30363d',
  text:     '#c9d1d9',
  muted:    '#8b949e',
};

const ICON = {
  router:   'M3,6 h14 v8 h-14z M7,6 V3 M13,6 V3 M7,10 h6',
  ethernet: 'M5,2 h10 v7 h-10z M7.5,2 V5 M12.5,2 V5 M10,9 V16',
  wifi:     'M10,14 m-1.5,0 a1.5,1.5 0 1,0 3,0 a1.5,1.5 0 1,0 -3,0 M5.5,10.5 a6.5,6.5 0 0,1 9,0 M2.5,7.5 a10.5,10.5 0 0,1 15,0',
  vpn:      'M4,9 h12 v8 h-12z M7,9 V6 a3,3 0 0,1 6,0 V9 M10,13 v2',
  unknown:  'M10,10 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M10,7 a2,2 0 0,1 0,4 M10,13 v0.5',
};

const DEVICE_R = 22;
const GW_R     = 26;
const ROUTER_R = 30;

let svg, g, linksG, nodesG;
let w = 900, h = 600;
let onSelect = null;
let selectedId = null;
let lastDevices = [];

// ── Init ───────────────────────────────────────────────────────────────────────
export function initMap(containerEl, selectCb) {
  onSelect = selectCb;
  const rect = containerEl.getBoundingClientRect();
  w = rect.width  || 900;
  h = rect.height || 600;

  svg = d3.select(containerEl)
    .attr('width', '100%').attr('height', '100%')
    .style('background', C.bg)
    .style('display', 'block');

  const defs = svg.append('defs');
  Object.entries(ICON).forEach(([key, path]) => {
    defs.append('symbol').attr('id', 'ico-' + key).attr('viewBox', '0 0 20 20')
      .append('path')
        .attr('d', path)
        .attr('fill', 'none').attr('stroke', 'currentColor')
        .attr('stroke-width', 1.6)
        .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
  });

  const zoom = d3.zoom().scaleExtent([0.15, 5])
    .on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoom);
  svg.on('dblclick.zoom', null);
  svg.on('click', () => { onSelect?.(null); deselect(); });

  containerEl.closest('.map-container')
    ?.querySelectorAll('[data-zoom]')
    .forEach(btn => {
      btn.addEventListener('click', () => {
        const factor = btn.dataset.zoom === 'in' ? 1.4 : 0.7;
        svg.transition().duration(300).call(zoom.scaleBy, factor);
      });
    });

  g      = svg.append('g');
  linksG = g.append('g').attr('class', 'map-links');
  nodesG = g.append('g').attr('class', 'map-nodes');
}

// ── Update ─────────────────────────────────────────────────────────────────────
export function updateMap(devices) {
  if (!svg || !devices.length) return;
  lastDevices = devices;

  const sorted   = [...devices].sort(ipCmp);
  const routerIp = sorted[0].ip;

  // Mesh-Gateways: alle Geräte die selbst Verbindungsziel anderer Geräte sind
  const meshGateways = new Set(
    devices.filter(d => devices.some(x => x.connectedVia === d.ip)).map(d => d.ip)
  );

  // Sortierung: EG → Index 0 (links), OG → Index 1 (rechts)
  const meshGwList = [...meshGateways].sort((a, b) => {
    const na = gwName(devices, a), nb = gwName(devices, b);
    if (na.includes('og') && !nb.includes('og')) return 1;
    if (!na.includes('og') && nb.includes('og')) return -1;
    return ipCmp(devices.find(d => d.ip === a), devices.find(d => d.ip === b));
  });

  const nodeIds = new Set(devices.map(d => d.ip));

  // Cluster aufbauen: centerId → [memberIp, ...]
  const clusters = {};
  for (const d of devices) {
    if (d.ip === routerIp || meshGateways.has(d.ip)) continue;
    const via      = d.connectedVia;
    const centerId = (via && (via === routerIp || meshGateways.has(via))) ? via
                   : (d.vpnOf && (d.vpnOf === routerIp || meshGateways.has(d.vpnOf))) ? d.vpnOf
                   : routerIp;
    (clusters[centerId] = clusters[centerId] || []).push(d.ip);
  }

  // ── Orbit-Radius berechnen ────────────────────────────────────────────────
  // Mindestumfang = n × (Icon-Durchmesser + Abstand)
  const ICON_CLEARANCE = DEVICE_R * 2 + 24; // 68 px pro Gerät
  const LABEL_EXTRA    = 42;                 // Platz für Label unterhalb
  const AP_GAP         = 55;                 // Mindestabstand zwischen Cluster-Grenzen
  const apList         = [routerIp, ...meshGwList];

  const orbitR   = {}; // Radius des Geräte-Kreises
  const clusterR = {}; // Sicherer Gesamt-Radius des Clusters

  for (const apIp of apList) {
    const n   = (clusters[apIp] || []).length;
    const apR = apIp === routerIp ? ROUTER_R : GW_R;
    if (n === 0) {
      orbitR[apIp]   = 0;
      clusterR[apIp] = apR + LABEL_EXTRA;
    } else {
      const minR     = (n * ICON_CLEARANCE) / (2 * Math.PI);
      orbitR[apIp]   = Math.max(110, Math.ceil(minR));
      clusterR[apIp] = orbitR[apIp] + DEVICE_R + LABEL_EXTRA;
    }
  }

  // ── Access-Point Positionen (gleichseitiges Dreieck) ─────────────────────
  const apPos = placeAPs(routerIp, meshGwList, clusterR, AP_GAP);

  // ── Geräte-Positionen auf Orbit-Kreisen ───────────────────────────────────
  const nodePos = { ...apPos };

  // Schwerpunkt des AP-Dreiecks (für "nach-außen-zeigen"-Winkel)
  const centX = apList.reduce((s, ip) => s + apPos[ip].x, 0) / apList.length;
  const centY = apList.reduce((s, ip) => s + apPos[ip].y, 0) / apList.length;

  for (const apIp of apList) {
    const members = clusters[apIp] || [];
    const n       = members.length;
    if (n === 0) continue;

    const { x: cx, y: cy } = apPos[apIp];
    const R          = orbitR[apIp];
    // Startwinkel zeigt vom Schwerpunkt weg (nach außen)
    const startAngle = Math.atan2(cy - centY, cx - centX);

    members.forEach((ip, i) => {
      const angle = startAngle + (2 * Math.PI * i) / n;
      nodePos[ip] = { x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R };
    });
  }

  // ── Node-Objekte ──────────────────────────────────────────────────────────
  const nodes = devices.map(d => {
    const isRouter = d.ip === routerIp;
    const isMeshGw = meshGateways.has(d.ip);
    const type     = isRouter ? 'router' : (d.iface || 'unknown');
    const pos      = nodePos[d.ip] ?? { x: w / 2, y: h / 2 };
    return {
      id:    d.ip,
      label: shortLabel(d),
      type,
      color: C[type] || C.unknown,
      r:     isRouter ? ROUTER_R : isMeshGw ? GW_R : DEVICE_R,
      data:  d,
      x:     pos.x,
      y:     pos.y,
    };
  });

  // Positions-Map für Link-Rendering
  const posMap = {};
  nodes.forEach(n => { posMap[n.id] = n; });

  // ── Links ─────────────────────────────────────────────────────────────────
  const links = devices
    .filter(d => d.ip !== routerIp)
    .map(d => {
      const src        = (d.connectedVia && nodeIds.has(d.connectedVia)) ? d.connectedVia
                       : (d.vpnOf        && nodeIds.has(d.vpnOf))        ? d.vpnOf
                       : routerIp;
      const isBackbone = meshGateways.has(d.ip) && src === routerIp;
      return { source: src, target: d.ip, type: d.iface || 'unknown', isBackbone };
    });

  const linkSel = linksG.selectAll('line').data(links, d => `${d.source}→${d.target}`);
  linkSel.exit().remove();
  const linkAll = linkSel.enter().append('line').merge(linkSel);

  linkAll
    .attr('stroke',           d => d.isBackbone ? C.router : (C[d.type] || C.border))
    .attr('stroke-opacity',   d => d.isBackbone ? 0.9 : 0.38)
    .attr('stroke-width',     d => d.isBackbone ? 5 : (meshGateways.has(d.source) ? 2 : 1.5))
    .attr('stroke-dasharray', d => d.isBackbone ? null : d.type === 'wifi' ? '6,4' : d.type === 'vpn' ? '2,5' : null)
    .attr('stroke-linecap',   'round')
    .attr('x1', d => posMap[d.source]?.x ?? 0).attr('y1', d => posMap[d.source]?.y ?? 0)
    .attr('x2', d => posMap[d.target]?.x ?? 0).attr('y2', d => posMap[d.target]?.y ?? 0);

  // ── Nodes rendern ─────────────────────────────────────────────────────────
  const nodeSel = nodesG.selectAll('g.mnode').data(nodes, d => d.id);
  nodeSel.exit().remove();

  const enter = nodeSel.enter().append('g').attr('class', 'mnode')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('drag', (e, d) => {
        d.x = e.x; d.y = e.y;
        posMap[d.id].x = e.x; posMap[d.id].y = e.y;
        d3.select(e.currentTarget).attr('transform', `translate(${e.x},${e.y})`);
        linksG.selectAll('line').each(function(lk) {
          const ln = d3.select(this);
          if (lk.source === d.id) ln.attr('x1', e.x).attr('y1', e.y);
          if (lk.target === d.id) ln.attr('x2', e.x).attr('y2', e.y);
        });
      })
    )
    .on('click', (e, d) => {
      e.stopPropagation();
      selectedId = d.id;
      onSelect?.(d.data);
      applyHighlight();
    });

  enter.append('circle').attr('class', 'glow').attr('fill', 'none').attr('stroke-width', 6).attr('stroke-opacity', 0);
  enter.append('circle').attr('class', 'body').attr('stroke-width', 2);
  enter.append('use').attr('width', 16).attr('height', 16).attr('x', -8).attr('y', -8);
  enter.append('a').attr('class', 'label-link')
    .append('text')
    .attr('text-anchor', 'middle')
    .attr('font-family', '-apple-system, Segoe UI, sans-serif')
    .attr('font-size', 11);

  const all = enter.merge(nodeSel);

  all.select('circle.glow').attr('r', d => d.r + 5).attr('stroke', d => d.color);
  all.select('circle.body').attr('r', d => d.r).attr('fill', d => d.color + '1a').attr('stroke', d => d.color);
  all.select('use').attr('href', d => `#ico-${d.type}`).attr('color', d => d.color);

  // Label-Anker: href nur setzen wenn webUrl vorhanden
  all.select('a.label-link')
    .attr('href', d => d.data?.webUrl || null)
    .attr('target', d => d.data?.webUrl ? '_blank' : null)
    .attr('rel', d => d.data?.webUrl ? 'noopener noreferrer' : null)
    .style('pointer-events', d => d.data?.webUrl ? 'auto' : 'none');

  all.select('a.label-link text')
    .attr('dy', d => d.r + 15)
    .text(d => d.data?.webUrl ? `${d.label} ↗` : d.label);

  // Positionen setzen – neue Knoten direkt, bestehende mit sanftem Übergang
  enter.attr('transform', d => `translate(${d.x},${d.y})`);
  nodeSel.transition().duration(500).ease(d3.easeCubicOut)
    .attr('transform', d => `translate(${d.x},${d.y})`);

  applyHighlight();
}

// ── AP-Positionen: gleichseitiges Dreieck ─────────────────────────────────────
function placeAPs(routerIp, meshGwList, clusterR, gap) {
  const pos = {};
  const cx = w / 2, cy = h / 2;

  if (meshGwList.length === 0) {
    pos[routerIp] = { x: cx, y: cy };
    return pos;
  }

  if (meshGwList.length === 1) {
    const gw   = meshGwList[0];
    const dist = clusterR[routerIp] + clusterR[gw] + gap;
    pos[routerIp] = { x: cx, y: cy - dist / 2 };
    pos[gw]       = { x: cx, y: cy + dist / 2 };
    return pos;
  }

  // 2+ Gateways: gleichseitiges Dreieck
  // Router oben (-90°), EG unten-links (210°), OG unten-rechts (330°)
  const [gw1, gw2] = meshGwList; // gw1 = EG (links), gw2 = OG (rechts)

  const minSide = Math.max(
    clusterR[routerIp] + clusterR[gw1] + gap,
    clusterR[routerIp] + clusterR[gw2] + gap,
    clusterR[gw1]      + clusterR[gw2] + gap
  );

  // Umkreis-Radius des gleichseitigen Dreiecks: R = side / sqrt(3)
  const R = minSide / Math.sqrt(3);

  pos[routerIp] = { x: cx,                                   y: cy - R                              };
  pos[gw1]      = { x: cx + R * Math.cos(5 * Math.PI / 6),   y: cy + R * Math.sin(5 * Math.PI / 6) }; // links
  pos[gw2]      = { x: cx + R * Math.cos(    Math.PI / 6),   y: cy + R * Math.sin(    Math.PI / 6) }; // rechts

  return pos;
}

// ── Resize ─────────────────────────────────────────────────────────────────────
export function resizeMap(containerEl) {
  const rect = containerEl.getBoundingClientRect();
  w = rect.width  || w;
  h = rect.height || h;
  if (lastDevices.length) updateMap(lastDevices);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function gwName(devices, ip) {
  const d = devices.find(x => x.ip === ip);
  return (d?.customName || d?.hostname || '').toLowerCase();
}

function shortLabel(d) {
  const raw = d.customName || d.aliasName || d.hostname?.split('.')[0] || d.ip;
  return raw.length > 22 ? raw.slice(0, 20) + '…' : raw;
}

function ipCmp(a, b) {
  const ao = a.ip.split('.').map(Number), bo = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (ao[i] !== bo[i]) return ao[i] - bo[i];
  return 0;
}

function applyHighlight() {
  nodesG.selectAll('g.mnode circle.glow')
    .attr('stroke-opacity', d => d.id === selectedId ? 0.4 : 0);
  nodesG.selectAll('g.mnode circle.body')
    .attr('stroke-width', d => d.id === selectedId ? 3 : 2);
  nodesG.selectAll('g.mnode text')
    .attr('fill', d => d.id === selectedId ? C.router
                     : d.data?.webUrl     ? C.wifi    // Blau = klickbarer Link
                     : C.text)
    .attr('font-weight', d => d.id === selectedId ? 600 : 400);
}

function deselect() {
  selectedId = null;
  applyHighlight();
}
