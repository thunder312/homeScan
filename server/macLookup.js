const https = require('https');

const cache = new Map();
const RATE_LIMIT_MS = 1150;
let lastRequest = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function lookupVendor(mac) {
  // Use first 3 octets (OUI prefix) as cache key
  const prefix = mac.substring(0, 8).toUpperCase();
  if (cache.has(prefix)) return cache.get(prefix);

  const wait = RATE_LIMIT_MS - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  try {
    const { status, body } = await httpsGet(
      `https://api.macvendors.com/${encodeURIComponent(prefix)}`
    );
    const vendor = status === 200 ? body.trim() : null;
    cache.set(prefix, vendor);
    return vendor;
  } catch {
    cache.set(prefix, null);
    return null;
  }
}

module.exports = { lookupVendor };
