import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromFile } from 'file-type';
import { config } from '../config.js';

const RULES = {
  VIDEO: {
    mimes: new Set(['video/mp4','video/quicktime','video/webm','video/x-matroska']),
    extensions: new Set(['.mp4','.mov','.webm','.mkv']),
    directory: 'videos'
  },
  THUMBNAIL: {
    mimes: new Set(['image/jpeg','image/png','image/webp']),
    extensions: new Set(['.jpg','.jpeg','.png','.webp']),
    directory: 'thumbnails'
  },
  CAPTION: {
    mimes: new Set(['text/plain','application/x-subrip','text/vtt']),
    extensions: new Set(['.srt','.vtt']),
    directory: 'captions'
  }
};

export function safeName(value) {
  const cleaned = String(value || '').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 120) || 'file';
}

function displayName(value, fallback = 'file') {
  const base = path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 255) || fallback;
}

export function userRoot(userId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(userId))) throw new Error('Invalid user identifier.');
  return path.join(config.storageDir, 'users', String(userId));
}

export function userKindDir(userId, kind) {
  const rule = RULES[kind];
  if (!rule) throw new Error('Unsupported storage kind.');
  return path.join(userRoot(userId), rule.directory);
}

export function userScreenshotDir(userId) { return path.join(userRoot(userId), config.screenshotFolderName); }

export async function ensureUserStorage(userId) {
  await Promise.all([
    ...Object.keys(RULES).map(kind => fs.mkdir(userKindDir(userId, kind), { recursive: true, mode: 0o700 })),
    fs.mkdir(userScreenshotDir(userId), { recursive: true, mode: 0o700 })
  ]);
}

async function detectCaption(filePath, extension) {
  if (!['.srt','.vtt'].includes(extension)) return null;
  const buffer = await fs.readFile(filePath);
  if (buffer.length === 0 || buffer.includes(0)) return null;
  const text = buffer.toString('utf8');
  if (extension === '.vtt' && !/^WEBVTT/m.test(text)) return null;
  return extension === '.vtt' ? 'text/vtt' : 'application/x-subrip';
}

export async function saveUploadedFile(userId, kind, uploadedFile) {
  await ensureUserStorage(userId);
  const rule = RULES[kind];
  if (!rule) throw new Error('Unsupported upload type.');
  const extension = path.extname(uploadedFile.originalname).toLowerCase();
  const detected = kind === 'CAPTION'
    ? { mime: await detectCaption(uploadedFile.path, extension) }
    : await fileTypeFromFile(uploadedFile.path).catch(() => null);
  const mime = detected?.mime || '';
  if (!mime || !rule.mimes.has(mime) || !rule.extensions.has(extension)) {
    await fs.rm(uploadedFile.path, { force: true });
    const label = kind === 'VIDEO' ? 'MP4, MOV, WebM, or MKV' : kind === 'THUMBNAIL' ? 'JPG, PNG, or WebP' : 'SRT or VTT';
    throw new Error(`Unsupported ${kind.toLowerCase()} file. Upload ${label}.`);
  }
  const storedName = `${crypto.randomUUID()}${extension}`;
  const destination = path.join(userKindDir(userId, kind), storedName);
  await fs.copyFile(uploadedFile.path, destination);
  await fs.unlink(uploadedFile.path).catch(() => {});
  await fs.chmod(destination, 0o600).catch(() => {});
  return {
    kind,
    originalName: displayName(uploadedFile.originalname, kind.toLowerCase()),
    storedName,
    relativePath: path.relative(config.storageDir, destination),
    absolutePath: destination,
    mimeType: mime,
    sizeBytes: Number(uploadedFile.size || 0)
  };
}

export function absoluteStoragePath(relativePath) {
  const resolved = path.resolve(config.storageDir, String(relativePath || ''));
  const root = `${path.resolve(config.storageDir)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error('Invalid storage path.');
  return resolved;
}

export async function removeStoredFile(relativePath) {
  if (relativePath) await fs.rm(absoluteStoragePath(relativePath), { force: true });
}

export async function pruneUserScreenshots(userId, maxFiles = 120, maxAgeDays = 30) {
  const directory = userScreenshotDir(userId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat) files.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  files.sort((a,b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  await Promise.all(files.map((file,index) => index < maxFiles && file.mtimeMs >= cutoff ? Promise.resolve() : fs.rm(file.filePath, { force: true })));
}
