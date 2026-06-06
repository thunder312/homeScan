const dgram  = require('dgram');
const http   = require('http');
const https  = require('https');
const net    = require('net');

// ── SSDP/UPnP ─────────────────────────────────────────────────────────────────

function ssdpSearch(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const socket  = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found   = new Map(); // ip → LOCATION url

    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 3\r\n' +
      'ST: ssdp:all\r\n\r\n'
    );

    socket.on('message', (data, rinfo) => {
      if (found.has(rinfo.address)) return;
      const m = data.toString().match(/^LOCATION:\s*(.+)$/im);
      if (m) found.set(rinfo.address, m[1].trim());
    });

    socket.on('error', () => resolve(found));

    socket.bind(0, () => {
      try { socket.send(msg, 0, msg.length, 1900, '239.255.255.250'); } catch {}
    });

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(found);
    }, timeoutMs);
  });
}

function fetchXml(url) {
  return new Promise((resolve) => {
    try {
      const u   = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      let body  = '';
      const req = mod.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname + u.search,
        method:   'GET', timeout: 2000,
        rejectUnauthorized: false,
      }, (res) => {
        res.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
        res.on('end', () => resolve(body));
      });
      req.on('error',   () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.end();
    } catch { resolve(''); }
  });
}

function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

async function getSsdpNames(timeoutMs = 3500) {
  const locations = await ssdpSearch(timeoutMs);
  const map       = {};
  await Promise.all([...locations.entries()].map(async ([ip, loc]) => {
    const xml  = await fetchXml(loc);
    const name = xmlVal(xml, 'friendlyName') || xmlVal(xml, 'modelName');
    if (name) map[ip] = name;
  }));
  return map; // ip → friendlyName
}

// ── HTTP-Titel ────────────────────────────────────────────────────────────────

function fetchTitle(ip, port, secure) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    let body  = '';
    const req = mod.request({
      hostname: ip, port,
      path: '/', method: 'GET', timeout: 2000,
      rejectUnauthorized: false,
    }, (res) => {
      res.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
      res.on('end', () => {
        const m = body.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
        resolve(m ? m[1].trim().replace(/\s+/g, ' ') : null);
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function fetchTitleFollowRedirect(ip, port, secure, depth = 0) {
  if (depth > 2) return Promise.resolve(null);
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    let body  = '';
    const req = mod.request({
      hostname: ip, port,
      path: '/', method: 'GET', timeout: 2000,
      rejectUnauthorized: false,
    }, (res) => {
      // Redirect folgen (Location mit gleicher IP)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try {
          const loc = new URL(res.headers.location, `http://${ip}`);
          const newPort   = loc.port ? parseInt(loc.port) : (loc.protocol === 'https:' ? 443 : 80);
          const newSecure = loc.protocol === 'https:';
          res.resume();
          return resolve(fetchTitleFollowRedirect(ip, newPort, newSecure, depth + 1));
        } catch {}
      }
      res.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
      res.on('end', () => {
        const m = body.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
        resolve(m ? m[1].trim().replace(/\s+/g, ' ') : null);
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function grabHttpTitle(ip) {
  const candidates = [
    { port: 80,   secure: false },
    { port: 8080, secure: false },
    { port: 5000, secure: false }, // Frigate, Home Assistant, diverse IoT
    { port: 443,  secure: true  },
    { port: 8443, secure: true  },
    { port: 8888, secure: false },
    { port: 9090, secure: false },
  ];
  const results = await Promise.all(candidates.map(p => fetchTitleFollowRedirect(ip, p.port, p.secure)));
  return results.find(r => r !== null) ?? null;
}

// ── Port-Scanner ──────────────────────────────────────────────────────────────

const PORT_SERVICES = {
  21:   'FTP',
  22:   'SSH',
  23:   'Telnet',
  80:   'HTTP',
  443:  'HTTPS',
  445:  'SMB',
  554:  'RTSP',        // Kameras, Streaming
  1883: 'MQTT',       // IoT-Hub
  3389: 'RDP',        // Windows Remote Desktop
  5000: 'UPnP',
  5900: 'VNC',
  8080: 'HTTP-alt',
  8443: 'HTTPS-alt',
  8883: 'MQTT-TLS',
  9100: 'Drucker',
  9090: 'Web-UI',
};

function isPortOpen(ip, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.on('error',   () => resolve(false));
    sock.connect(port, ip);
  });
}

async function scanPorts(ip) {
  const ports   = Object.keys(PORT_SERVICES).map(Number);
  const results = await Promise.all(ports.map(async (port) => {
    const open = await isPortOpen(ip, port);
    return open ? { port, service: PORT_SERVICES[port] } : null;
  }));
  return results.filter(Boolean);
}

// ── SSH-Banner ────────────────────────────────────────────────────────────────
// Eindeutig pro Maschine → gleicher Banner = gleicher Rechner, zweite Schnittstelle

function grabSshBanner(ip) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(800);
    s.on('data', (d) => {
      s.destroy();
      // Erste Zeile: "SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3"
      resolve(d.toString().split(/[\r\n]/)[0].trim() || null);
    });
    s.on('timeout', () => { s.destroy(); resolve(null); });
    s.on('error',   () => resolve(null));
    s.connect(22, ip);
  });
}

module.exports = { getSsdpNames, grabHttpTitle, scanPorts, grabSshBanner };
