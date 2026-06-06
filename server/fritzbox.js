const http   = require('http');
const crypto = require('crypto');
const { loadCredentials } = require('./credentials');

function loadCreds() { return loadCredentials(); }

// ── HTTP Digest Auth ──────────────────────────────────────────────────────────

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function parseDigestChallenge(header) {
  const get = (k) => header.match(new RegExp(`${k}="([^"]+)"`))?.[1] || '';
  return { realm: get('realm'), nonce: get('nonce'), qop: get('qop'), opaque: get('opaque') };
}

function buildDigestHeader(method, uri, challenge, username, password) {
  const { realm, nonce, qop, opaque } = challenge;
  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1    = md5(`${username}:${realm}:${password}`);
  const ha2    = md5(`${method}:${uri}`);
  const resp   = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"` +
    (qop    ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') +
    `, response="${resp}"` +
    (opaque ? `, opaque="${opaque}"` : '');
}

function buildSoap(action, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="urn:dslforum-org:service:Hosts:1">${inner}</u:${action}>
  </s:Body>
</s:Envelope>`;
}

function post(ip, payload, action) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(payload, 'utf8');
    const req = http.request({
      hostname: ip, port: 49000,
      path: '/upnp/control/hosts',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"urn:dslforum-org:service:Hosts:1#${action}"`,
        'Content-Length': buf.length,
      },
      timeout: 2000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(buf); req.end();
  });
}

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]*:)?${tag}>([^<]*)<`));
  return m ? m[1].trim() : null;
}

async function getHostCount(ip) {
  const { status, body } = await post(ip, buildSoap('GetHostNumberOfEntries', ''), 'GetHostNumberOfEntries');
  if (status !== 200) return 0;
  return parseInt(xmlVal(body, 'NewHostNumberOfEntries') || '0', 10);
}

async function getHostAtIndex(ip, index) {
  const { status, body } = await post(
    ip,
    buildSoap('GetGenericHostEntry', `<NewIndex>${index}</NewIndex>`),
    'GetGenericHostEntry'
  );
  if (status !== 200) return null;
  const mac   = xmlVal(body, 'NewMACAddress');
  const iface = xmlVal(body, 'NewInterfaceType');
  const name  = xmlVal(body, 'NewHostName') || null;
  if (!mac) return null;
  return {
    mac:   mac.toLowerCase().replace(/-/g, ':'),
    iface: iface?.includes('802.11') ? 'wifi'
         : iface === 'Ethernet'      ? 'ethernet'
         : null,
    name,
  };
}

// ── Authenticated request (Digest) ───────────────────────────────────────────

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(body, 'utf8') : null;
    if (buf && options.headers) options.headers['Content-Length'] = buf.length;
    const req = http.request({ timeout: 3000, ...options }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (buf) req.write(buf);
    req.end();
  });
}

async function authPost(ip, path, soapAction, payload, creds) {
  const opts = {
    hostname: ip, port: 49000, path, method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': `"${soapAction}"` },
  };
  // Erster Versuch ohne Auth
  const r1 = await httpRequest(opts, payload);
  if (r1.status !== 401) return r1;
  if (!creds.password) return r1; // kein Passwort → gib 401 zurück

  // Digest-Challenge auswerten und erneut versuchen
  const challenge = parseDigestChallenge(r1.headers['www-authenticate'] || '');
  const authHeader = buildDigestHeader('POST', path, challenge, creds.username, creds.password);
  const opts2 = { ...opts, headers: { ...opts.headers, Authorization: authHeader } };
  return httpRequest(opts2, payload);
}

async function authGet(ip, urlPath, creds, timeoutMs = 3000) {
  const opts = { hostname: ip, port: 49000, path: urlPath, method: 'GET', headers: {}, timeout: timeoutMs };
  const r1 = await httpRequest(opts);
  if (r1.status !== 401 || !creds.password) return r1;
  const challenge = parseDigestChallenge(r1.headers['www-authenticate'] || '');
  const authHeader = buildDigestHeader('GET', urlPath, challenge, creds.username, creds.password);
  return httpRequest({ ...opts, headers: { Authorization: authHeader } });
}

// Vollständige Host-Liste via AVM-Auth → map: mac → { name, iface }
// Enthält ALLE Geräte mit FriendlyName + Interface-Typ in 2 Requests statt 60+
async function getFullHostList(routerIp) {
  const creds = loadCreds();
  if (!creds.password) return null; // kein Auth → Fallback

  try {
    const soap = buildSoap('X_AVM-DE_GetHostListPath', '');
    const r = await authPost(routerIp, '/upnp/control/hosts',
      'urn:dslforum-org:service:Hosts:1#X_AVM-DE_GetHostListPath', soap, creds);
    if (r.status !== 200) return null;

    const pathMatch = r.body.match(/<NewX_AVM-DE_HostListPath>([^<]+)/);
    if (!pathMatch) return null;

    const listResp = await authGet(routerIp, pathMatch[1], creds);
    if (listResp.status !== 200) return null;

    const map = {};
    for (const m of listResp.body.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const item  = m[1];
      const mac   = item.match(/<MACAddress>([^<]+)/)?.[1]?.toLowerCase().replace(/-/g, ':');
      const name  = item.match(/<X_AVM-DE_FriendlyName>([^<]+)/)?.[1]?.trim() || null;
      const iface = item.match(/<InterfaceType>([^<]+)/)?.[1]?.trim();
      if (!mac) continue;
      map[mac] = {
        name,
        iface: iface?.includes('802.11') ? 'wifi' : iface === 'Ethernet' ? 'ethernet' : null,
      };
    }
    return Object.keys(map).length ? map : null;
  } catch { return null; }
}

// Fallback ohne Auth: Index-basiert (weniger vollständig)
async function getHostMapFallback(routerIp, extraMacs = []) {
  const count = await getHostCount(routerIp);
  if (!count) return {};

  const results = await Promise.all(
    Array.from({ length: count }, (_, i) => getHostAtIndex(routerIp, i).catch(() => null))
  );
  const map = {};
  for (const h of results) {
    if (!h?.mac) continue;
    map[h.mac] = { iface: h.iface, name: h.name };
  }

  // Fehlende MACs direkt abfragen
  const missing = extraMacs.filter(m => !map[m]);
  await Promise.all(missing.map(async (mac) => {
    const normalized = mac.toUpperCase();
    try {
      const { status, body } = await post(
        routerIp,
        buildSoap('GetSpecificHostEntry', `<NewMACAddress>${normalized}</NewMACAddress>`),
        'GetSpecificHostEntry'
      );
      if (status !== 200) return;
      const iface = xmlVal(body, 'NewInterfaceType');
      map[mac] = {
        iface: iface?.includes('802.11') ? 'wifi' : iface === 'Ethernet' ? 'ethernet' : null,
        name:  xmlVal(body, 'NewHostName') || null,
      };
    } catch {}
  }));
  return map;
}

// Hauptfunktion: Auth-Liste bevorzugen (2 Requests), sonst Fallback (60+ Requests)
async function getHostMap(routerIp, extraMacs = []) {
  try {
    const full = await getFullHostList(routerIp);
    if (full) return full; // Auth erfolgreich → vollständige Daten
    return await getHostMapFallback(routerIp, extraMacs);
  } catch {
    return {};
  }
}

// Für /api/config/test und Settings-Dialog
async function getFriendlyNames(routerIp) {
  const map = await getFullHostList(routerIp);
  if (!map) return {};
  const names = {};
  for (const [mac, { name }] of Object.entries(map)) {
    if (name) names[mac] = name;
  }
  return names;
}

// Mesh-Topologie: welches Gerät hängt an welchem Mesh-Knoten (EG/OG/Router)
// Gibt zurück: { deviceToGatewayName: {mac→name}, meshNodeNames: ['OG','EG',...] }
async function getMeshTopology(routerIp) {
  const empty = { deviceToGatewayName: {}, meshNodeNames: [] };
  const creds = loadCreds();
  if (!creds.password) return empty;

  try {
    const soap = buildSoap('X_AVM-DE_GetMeshListPath', '');
    const r = await authPost(routerIp, '/upnp/control/hosts',
      'urn:dslforum-org:service:Hosts:1#X_AVM-DE_GetMeshListPath', soap, creds);
    if (r.status !== 200) return empty;

    const pm = r.body.match(/<NewX_AVM-DE_MeshListPath>([^<]+)/);
    if (!pm) return empty;

    // Mesh-JSON kann gross sein (>200KB) → längerer Timeout
    const lr = await authGet(routerIp, pm[1], creds, 15000);
    if (lr.status !== 200) return empty;

    const mesh = JSON.parse(lr.body);
    const norm = (m) => (m || '').toLowerCase().replace(/-/g, ':');

    // UID → Node Lookup
    const byUid = {};
    (mesh.nodes || []).forEach(n => { byUid[n.uid] = n; });

    // Slave-Knoten identifizieren (EG, OG etc.)
    const slaves = (mesh.nodes || []).filter(n => n.mesh_role === 'slave');
    const meshNodeNames = slaves.map(n => n.device_friendly_name || n.device_name || '');

    // Für jeden Slave: welche Geräte sind verbunden?
    const deviceToGatewayName = {};
    for (const slave of slaves) {
      const gwName = slave.device_friendly_name || slave.device_name;
      for (const iface of slave.node_interfaces || []) {
        for (const link of iface.node_links || []) {
          if (link.state !== 'CONNECTED') continue;
          const otherUid = link.node_1_uid === slave.uid ? link.node_2_uid : link.node_1_uid;
          const other = byUid[otherUid];
          if (!other || other.mesh_role === 'slave' || other.mesh_role === 'master') continue;
          const devMac = norm(other.device_mac_address);
          if (devMac) deviceToGatewayName[devMac] = gwName;
        }
      }
    }
    return { deviceToGatewayName, meshNodeNames };
  } catch (err) {
    console.error('[getMeshTopology]', err.message);
    return empty;
  }
}

module.exports = { getHostMap, getFriendlyNames, getMeshTopology };
