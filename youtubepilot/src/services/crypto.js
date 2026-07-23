import crypto from 'node:crypto';

function keyFromEnv() {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) throw new Error('SESSION_ENCRYPTION_KEY is required.');

  const candidates = [];
  if (/^[a-f0-9]{64}$/i.test(raw)) candidates.push(Buffer.from(raw, 'hex'));
  try { candidates.push(Buffer.from(raw, 'base64')); } catch {}
  candidates.push(Buffer.from(raw, 'utf8'));

  const key = candidates.find(candidate => candidate.length === 32);
  if (!key) {
    throw new Error('SESSION_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded or 64 hex characters.');
  }
  return key;
}

export function encryptJson(value) {
  const key = keyFromEnv();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptJson(payload) {
  if (!payload || typeof payload !== 'string') throw new Error('Encrypted session is missing.');
  const [version, ivPart, tagPart, dataPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('Encrypted session format is invalid.');
  }
  const key = keyFromEnv();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
