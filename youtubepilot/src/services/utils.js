import fs from 'node:fs';

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

export function safeFileName(value) {
  return normalizeText(value)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}
