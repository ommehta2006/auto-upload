import { spawn } from 'node:child_process';
import net from 'node:net';
import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
playwrightChromium.use(stealthPlugin());
const chromium = playwrightChromium;
import { config } from '../config.js';
import { query } from '../db.js';
import { decryptJson, encryptJson, randomToken } from './crypto.js';
import { addLog } from './logs.js';
import {
  acquireUserBrowserProfile,
  ensureUserBrowserProfile,
  removeUserBrowserProfile,
  restoreBrowserCookies,
  stableChromeArgs,
  stableChromeEnv,
  visibleBrowserExecutable
} from './chrome-runtime.js';

let activeSession = null;

function waitForPort(host, port, timeoutMs = 9000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(750);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      const retry = () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) return reject(new Error(`Remote browser service did not start on port ${port}.`));
        setTimeout(attempt, 200);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function stopProcess(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000).unref();
}

async function closeActive(reason = 'closed') {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  clearTimeout(session.timeout);
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
  stopProcess(session.x11vnc);
  session.releaseProfile?.();
  await addLog(session.userId, 'info', 'YouTube connection window closed.', { reason });
}

async function startRemoteDesktop(accessToken) {
  const x11vnc = spawn('x11vnc', ['-display',config.display,'-rfbport',String(config.vncPort),'-localhost','-forever','-shared','-nopw','-noxdamage','-quiet'], { stdio: ['ignore','ignore','pipe'] });
  x11vnc.stderr?.on('data', data => console.error(`[x11vnc] ${String(data).trim()}`));
  try {
    await waitForPort(config.vncHost, config.vncPort);
    return { x11vnc };
  } catch (error) {
    stopProcess(x11vnc);
    throw error;
  }
}

function remoteUrl(accessToken) {
  const url = new URL(config.noVncPublicUrl);
  url.searchParams.set('autoconnect','true');
  url.searchParams.set('resize','scale');
  url.searchParams.set('reconnect','true');
  url.searchParams.set('path','remote/websockify');
  url.searchParams.set('token',accessToken);
  return url.toString();
}

async function studioLooksAuthenticated(page) {
  const url = page.url().toLowerCase();
  if (url.includes('accounts.google.com') || url.includes('servicelogin')) return false;
  const signIn = await page.getByText(/sign in/i, { exact: true }).first().isVisible().catch(() => false);
  if (signIn) return false;
  return page.locator('#avatar-btn, ytcp-button#create-icon, #create-icon, ytcp-channel-name, #channel-name').first().isVisible({ timeout: 5000 }).catch(() => false);
}

export async function startYouTubeLogin(userId) {
  if (activeSession) {
    if (activeSession.userId === userId) return { remoteUrl: activeSession.remoteUrl, expiresAt: activeSession.expiresAt, alreadyActive: true };
    throw new Error('Another YouTube connection is currently in progress. Try again after it finishes.');
  }
  const accountResult = await query(
    `INSERT INTO youtube_accounts (user_id,status) VALUES ($1,'CONNECTING')
     ON CONFLICT (user_id) DO UPDATE SET status='CONNECTING',last_error=NULL,updated_at=NOW() RETURNING *`, [userId]
  );
  const account = accountResult.rows[0];
  let remote; let browser; let context; let profileDir; let releaseProfile;
  try {
    const existingState = account.encrypted_state ? decryptJson(account.encrypted_state) : undefined;
    const accessToken = randomToken(18);
    releaseProfile = acquireUserBrowserProfile(userId);
    profileDir = await ensureUserBrowserProfile(userId);
    remote = await startRemoteDesktop(accessToken);
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: visibleBrowserExecutable(),
      ignoreDefaultArgs: ['--enable-automation'],
      env: stableChromeEnv(),
      args: stableChromeArgs(),
      locale:config.browserLocale,
      timezoneId:config.browserTimezone,
      viewport:{ width:1440,height:1000 }
    });
    browser = context.browser();
    await restoreBrowserCookies(context, existingState);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    const expiresAt = new Date(Date.now() + config.loginSessionMinutes * 60_000);
    const url = remoteUrl(accessToken);
    const timeout = setTimeout(async () => {
      await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,last_error='YouTube connection window expired.',updated_at=NOW() WHERE user_id=$1`, [userId]).catch(() => {});
      await closeActive('expired');
    }, config.loginSessionMinutes * 60_000);
    timeout.unref();
    activeSession = { userId, accountId:account.id, browser, context, page, profileDir, releaseProfile, ...remote, remoteUrl:url, accessToken, expiresAt, timeout };
    await addLog(userId,'info','YouTube connection window opened.',{ expiresAt });
    return { remoteUrl:url, expiresAt, alreadyActive:false };
  } catch (error) {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
    stopProcess(remote?.x11vnc);
    releaseProfile?.();
    await query(`UPDATE youtube_accounts SET status='ERROR',last_error=$2,updated_at=NOW() WHERE user_id=$1`,[userId,error.message]).catch(() => {});
    throw error;
  }
}

export async function completeYouTubeLogin(userId) {
  if (!activeSession || activeSession.userId !== userId) throw new Error('No active YouTube connection window was found for this account.');
  const { page, context } = activeSession;
  if (!(await studioLooksAuthenticated(page))) throw new Error('A completed YouTube Studio login was not detected. Finish Google verification until the Studio dashboard appears.');
  const state = await context.storageState({ indexedDB:true }).catch(() => context.storageState());
  const hasGoogleSession = state.cookies?.some(cookie => ['SID','SAPISID','__Secure-3PSID','LOGIN_INFO'].includes(cookie.name));
  if (!hasGoogleSession) throw new Error('The Google/YouTube session cookie was not detected. Complete login before saving the connection.');
  const channelName = (await page.locator('#channel-name, ytcp-channel-name').first().innerText().catch(() => '')).trim().slice(0,150);
  const encrypted = encryptJson(state);
  await query(
    `UPDATE youtube_accounts SET status='CONNECTED',encrypted_state=$2,channel_name=$3,connected_at=NOW(),last_checked_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1`,
    [userId,encrypted,channelName]
  );
  await addLog(userId,'success','YouTube channel connected securely.',{ channelName });
  await closeActive('completed');
}

export async function cancelYouTubeLogin(userId) {
  if (activeSession?.userId === userId) await closeActive('cancelled');
  await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,updated_at=NOW() WHERE user_id=$1`,[userId]);
}

export async function disconnectYouTube(userId) {
  if (activeSession?.userId === userId) await closeActive('disconnected');
  const releaseProfile = acquireUserBrowserProfile(userId);
  try {
    await removeUserBrowserProfile(userId);
  } finally {
    releaseProfile();
  }
  await query(`UPDATE youtube_accounts SET status='DISCONNECTED',encrypted_state=NULL,connected_at=NULL,last_checked_at=NOW(),last_error=NULL,channel_name='',channel_url='',updated_at=NOW() WHERE user_id=$1`,[userId]);
  await addLog(userId,'warning','YouTube channel disconnected and encrypted session deleted.');
}

export function resolveRemoteAccessToken(accessToken) {
  if (!activeSession || !accessToken || activeSession.accessToken !== accessToken) return null;
  return { host: config.vncHost, port: config.vncPort };
}

export function loginSessionStatus(userId) {
  if (!activeSession || activeSession.userId !== userId) return { active:false };
  return { active:true, expiresAt:activeSession.expiresAt, remoteUrl:activeSession.remoteUrl };
}

export async function shutdownLoginManager() { await closeActive('server shutdown'); }
