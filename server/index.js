const express  = require('express');
const cors     = require('cors');
const { scanNetwork } = require('./scanner');
const { loadCache, saveCache } = require('./cache');
const { loadCredentials, saveCredentials, clearCredentials, hasCredentials } = require('./credentials');
const { getFriendlyNames } = require('./fritzbox');
const { detectGateway, getLocalIp } = require('./scanner');

const app  = express();
const PORT = 3001;
let isScanning = false;

app.use(cors());
app.use(express.json());

// ── Zugangsdaten ──────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const creds = loadCredentials();
  res.json({ hasPassword: !!creds.password, username: creds.username });
});

app.post('/api/config', (req, res) => {
  const { username = '', password = '' } = req.body;
  if (password) {
    saveCredentials(username, password);
    res.json({ ok: true, message: 'Zugangsdaten gespeichert.' });
  } else {
    clearCredentials();
    res.json({ ok: true, message: 'Zugangsdaten gelöscht.' });
  }
});

app.post('/api/config/test', async (req, res) => {
  try {
    const localIp   = getLocalIp();
    const gatewayIp = await detectGateway(localIp);
    const names     = await getFriendlyNames(gatewayIp);
    const count     = Object.keys(names).length;
    if (count > 0) {
      res.json({ ok: true, message: `Verbindung erfolgreich — ${count} Gerätenamen geladen.` });
    } else {
      res.json({ ok: false, message: 'Verbindung hergestellt, aber keine Gerätenamen gefunden. Passwort prüfen.' });
    }
  } catch (e) {
    res.json({ ok: false, message: `Fehler: ${e.message}` });
  }
});

// ── Gecachte Geräteliste zurückgeben ──────────────────────────────────────────
app.get('/api/devices', (req, res) => {
  const cache = loadCache();
  res.json(cache ?? { devices: [], scannedAt: null });
});

// ── Live-Scan via SSE ─────────────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  if (isScanning) {
    res.status(409).json({ error: 'Scan läuft bereits' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  isScanning = true;
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  req.on('close', () => { isScanning = false; });

  // Geräte während des Scans sammeln, damit wir am Ende cachen können
  const collected = [];
  const byIp = {};

  try {
    await scanNetwork({
      onProgress: (pct)    => send('progress', { percent: pct }),
      onSources:  (info)   => send('sources', info),
      onDevice: (device) => {
        byIp[device.ip] = device;
        collected.push(device);
        send('device', device);
      },
      onVendor: (update) => {
        if (byIp[update.ip]) byIp[update.ip].vendor = update.vendor;
        send('vendor', update);
      },
      onNameUpdate: (update) => {
        if (byIp[update.ip]) {
          byIp[update.ip].customName    = update.customName;
          byIp[update.ip].customNameSrc = update.customNameSrc;
        }
        send('nameUpdate', update);
      },
      onPortScan: (update) => {
        if (byIp[update.ip]) byIp[update.ip].ports = update.ports;
        send('portScan', update);
      },
      onAlias: (update) => {
        if (byIp[update.ip]) {
          byIp[update.ip].aliasOf   = update.aliasOf;
          byIp[update.ip].aliasName = update.aliasName;
        }
        send('alias', update);
      },
    });

    const scannedAt = saveCache(collected);
    send('done', { scannedAt });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    isScanning = false;
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`homeScan Backend läuft auf http://localhost:${PORT}`);
});
