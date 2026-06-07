const { exec } = require('child_process');
const os = require('os');
const dns = require('dns').promises;
const { lookupVendor }           = require('./macLookup');
const { getHostMap, getMeshTopology } = require('./fritzbox');
const { getSsdpNames, grabHttpTitle, scanPorts, grabSshBanner, probeWebUrl } = require('./discover');

// ── OUI-Präfixe reiner WLAN-Chip-Hersteller ──────────────────────────────────
const WIFI_ONLY_OUI = new Set([
  '18:fe:34','24:0a:c4','2c:3a:e8','30:ae:a4','3c:71:bf','40:f5:20',
  '54:5a:a6','60:01:94','68:c6:3a','70:03:9f','80:7d:3a','84:0d:8e',
  '84:cc:a8','84:f3:eb','8c:aa:b5','90:97:d5','a0:20:a6','a4:7b:9d',
  'a4:cf:12','a4:e5:7c','ac:67:b2','b4:e6:2d','bc:dd:c2','cc:50:e3',
  'd8:a0:1d','dc:4f:22','e0:98:06','ec:62:60','f0:08:d1','fc:f5:c4',
  '00:90:cc','00:0e:2e','00:17:c4','00:50:7f',
]);

function ouiWifiHint(mac) {
  return WIFI_ONLY_OUI.has(mac.substring(0, 8).toLowerCase()) ? 'wifi' : null;
}

function rttHint(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms <= 1) return 'ethernet';
  if (ms >= 4) return 'wifi';
  return null;
}

// ── Netzwerk-Hilfsfunktionen ──────────────────────────────────────────────────

function getLocalIp() {
  let fallback = null;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) { fallback = fallback || addr.address; continue; }
      return addr.address;
    }
  }
  return fallback;
}

function getLocalDevice(localIp) {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && addr.address === localIp && addr.mac !== '00:00:00:00:00:00') {
        return { ip: addr.address, mac: addr.mac.toLowerCase() };
      }
    }
  }
  return null;
}

const IS_LINUX = process.platform === 'linux';

function detectGateway(localIp) {
  return new Promise((resolve) => {
    const cmd = IS_LINUX ? 'ip route show default' : 'route print 0.0.0.0';
    exec(cmd, (err, stdout) => {
      if (!err) {
        const m = IS_LINUX
          ? stdout.match(/default via (\d+\.\d+\.\d+\.\d+)/)
          : stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m) return resolve(m[1]);
      }
      resolve(localIp.split('.').slice(0, 3).join('.') + '.1');
    });
  });
}

function pingHost(ip) {
  return new Promise((resolve) => {
    const cmd = IS_LINUX ? `ping -c 1 -W 1 ${ip}` : `ping -n 1 -w 800 ${ip}`;
    exec(cmd, (err, stdout) => {
      if (err || !/TTL=/i.test(stdout)) { resolve({ alive: false, rtt: null }); return; }
      const m = stdout.match(/(?:[Zz]eit|time)([=<])(\d+\.?\d*)\s*ms/i);
      const rtt = m ? (m[1] === '<' ? 0 : parseFloat(m[2])) : 0;
      resolve({ alive: true, rtt });
    });
  });
}

async function pingSweep(localIp, onProgress) {
  const base = localIp.split('.').slice(0, 3).join('.');
  const ips  = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const BATCH = 30;
  const rttMap = {};
  for (let i = 0; i < ips.length; i += BATCH) {
    const results = await Promise.all(ips.slice(i, i + BATCH).map(async (ip) => {
      const r = await pingHost(ip);
      return { ip, ...r };
    }));
    for (const { ip, alive, rtt } of results) {
      if (alive) rttMap[ip] = rtt;
    }
    onProgress(Math.min(100, Math.round((i + BATCH) / ips.length * 100)));
  }
  return rttMap;
}

