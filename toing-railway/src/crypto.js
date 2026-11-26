import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENC_PREFIX = 'enc:v1:';
const SCRYPT_SALT = 'toing-railway-tg-session-salt-v1';

// Resolves a 32-byte AES-256-GCM key:
//   1. VAULT_ENCRYPTION_KEY env (recommended on Railway)
//   2. Persistent auto-generated key file at <dataDir>/.master.key (0600)
// Sessions are NEVER written in plaintext to SQLite.
export function resolveMasterKey({ envKey = '', dataDir = '' } = {}) {
  const fromEnv = String(envKey || '').trim();
  if (fromEnv) {
    return {
      key: crypto.scryptSync(fromEnv, SCRYPT_SALT, 32),
      source: 'env',
    };
  }
  if (!dataDir) {
    throw new Error('VAULT_ENCRYPTION_KEY or dataDir is required for session encryption');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, '.master.key');
  let raw = '';
  try {
    raw = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {}
  if (!raw || raw.length < 32) {
    raw = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, `${raw}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch {}
  }
  return {
    key: crypto.scryptSync(raw, SCRYPT_SALT, 32),
    source: 'file',
    keyFile,
  };
}

export function encryptSecret(plaintext, keyBuf) {
  const text = String(plaintext ?? '');
  if (!text) return '';
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw new Error('Invalid 32-byte encryption key');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(encoded, keyBuf) {
  const raw = String(encoded ?? '');
  if (!raw) return '';
  if (!raw.startsWith(ENC_PREFIX)) {
    throw new Error('Secret is not encrypted with expected v1 envelope');
  }
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
    throw new Error('Invalid 32-byte encryption key');
  }
  const parts = raw.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret envelope');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// Non-reversible fingerprint so we can dedupe/display sessions without ever logging them.
export function sessionFingerprint(session = '') {
  const s = String(session || '').trim();
  if (!s) return '';
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}
