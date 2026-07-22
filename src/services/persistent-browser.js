import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { query } from '../db.js';
import { addLog } from './logs.js';

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LOCK_TTL_MS = 10 * 60_000;
const LOCK_HEARTBEAT_MS = 20_000;
const CHROMIUM_SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

export function assertUuid(value, label = 'identifier') {
  if (!UUID_PATTERN.test(String(value || ''))) throw new Error(`Invalid ${label}.`);
}

export function browserProfileRoot() {
  return path.resolve(config.browserProfileRoot);
}

export function browserProfileDir(userId, channelId) {
  assertUuid(userId, 'user identifier');
  assertUuid(channelId, 'channel identifier');
  const root = browserProfileRoot();
  const resolved = path.resolve(root, String(userId), String(channelId));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Invalid browser profile path.');
  return resolved;
}

export async function ensurePersistentBrowserStorage() {
  const root = browserProfileRoot();
  const storageRoot = path.resolve(config.storageDir);
  if (root !== storageRoot && !root.startsWith(`${storageRoot}${path.sep}`)) {
    const error = new Error(`Browser profile root must be inside persistent storage: ${storageRoot}`);
    error.code = 'BROWSER_PROFILE_STORAGE_UNAVAILABLE';
    throw error;
  }
  await fs.mkdir(root, { recursive:true, mode:0o700 });
  const probe = path.join(root, `.write-test-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(probe, 'ok', { mode:0o600 });
    await fs.rm(probe, { force:true });
  } catch (cause) {
    const error = new Error(`Persistent browser storage is not writable at ${root}.`);
    error.code = 'BROWSER_PROFILE_STORAGE_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
  return { status:'healthy', path:root };
}

export async function ensureChannelProfile(userId, channelId) {
  await ensurePersistentBrowserStorage();
  const directory = browserProfileDir(userId, channelId);
  await fs.mkdir(directory, { recursive:true, mode:0o700 });
  await fs.chmod(path.dirname(directory), 0o700).catch(() => {});
  await fs.chmod(directory, 0o700).catch(() => {});
  return directory;
}

export async function persistentBrowserStorageHealth() {
  try {
    return await ensurePersistentBrowserStorage();
  } catch (error) {
    return { status:'unavailable', path:browserProfileRoot(), error:error.message, errorCode:error.code || 'BROWSER_PROFILE_STORAGE_UNAVAILABLE' };
  }
}

export async function acquireBrowserLock({ userId, channelId, owner, metadata = {}, ttlMs = LOCK_TTL_MS }) {
  assertUuid(userId, 'user identifier');
  assertUuid(channelId, 'channel identifier');
  const token = crypto.randomUUID();
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  const result = await query(
    `INSERT INTO youtube_browser_locks (channel_id,user_id,lock_token,owner,heartbeat_at,expires_at,metadata,updated_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW() + ($5 || ' seconds')::interval,$6::jsonb,NOW())
     ON CONFLICT (channel_id) DO UPDATE SET
       user_id=EXCLUDED.user_id,
       lock_token=EXCLUDED.lock_token,
       owner=EXCLUDED.owner,
       heartbeat_at=NOW(),
       expires_at=EXCLUDED.expires_at,
       metadata=EXCLUDED.metadata,
       updated_at=NOW()
     WHERE youtube_browser_locks.expires_at < NOW()
     RETURNING channel_id,user_id,lock_token,owner,expires_at`,
    [channelId,userId,token,owner,ttlSeconds,JSON.stringify(metadata)]
  );
  if (!result.rowCount) {
    const error = new Error('Channel browser is currently in use. Try again when the active login, verification, or upload session finishes.');
    error.code = 'BROWSER_PROFILE_LOCKED';
    throw error;
  }
  let released = false;
  const heartbeat = setInterval(() => {
    void query(
      `UPDATE youtube_browser_locks SET heartbeat_at=NOW(),expires_at=NOW() + ($3 || ' seconds')::interval,updated_at=NOW()
       WHERE channel_id=$1 AND lock_token=$2`,
      [channelId,token,ttlSeconds]
    ).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  await addLog(userId, 'info', 'Browser profile lock acquired.', { channelId, browserMode:owner, event:'browser_lock_acquired' }).catch(() => {});
  return {
    token,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      const result = await query('DELETE FROM youtube_browser_locks WHERE channel_id=$1 AND lock_token=$2', [channelId,token]);
      await addLog(userId, result.rowCount ? 'info' : 'warning', result.rowCount ? 'Browser profile lock released.' : 'Browser profile lock was already gone.', {
        channelId,
        browserMode:owner,
        event:result.rowCount ? 'browser_lock_released' : 'profile_lock_release_failed'
      }).catch(() => {});
    }
  };
}

async function readSingletonTarget(lockPath) {
  try {
    return await fs.readlink(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    if (error?.code !== 'EINVAL') throw error;
    return fs.readFile(lockPath, 'utf8').catch(() => '');
  }
}

function parseSingletonTarget(target) {
  const match = String(target || '').trim().match(/^(.+)-(\d+)$/);
  if (!match) return { host:'', pid:0 };
  return { host:match[1], pid:Number(match[2]) };
}

function isProcessRunning(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function processCommand(pid) {
  if (!pid || process.platform === 'win32') return '';
  return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then(text => text.replace(/\0/g, ' ')).catch(() => '');
}

async function waitForProcessExit(pid, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return !isProcessRunning(pid);
}

async function terminateProfileProcess(pid, profileDir) {
  const command = await processCommand(pid);
  const normalized = path.resolve(profileDir);
  const ownsProfile = command.includes(normalized) && /chrome|chromium|ms-playwright/i.test(command);
  if (!ownsProfile) return false;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (!(await waitForProcessExit(pid, 3000))) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await waitForProcessExit(pid, 2000);
  }
  return !isProcessRunning(pid);
}

async function clearChromiumSingletonFiles(profileDir) {
  await Promise.all(CHROMIUM_SINGLETON_FILES.map(file => fs.rm(path.join(profileDir, file), { recursive:true, force:true }).catch(() => {})));
}

export async function recoverStaleChromiumProfileLock({ userId, channelId, profileDir, mode, logEvents = true }) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  const target = await readSingletonTarget(lockPath);
  if (!target) return false;
  const { host, pid } = parseSingletonTarget(target);
  const sameHost = !host || host === os.hostname();
  if (sameHost && isProcessRunning(pid)) {
    const terminated = await terminateProfileProcess(pid, profileDir);
    if (!terminated) {
      const error = new Error('The YouTube Studio browser profile is already open. Close the active secure browser window, then try again.');
      error.code = 'BROWSER_PROFILE_LOCKED';
      throw error;
    }
    if (logEvents) await addLog(userId, 'warning', 'Recovered a stale Chromium browser process for the channel profile.', {
      channelId,
      browserMode:mode,
      event:'browser_profile_process_recovered'
    }).catch(() => {});
  }
  await clearChromiumSingletonFiles(profileDir);
  if (logEvents) await addLog(userId, 'warning', 'Cleared a stale Chromium profile lock before opening YouTube Studio.', {
    channelId,
    browserMode:mode,
    event:'browser_profile_lock_recovered'
  }).catch(() => {});
  return true;
}

export async function launchYouTubePersistentContext({ userId, channelId, mode, headless, timezoneId = 'Asia/Kolkata', locale = 'en-US' }) {
  const profileDir = await ensureChannelProfile(userId, channelId);
  await recoverStaleChromiumProfileLock({ userId, channelId, profileDir, mode });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    locale,
    timezoneId,
    viewport:{ width:1440, height:900 },
    acceptDownloads:false,
    env:{ ...process.env, DISPLAY:config.display },
    args:[
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-features=Translate',
      '--disable-notifications',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      '--window-size=1440,900'
    ]
  });
  await addLog(userId, 'info', 'Browser profile opened.', { channelId, browserMode:mode, event:'browser_profile_opened' }).catch(() => {});
  const close = context.close.bind(context);
  context.close = async (...args) => {
    try {
      return await close(...args);
    } finally {
      await addLog(userId, 'info', 'Browser profile closed.', { channelId, browserMode:mode, event:'browser_profile_closed' }).catch(() => {});
    }
  };
  return { context, profileDir };
}

export async function seedPersistentProfileFromStorageState(profileDir, context, storageState) {
  if (!storageState?.cookies?.length) return false;
  const cookiesPath = path.join(profileDir, 'Default', 'Cookies');
  const hasPersistentCookies = await fs.stat(cookiesPath).then(stat => stat.isFile() && stat.size > 0).catch(() => false);
  if (hasPersistentCookies) return false;
  await context.addCookies(storageState.cookies).catch(() => {});
  return true;
}

export async function archiveChannelProfile(userId, channelId) {
  const directory = browserProfileDir(userId, channelId);
  const exists = await fs.stat(directory).then(stat => stat.isDirectory()).catch(() => false);
  if (!exists) return '';
  const archived = `${directory}.archived-${Date.now()}`;
  await fs.rename(directory, archived);
  await fs.chmod(archived, 0o700).catch(() => {});
  return path.basename(archived);
}