function readArpTable() {
  return new Promise((resolve, reject) => {
    // Linux: ip neigh show  →  "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
    // Windows: arp -a       →  "192.168.1.1   aa-bb-cc-dd-ee-ff   dynamic"
    const cmd = IS_LINUX ? 'ip neigh show' : 'arp -a';
    exec(cmd, (err, stdout) => {
      if (err) return reject(err);
      const devices = [];
      for (const line of stdout.split('\n')) {
        let ip, mac;
        if (IS_LINUX) {
          const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]{17})\s/i);
          if (!m) continue;
          ip = m[1]; mac = m[2].toLowerCase();
        } else {
          const m = line.match(
            /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})\s+(dynami[sc][ch]|stati[sc][ch])/i
          );
          if (!m) continue;
          ip = m[1]; mac = m[2].replace(/-/g, ':').toLowerCase();
        }
        if (
          mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') ||
          ip.startsWith('224.') || ip.startsWith('239.') ||
          ip.startsWith('255.') || ip.startsWith('169.254.')
        ) continue;
        devices.push({ ip, mac });
      }
      devices.sort((a, b) => {
        const ao = a.ip.split('.').map(Number);
        const bo = b.ip.split('.').map(Number);
        for (let i = 0; i < 4; i++) if (ao[i] !== bo[i]) return ao[i] - bo[i];
        return 0;
      });
      resolve(devices);
    });
  });
}

// DNS-Reverse-Lookup
async function resolveHostname(ip) {
  try { return (await dns.reverse(ip))[0] || null; }
  catch { return null; }
}

// NetBIOS-Name via nbtstat (nur Windows)
function getNbName(ip) {
  if (IS_LINUX) return Promise.resolve(null);
  return new Promise((resolve) => {
    exec(`nbtstat -A ${ip}`, { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const m = stdout.match(/^\s+(\S+)\s+<00>\s+(?:EINDEUTIG|UNIQUE)/im);
      resolve(m ? m[1].trim() : null);
    });
  });
}

// Gleiche MAC → mehrere IPs: alle außer der niedrigsten sind VPN/virtuelle Interfaces
function detectVpn(devices) {
  const byMac = {};
  for (const d of devices) {
    if (!byMac[d.mac]) byMac[d.mac] = [];
    byMac[d.mac].push(d.ip);
  }
  const vpnOf = {}; // vpn-ip → primary-ip
  for (const ips of Object.values(byMac)) {
    if (ips.length < 2) continue;
    ips.sort((a, b) => {
      const ao = a.split('.').map(Number);
      const bo = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (ao[i] !== bo[i]) return ao[i] - bo[i];
      return 0;
    });
    const primary = ips[0];
    for (const ip of ips.slice(1)) vpnOf[ip] = primary;
  }
  return vpnOf;
}

function resolveIface(mac, ip, hostMap, rttMap) {
  const fritzEntry = hostMap[mac];
  if (fritzEntry?.iface) return { iface: fritzEntry.iface, ifaceSrc: 'fritzbox' };
  const oui = ouiWifiHint(mac);
  if (oui)              return { iface: oui,               ifaceSrc: 'oui' };
  const rtt = rttHint(rttMap[ip]);
  if (rtt)              return { iface: rtt,               ifaceSrc: 'rtt' };
  return { iface: null, ifaceSrc: null };
}

// ── Haupt-Scan ────────────────────────────────────────────────────────────────

