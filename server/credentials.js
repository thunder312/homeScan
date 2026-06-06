const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

const CRED_FILE = path.join(__dirname, '.credentials');

// Schlüssel wird aus maschinenspezifischen Daten abgeleitet — nie gespeichert
function deriveKey() {
  const material = `${os.hostname()}-${os.userInfo().username || 'user'}`;
  return crypto.scryptSync(material, 'homeScan-local-v1', 32);
}

function encrypt(plaintext) {
  const key    = deriveKey();
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return JSON.stringify({ iv: iv.toString('hex'), enc: enc.toString('hex'), tag: tag.toString('hex') });
}

function decrypt(data) {
  const { iv, enc, tag } = JSON.parse(data);
  const key      = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(Buffer.from(enc, 'hex')) + decipher.final('utf8');
}

function loadCredentials() {
  // Erst verschlüsselte Datei prüfen
  if (fs.existsSync(CRED_FILE)) {
    try {
      return JSON.parse(decrypt(fs.readFileSync(CRED_FILE, 'utf8')));
    } catch { /* korrupt → ignorieren */ }
  }
  // Fallback: Klartext config.json (für Migration)
  const configFile = path.join(__dirname, 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (cfg.fritzbox?.password) return { username: cfg.fritzbox.username || '', password: cfg.fritzbox.password };
    } catch {}
  }
  return { username: '', password: '' };
}

function saveCredentials(username, password) {
  const payload = JSON.stringify({ username, password });
  fs.writeFileSync(CRED_FILE, encrypt(payload), 'utf8');
}

function clearCredentials() {
  if (fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE);
}

function hasCredentials() {
  const c = loadCredentials();
  return !!c.password;
}

module.exports = { loadCredentials, saveCredentials, clearCredentials, hasCredentials };
