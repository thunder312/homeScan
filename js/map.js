import * as d3 from 'd3';

// ── Farben ─────────────────────────────────────────────────────────────────────
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

// ── SVG-Icon-Pfade (viewBox 0 0 20 20, Mittelpunkt 10/10) ─────────────────────
const ICON = {
  router:   'M3,6 h14 v8 h-14z M7,6 V3 M13,6 V3 M7,10 h6',
  ethernet: 'M5,2 h10 v7 h-10z M7.5,2 V5 M12.5,2 V5 M10,9 V16',
  wifi:     'M10,14 m-1.5,0 a1.5,1.5 0 1,0 3,0 a1.5,1.5 0 1,0 -3,0 M5.5,10.5 a6.5,6.5 0 0,1 9,0 M2.5,7.5 a10.5,10.5 0 0,1 15,0',
  vpn:      'M4,9 h12 v8 h-12z M7,9 V6 a3,3 0 0,1 6,0 V9 M10,13 v2',
  unknown:  'M10,10 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M10,7 a2,2 0 0,1 0,4 M10,13 v0.5',
};

// ── Zustand ────────────────────────────────────────────────────────────────────
let svg, g, linksG, nodesG, sim;
let w = 900, h = 600;
let onSelect = null;
let selectedId = null;

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

  // Defs: Icon-Symbole als SVG <symbol>
  const defs = svg.append('defs');
  Object.entries(ICON).forEach(([key, path]) => {
    defs.append('symbol').attr('id', 'ico-' + key).attr('viewBox', '0 0 20 20')
      .append('path')
        .attr('d', path)
        .attr('fill', 'none')
        .attr('stroke', 'currentColor')
        .attr('stroke-width', 1.6)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');
  });

  // Zoom / Pan
  const zoom = d3.zoom()
    .scaleExtent([0.15, 5])
    .on('zoom', (e) => g.attr('transform', e.transform));
  svg.call(zoom);

  // Klick auf Hintergrund → Auswahl aufheben
  svg.on('click', () => { onSelect?.(null); deselect(); });

  // Zoom-Buttons
  svg.on('dblclick.zoom', null); // kein Doppelklick-Zoom
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

  // Simulation
  sim = d3.forceSimulation()
    .force('link',      d3.forceLink().id(d => d.id).distance(140).strength(0.4))
    .force('charge',    d3.forceManyBody().strength(-400))
    .force('center',    d3.forceCenter(w / 2, h / 2).strength(0.05))
    .force('collision', d3.forceCollide(48))
    .alphaDecay(0.02);
}

