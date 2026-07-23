import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium as playwrightChromium } from 'playwright';
import { config } from '../config.js';
import { userRoot } from './storage.js';

const lockedProfiles = new Set();

function playwrightBrowserCacheExecutables(root) {
  if (!root || !fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^chromium-/i.test(entry.name))
      .flatMap(entry => {
        const browserRoot = path.join(root, entry.name);
        return [
          path.join(browserRoot, 'chrome-linux', 'chrome'),
          path.join(browserRoot, 'chrome-win64', 'chrome.exe'),
          path.join(browserRoot, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
        ];
      });
  } catch {
    return [];
  }
}

export function browserExecutableCandidates(env = process.env) {
  const candidates = [
    env.VISIBLE_CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  try { candidates.push(playwrightChromium.executablePath()); } catch {}
  candidates.push(...playwrightBrowserCacheExecutables(env.PLAYWRIGHT_BROWSERS_PATH));
  candidates.push(...playwrightBrowserCacheExecutables('/ms-playwright'));
  return [...new Set(candidates.filter(Boolean))];
}

export function visibleBrowserExecutable() {
  const found = browserExecutableCandidates().find(candidate => fs.existsSync(candidate));
  if (!found) {
    const error = new Error('A Chrome or Chromium browser is not installed for the secure login window.');
    error.code = 'BROWSER_LAUNCH_FAILED';
    throw error;
  }
  return found;
}

export function userBrowserProfileDir(userId) {
  return path.join(userRoot(userId), 'chrome-profile');
}

export async function ensureUserBrowserProfile(userId) {
  const directory = userBrowserProfileDir(userId);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
  return directory;
}

export async function removeUserBrowserProfile(userId) {
  await fsp.rm(userBrowserProfileDir(userId), { recursive: true, force: true });
}

export function acquireUserBrowserProfile(userId) {
  const key = String(userId);
  if (lockedProfiles.has(key)) {
    const error = new Error('This YouTube browser profile is already in use. Wait for the current login or upload to finish, then try again.');
    error.code = 'BROWSER_PROFILE_BUSY';
    throw error;
  }
  lockedProfiles.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockedProfiles.delete(key);
  };
}

export function stableChromeArgs(locale = config.browserLocale) {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-notifications',
    '--window-size=1440,1000',
    '--start-maximized',
    `--lang=${locale || config.browserLocale}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-blink-features=AutomationControlled',
    '--password-store=basic',
    '--use-mock-keychain'
  ];
}

export function stableChromeEnv(timezone = config.browserTimezone) {
  return {
    ...process.env,
    DISPLAY: config.display,
    TZ: timezone || config.browserTimezone,
    LANG: 'C.UTF-8',
    LANGUAGE: 'en_US:en',
    LC_ALL: 'C.UTF-8'
  };
}

export async function restoreBrowserCookies(context, storageState) {
  if (!storageState?.cookies?.length) return;
  await context.addCookies(storageState.cookies).catch(() => {});
}
