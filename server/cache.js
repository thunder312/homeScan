const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'cache.json');

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null; // kein Cache vorhanden
  }
}

function saveCache(devices) {
  const payload = { devices, scannedAt: new Date().toISOString() };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload.scannedAt;
}

module.exports = { loadCache, saveCache };