// ── Update ─────────────────────────────────────────────────────────────────────
export function updateMap(devices) {
  if (!svg || !devices.length) return;

  // Router erkennen (niedrigste IP)
  const sorted   = [...devices].sort(ipCmp);
  const routerIp = sorted[0].ip;

  // Bestehende Positionen merken
  const pos = {};
  (sim.nodes() || []).forEach(n => { pos[n.id] = { x: n.x, y: n.y }; });

  const nodeIds = new Set(devices.map(d => d.ip));

  // Mesh-Gateways identifizieren
  const meshGateways = new Set(
    devices.filter(d => devices.some(x => x.connectedVia === d.ip)).map(d => d.ip)
  );
  const meshGwList = [...meshGateways];

  // ── Fixe Ankerpositionen (Dreieck-Layout) ─────────────────────────────────
  // FritzBox: oben Mitte
  // EG:       unten links (weit außen)
  // OG:       unten rechts (weit außen)
  const ROUTER_FX = w / 2;
  const ROUTER_FY = h * 0.22;           // oben, etwas tiefer als vorher → Platz für Geräte darüber
  const GW_Y      = h * 0.85;           // weit unten
  const GW_X_L    = w * 0.15;           // links außen
  const GW_X_R    = w * 0.85;           // rechts außen

  const gwPositions = {};
  meshGwList.forEach((gwIp) => {
    const d    = devices.find(x => x.ip === gwIp);
    const name = (d?.customName || d?.hostname || '').toLowerCase();
    // OG → rechts,  EG → links,  sonst nach Index
    const isOg = name.includes('og');
    const isEg = name.includes('eg');
    gwPositions[gwIp] = {
      x: isOg ? GW_X_R : isEg ? GW_X_L : (meshGwList.indexOf(gwIp) % 2 === 0 ? GW_X_L : GW_X_R),
      y: GW_Y,
    };
  });

  // ── Kreisförmige Zielpositionen berechnen ────────────────────────────────
  // Für jede Gruppe: 240°-Fächer nach außen (weg vom Elternknoten)
  const clusters = {};
  for (const d of devices) {
    if (d.ip === routerIp || meshGateways.has(d.ip)) continue;
    const via     = d.connectedVia;
    const clustId = (via && gwPositions[via]) ? via : (d.vpnOf || routerIp);
    (clusters[clustId] = clusters[clustId] || []).push(d.ip);
  }

  const targetPos = {};
  const PI2 = Math.PI * 2;

  // Hilfsfunktion: normalisiert Winkel auf [0, 2π)
  const norm = a => ((a % PI2) + PI2) % PI2;

  for (const [centId, memberIps] of Object.entries(clusters)) {
    const cx = centId === routerIp ? ROUTER_FX : gwPositions[centId]?.x;
    const cy = centId === routerIp ? ROUTER_FY : gwPositions[centId]?.y;
    if (cx == null) continue;

    const n = memberIps.length;
    const R = Math.max(130, Math.sqrt(n) * 55);

    let outAngle, fan;

    if (centId === routerIp && meshGwList.length >= 2) {
      // ── Sicherer Bogen für Router-Geräte ────────────────────────────────
      // Backbone-Winkel von FritzBox zu EG und OG berechnen
      const bbAngles = meshGwList
        .map(ip => norm(Math.atan2(gwPositions[ip].y - ROUTER_FY, gwPositions[ip].x - ROUTER_FX)))
        .sort((a, b) => a - b);   // aufsteigend: zuerst OG (~60°), dann EG (~120°)

      const BUFFER = 40 * Math.PI / 180;         // 40° Puffer um jede Backbone-Linie
      const forbidLo = bbAngles[0] - BUFFER;     // unter OG-Richtung
      const forbidHi = bbAngles[bbAngles.length - 1] + BUFFER; // über EG-Richtung
      const forbidSpan = forbidHi - forbidLo;    // verbotene Zone

      // Sicherer Bogen: der Rest (geht durch 180°, 270°, 0°)
      const safeSpan = PI2 - forbidSpan;
      outAngle = norm(forbidHi + safeSpan / 2);  // Mittelpunkt des sicheren Bogens
      fan      = Math.min(Math.PI * 4 / 3, safeSpan - 0.2); // max 240°, in sicherem Bereich
    } else if (centId !== routerIp) {
      // EG / OG: 240°-Fächer weg von FritzBox
      outAngle = Math.atan2(cy - ROUTER_FY, cx - ROUTER_FX);
      fan      = Math.PI * 4 / 3;
    } else {
      // Router ohne Mesh: gerade nach unten
      outAngle = Math.PI / 2;
      fan      = Math.PI * 4 / 3;
    }

    memberIps.forEach((ip, i) => {
      const t     = n > 1 ? i / (n - 1) : 0.5;
      const angle = outAngle - fan / 2 + fan * t;
      targetPos[ip] = {
        x: cx + Math.cos(angle) * R,
        y: cy + Math.sin(angle) * R,
      };
    });
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const nodes = devices.map(d => {
    const isRouter  = d.ip === routerIp;
    const isMeshGw  = meshGateways.has(d.ip);
    const type      = isRouter ? 'router' : (d.iface || 'unknown');
    const target    = targetPos[d.ip];
    const prev      = pos[d.ip];
    return {
      id:      d.ip,
      label:   shortLabel(d),
      type,
      color:   C[type] || C.unknown,
      r:       isRouter ? 30 : isMeshGw ? 26 : 22,
      data:    d,
      x:       prev?.x ?? target?.x ?? w / 2 + (Math.random() - 0.5) * 80,
      y:       prev?.y ?? target?.y ?? h / 2 + (Math.random() - 0.5) * 80,
      targetX: target?.x,
      targetY: target?.y,
      fx:      isRouter ? ROUTER_FX : (isMeshGw ? gwPositions[d.ip]?.x ?? null : null),
      fy:      isRouter ? ROUTER_FY : (isMeshGw ? gwPositions[d.ip]?.y ?? null : null),
    };
  });

  // ── Links (mit Backbone-Flag für dickere Linien) ──────────────────────────
  const links = devices
    .filter(d => d.ip !== routerIp)
    .map(d => {
      const src        = (d.connectedVia && nodeIds.has(d.connectedVia)) ? d.connectedVia
                       : (d.vpnOf        && nodeIds.has(d.vpnOf))        ? d.vpnOf
                       : routerIp;
      const isBackbone = meshGateways.has(d.ip) && src === routerIp;
      return { source: src, target: d.ip, type: d.iface || 'unknown', isBackbone };
    });

  // ── Links rendern ─────────────────────────────────────────────────────────
  const linkSel = linksG.selectAll('line').data(links, d => `${d.source}->${d.target}`);
  linkSel.exit().remove();
  const linkAll = linkSel.enter().append('line').merge(linkSel);

  // Backbone (FritzBox↔OG/EG): dick, durchgezogen, blau
  // Gerät→Gateway:             mittel, gestrichelt je nach Typ
  // Gerät→Router:              dünn
  linkAll
    .attr('stroke',         d => d.isBackbone ? C.router : (C[d.type] || C.border))
    .attr('stroke-opacity', d => d.isBackbone ? 0.9 : 0.38)
    .attr('stroke-width',   d => d.isBackbone ? 5
                                : (meshGateways.has(d.source?.id || d.source) ? 2 : 1.5))
    .attr('stroke-dasharray', d => {
      if (d.isBackbone) return null;
      return d.type === 'wifi' ? '6,4' : d.type === 'vpn' ? '2,5' : null;
    })
    .attr('stroke-linecap', 'round');

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const nodeSel = nodesG.selectAll('g.mnode').data(nodes, d => d.id);
  nodeSel.exit().remove();

  const enter = nodeSel.enter().append('g').attr('class', 'mnode')
    .style('cursor', 'pointer')
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        if (d.type !== 'router') { d.fx = null; d.fy = null; }
      }))
    .on('click', (e, d) => {
      e.stopPropagation();
      selectedId = d.id;
      onSelect?.(d.data);
      applyHighlight();
    });

  // Äußerer Glüh-Ring (nur zur Auswahl sichtbar)
  enter.append('circle').attr('class', 'glow')
    .attr('fill', 'none').attr('stroke-width', 6).attr('stroke-opacity', 0);

  // Hauptkreis
  enter.append('circle').attr('class', 'body')
    .attr('stroke-width', 2);

  // Icon
  enter.append('use')
    .attr('width', 16).attr('height', 16)
    .attr('x', -8).attr('y', -8);

  // Label
  enter.append('text')
    .attr('text-anchor', 'middle')
    .attr('font-family', '-apple-system, Segoe UI, sans-serif')
    .attr('font-size', 11)
    .attr('fill', C.text)
    .style('pointer-events', 'none');

  // Merge: Attribute aktualisieren
  const all = enter.merge(nodeSel);

  all.select('circle.glow').attr('r', d => d.r + 5).attr('stroke', d => d.color);
  all.select('circle.body').attr('r', d => d.r).attr('fill', d => d.color + '1a').attr('stroke', d => d.color);
  all.select('use').attr('href', d => `#ico-${d.type}`).attr('color', d => d.color);
  all.select('text').attr('dy', d => d.r + 15).text(d => d.label);

  applyHighlight();

  // ── Simulation starten ────────────────────────────────────────────────────
  // Link-Kraft: rein visuell, kein Zug (Positionen kommen von position-Kraft)
  sim.force('link').distance(120).strength(0.02);

  // position-Kraft: zieht jeden Knoten zu seiner berechneten Kreisposition
  sim.force('position', (alpha) => {
    for (const node of sim.nodes()) {
      if (node.fx != null) continue; // fixe Knoten (Router, EG, OG) überspringen
      if (node.targetX == null) continue;
      const k = 0.35 * alpha;
      node.vx += (node.targetX - node.x) * k;
      node.vy += (node.targetY - node.y) * k;
    }
  });

  // Leichte Abstoßung damit Labels sich nicht überlappen
  sim.force('charge', d3.forceManyBody().strength(-80));

  // Schwache Zentrum-Kraft (verhindert Drift aus dem Viewport)
  sim.force('center', d3.forceCenter(w / 2, h * 0.5).strength(0.003));
  sim.force('cluster', null); // alte Cluster-Kraft entfernen

  sim.nodes(nodes).on('tick', () => {
    linksG.selectAll('line')
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodesG.selectAll('g.mnode')
      .attr('transform', d => `translate(${d.x},${d.y})`);
  });
  sim.force('link').links(links);
  sim.alpha(0.6).restart();
}

// ── Resize ─────────────────────────────────────────────────────────────────────
export function resizeMap(containerEl) {
  const rect = containerEl.getBoundingClientRect();
  w = rect.width || w;
  h = rect.height || h;
  sim?.force('center', d3.forceCenter(w / 2, h / 2)).alpha(0.1).restart();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
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
    .attr('fill', d => d.id === selectedId ? C.router : C.text)
    .attr('font-weight', d => d.id === selectedId ? 600 : 400);
}

function deselect() {
  selectedId = null;
  applyHighlight();
}