async function scanNetwork({ onProgress, onDevice, onVendor, onSources, onNameUpdate, onPortScan, onAlias, onWebUrl }) {
  const localIp = getLocalIp();
  if (!localIp) throw new Error('Kein Netzwerk-Interface gefunden');

  const gatewayIp = await detectGateway(localIp);

  // Phase 1: Ping-Sweep + SSDP parallel (ARP-Tabelle noch unbekannt)
  const [rttMap, ssdpNames] = await Promise.all([
    pingSweep(localIp, onProgress),
    getSsdpNames(3500),
  ]);

  // Phase 2a: ARP lesen, dann FritzBox mit allen MACs befragen (auch fehlende)
  const rawDevices = await readArpTable();
  const self = getLocalDevice(localIp);
  if (self && !rawDevices.find(d => d.ip === self.ip)) {
    rawDevices.push(self);
    rawDevices.sort((a, b) => {
      const ao = a.ip.split('.').map(Number), bo = b.ip.split('.').map(Number);
      for (let i = 0; i < 4; i++) if (ao[i] !== bo[i]) return ao[i] - bo[i];
      return 0;
    });
  }

  const allMacs = rawDevices.map(d => d.mac);
  const [hostMap, meshData] = await Promise.all([
    getHostMap(gatewayIp, allMacs),
    getMeshTopology(gatewayIp),
  ]);

  // MAC → IP und Name → IP für Mesh-Gateway-Auflösung
  const macToIp  = {};
  const nameToIp = {};
  rawDevices.forEach(d => { macToIp[d.mac] = d.ip; });
  Object.entries(hostMap).forEach(([mac, entry]) => {
    if (entry.name && macToIp[mac]) nameToIp[entry.name.toLowerCase()] = macToIp[mac];
  });

  const hasFritzbox = Object.keys(hostMap).length > 0;
  onSources({
    gateway:       gatewayIp,
    fritzbox:      hasFritzbox,
    meshNodeNames: meshData.meshNodeNames,
    rtt:           true,
    oui:           true,
  });

  // Phase 3: VPN-Erkennung + Namen + Interface parallel auflösen
  const vpnOf  = detectVpn(rawDevices);
  const nameless = [];

  await Promise.all(
    rawDevices.map(async (d) => {
      // VPN-Interface: kein DNS/NetBIOS nötig, sofort emittieren
      if (vpnOf[d.ip]) {
        onDevice({
          ...d,
          hostname:       null,
          customName:     'VPN-Tunnel',
          customNameSrc:  'vpn',
          vpnOf:          vpnOf[d.ip],
          iface:          'vpn',
          ifaceSrc:       'vpn',
        });
        return;
      }

      const fritzName = hostMap[d.mac]?.name || null;

      const [hostname, nbName] = await Promise.all([
        resolveHostname(d.ip),
        fritzName ? Promise.resolve(null) : getNbName(d.ip),
      ]);

      const ssdpName = ssdpNames[d.ip] || null;

      const customName    = fritzName || nbName || ssdpName || null;
      const customNameSrc = fritzName ? 'fritzbox'
                          : nbName   ? 'netbios'
                          : ssdpName ? 'ssdp'
                          : null;

      if (!customName && !hostname) nameless.push(d);

      const { iface, ifaceSrc } = resolveIface(d.mac, d.ip, hostMap, rttMap);
      // Mesh-Gateway: über welchen Repeater (EG/OG) ist das Gerät verbunden?
      const gwName = meshData.deviceToGatewayName[d.mac];
      const connectedVia = gwName ? (nameToIp[gwName.toLowerCase()] || null) : null;
      onDevice({ ...d, hostname, customName, customNameSrc, iface, ifaceSrc, connectedVia });
    })
  );

  // Phasen 3b + 3c + 3d: unabhängig voneinander → parallel ausführen
  const [bannerResults] = await Promise.all([
    // 3c: SSH-Banner für Alias-Erkennung (Rückgabe wird weiter unten gebraucht)
    Promise.all(
      rawDevices.map(async (d) => ({ ip: d.ip, mac: d.mac, banner: await grabSshBanner(d.ip) }))
    ),

    // 3b: HTTP-Titel + Port-Scan für namenlose Geräte
    Promise.all(nameless.map(async (d) => {
      const [title, ports] = await Promise.all([grabHttpTitle(d.ip), scanPorts(d.ip)]);
      if (title) onNameUpdate({ ip: d.ip, customName: title, customNameSrc: 'http' });
      if (ports.length) onPortScan({ ip: d.ip, ports });
    })),

    // 3d: Web-Interface-Erkennung für alle Nicht-VPN-Geräte
    Promise.all(
      rawDevices.filter(d => !vpnOf[d.ip]).map(async (d) => {
        const webUrl = await probeWebUrl(d.ip);
        if (webUrl) onWebUrl({ ip: d.ip, webUrl });
      })
    ),
  ]);
  const byBanner = {};
  for (const { ip, banner } of bannerResults) {
    if (!banner) continue;
    (byBanner[banner] ||= []).push(ip);
  }
  for (const ips of Object.values(byBanner)) {
    if (ips.length < 2) continue;
    // Primär = das Gerät mit bekanntem Namen im hostMap
    const primary = ips.find(ip => {
      const entry = bannerResults.find(r => r.ip === ip);
      return entry && hostMap[entry.mac]?.name;
    }) || ips[0];
    const primaryEntry = bannerResults.find(r => r.ip === primary);
    const primaryName  = primaryEntry ? (hostMap[primaryEntry.mac]?.name || null) : null;
    for (const ip of ips) {
      if (ip !== primary) onAlias({ ip, aliasOf: primary, aliasName: primaryName });
    }
  }

  // Phase 4: Hersteller sequenziell (Rate-Limit)
  for (const d of rawDevices) {
    const vendor = await lookupVendor(d.mac);
    onVendor({ ip: d.ip, vendor });
  }
}

module.exports = { scanNetwork, getLocalIp, detectGateway };
