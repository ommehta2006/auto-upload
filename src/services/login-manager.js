import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { query } from '../db.js';
import { decryptJson, encryptJson, randomToken } from './crypto.js';
import { addLog } from './logs.js';

let activeSession = null;
const SECURITY_CHALLENGE_PATTERN = /verify it'?s you|verify it’s you|confirm your identity|suspicious activity|to continue, we need to confirm|check your phone|enter the code|two-step verification|couldn'?t sign you in/i;
const STUDIO_DASHBOARD_PATTERN = /channel dashboard|your channel|dashboard\s+content\s+analytics|upload videos|customi[sz]ation|audio library|channel analytics/i;

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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

async function closeActive(reason = 'closed') {
  if (!activeSession) return;
  const session = activeSession;
  activeSession = null;
  clearTimeout(session.timeout);
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
  stopProcess(session.chrome);
  stopProcess(session.websockify);
  stopProcess(session.x11vnc);
  if (session.profileDir) await fs.promises.rm(session.profileDir,{ recursive:true, force:true }).catch(() => {});
  if (session.tokenFile) { try { fs.unlinkSync(session.tokenFile); } catch {} }
  await addLog(session.userId, 'info', 'YouTube connection window closed.', { reason });
}

async function startRemoteDesktop(accessToken) {
  const x11vnc = spawn('x11vnc', ['-display',config.display,'-rfbport',String(config.vncPort),'-localhost','-forever','-shared','-nopw','-noxdamage','-quiet'], { stdio: ['ignore','ignore','pipe'] });
  const tokenFile = `/tmp/youtubepilot-websockify-${accessToken}.tokens`;
  fs.writeFileSync(tokenFile, `${accessToken}: ${config.vncHost}:${config.vncPort}\n`, { mode: 0o600 });
  const websockify = spawn('websockify', ['--web=/usr/share/novnc','--token-plugin=TokenFile',`--token-source=${tokenFile}`,String(config.noVncPort)], { stdio: ['ignore','ignore','pipe'] });
  x11vnc.stderr?.on('data', data => console.error(`[x11vnc] ${String(data).trim()}`));
  websockify.stderr?.on('data', data => console.error(`[websockify] ${String(data).trim()}`));
  try {
    await waitForPort(config.vncHost, config.vncPort);
    await waitForPort('127.0.0.1', config.noVncPort);
    return { x11vnc, websockify, tokenFile };
  } catch (error) {
    stopProcess(websockify); stopProcess(x11vnc);
    try { fs.unlinkSync(tokenFile); } catch {}
    throw error;
  }
}

function remoteUrl(accessToken) {
  const url = new URL(config.noVncPublicUrl);
  url.searchParams.set('autoconnect','true');
  url.searchParams.set('resize','scale');
  url.searchParams.set('reconnect','true');
  url.searchParams.set('path',`remote/websockify?token=${encodeURIComponent(accessToken)}`);
  return url.toString();
}

async function startSigninBrowser(existingState) {
  const profileDir = path.join(config.tempDir, `youtube-login-${randomToken(8)}`);
  await fs.promises.mkdir(profileDir, { recursive:true, mode:0o700 });
  const debuggingPort = await freePort();
  const executable = chromium.executablePath();
  const chrome = spawn(executable, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debuggingPort}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-notifications',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=1440,1000',
    '--disable-features=Translate,MediaRouter',
    'about:blank'
  ], { env:{ ...process.env, DISPLAY:config.display }, stdio:['ignore','ignore','pipe'] });
  chrome.stderr?.on('data', data => {
    const text = String(data).trim();
    if (text && !/DevTools listening|dbus|sandbox/i.test(text)) console.error(`[signin-browser] ${text}`);
  });
  try {
    await waitForPort('127.0.0.1', debuggingPort, 15_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
    const context = browser.contexts()[0];
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome ||= { runtime:{} };
    }).catch(() => {});
    if (existingState?.cookies?.length) await context.addCookies(existingState.cookies).catch(() => {});
    const page = context.pages()[0] || await context.newPage();
    return { chrome, browser, context, page, profileDir };
  } catch (error) {
    stopProcess(chrome);
    await fs.promises.rm(profileDir,{ recursive:true, force:true }).catch(() => {});
    throw error;
  }
}

async function studioLooksAuthenticated(page) {
  if (await studioHasSecurityChallenge(page)) return false;
  const url = page.url().toLowerCase();
  if (url.includes('accounts.google.com') || url.includes('servicelogin')) return false;
  const signIn = await page.getByText(/sign in/i, { exact: true }).first().isVisible().catch(() => false);
  if (signIn) return false;
  const studioUrl = url.includes('studio.youtube.com');
  const body = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
  if (studioUrl && STUDIO_DASHBOARD_PATTERN.test(body)) return true;
  const dashboardSignal = await page.locator('#avatar-btn, ytcp-button#create-icon, #create-icon, ytcp-channel-name, #channel-name').first().isVisible({ timeout: 2500 }).catch(() => false)
    || await page.getByRole('button', { name:/create/i }).first().isVisible({ timeout: 1000 }).catch(() => false)
    || await page.getByText(/^create$/i).first().isVisible({ timeout: 1000 }).catch(() => false)
    || await page.getByText(/upload videos?/i).first().isVisible({ timeout: 1000 }).catch(() => false)
    || await page.getByText(/^content$/i).first().isVisible({ timeout: 1000 }).catch(() => false);
  return Boolean(studioUrl && dashboardSignal);
}

async function studioHasSecurityChallenge(page) {
  const url = page.url().toLowerCase();
  if (url.includes('accounts.google.com') || url.includes('servicelogin')) {
    const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
    return SECURITY_CHALLENGE_PATTERN.test(body);
  }
  const challengeText = page.getByText(SECURITY_CHALLENGE_PATTERN).first();
  if (await challengeText.isVisible({ timeout: 800 }).catch(() => false)) return true;
  const dialogs = page.locator('[role="dialog"], ytcp-dialog, tp-yt-paper-dialog');
  const count = Math.min(await dialogs.count().catch(() => 0), 4);
  for (let i = 0; i < count; i += 1) {
    const dialog = dialogs.nth(i);
    if (!(await dialog.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const text = await dialog.innerText({ timeout: 800 }).catch(() => '');
    if (SECURITY_CHALLENGE_PATTERN.test(text)) return true;
  }
  return false;
}

async function dismissConnectionInterstitials(page) {
  const skipStudio = page.getByText(/^skip to youtube studio$/i).first();
  if (await skipStudio.isVisible({ timeout: 1000 }).catch(() => false)) {
    await skipStudio.click({ timeout: 2000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  }
  const labels = [/^got it$/i,/^not now$/i,/^no thanks$/i,/^dismiss$/i,/^close$/i];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible({ timeout: 500 }).catch(() => false)) await button.click({ timeout: 1500 }).catch(() => {});
  }
}

async function assertStudioReadyForAutomation(userId, page) {
  if (!page.url().toLowerCase().includes('studio.youtube.com')) {
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs }).catch(() => {});
  }
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    await dismissConnectionInterstitials(page);
    if (await studioHasSecurityChallenge(page)) {
      const message = 'Google is still showing "Verify it is you" inside YouTube Studio. Complete that security step in the remote browser before saving the connection.';
      await query(`UPDATE youtube_accounts SET status='ATTENTION_REQUIRED',last_error=$2,last_checked_at=NOW(),updated_at=NOW() WHERE user_id=$1`,[userId,message]).catch(() => {});
      await addLog(userId,'warning','YouTube Studio verification is still pending during connection.',{ reason:'google_security_challenge' });
      throw new Error(message);
    }
    if (await studioLooksAuthenticated(page)) return;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  throw new Error(`A completed YouTube Studio login was not detected. Current page: ${page.url()}. Visible text: ${body.slice(0, 220).replace(/\s+/g, ' ')}`);
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
  let remote; let browser; let context; let signin;
  try {
    const existingState = account.encrypted_state ? decryptJson(account.encrypted_state) : undefined;
    const accessToken = randomToken(18);
    remote = await startRemoteDesktop(accessToken);
    signin = await startSigninBrowser(existingState);
    ({ browser, context } = signin);
    const { page } = signin;
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    const expiresAt = new Date(Date.now() + config.loginSessionMinutes * 60_000);
    const url = remoteUrl(accessToken);
    const timeout = setTimeout(async () => {
      await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,last_error='YouTube connection window expired.',updated_at=NOW() WHERE user_id=$1`, [userId]).catch(() => {});
      await closeActive('expired');
    }, config.loginSessionMinutes * 60_000);
    timeout.unref();
    activeSession = { userId, accountId:account.id, browser, context, page, chrome:signin.chrome, profileDir:signin.profileDir, ...remote, remoteUrl:url, accessToken, expiresAt, timeout };
    await addLog(userId,'info','YouTube connection window opened.',{ expiresAt });
    return { remoteUrl:url, expiresAt, alreadyActive:false };
  } catch (error) {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
    stopProcess(signin?.chrome);
    if (signin?.profileDir) await fs.promises.rm(signin.profileDir,{ recursive:true, force:true }).catch(() => {});
    stopProcess(remote?.websockify); stopProcess(remote?.x11vnc);
    if (remote?.tokenFile) await fs.promises.rm(remote.tokenFile,{ force:true }).catch(() => {});
    await query(`UPDATE youtube_accounts SET status='ERROR',last_error=$2,updated_at=NOW() WHERE user_id=$1`,[userId,error.message]).catch(() => {});
    throw error;
  }
}

export async function completeYouTubeLogin(userId) {
  if (!activeSession || activeSession.userId !== userId) throw new Error('No active YouTube connection window was found for this account.');
  const { page, context } = activeSession;
  const state = await context.storageState({ indexedDB:true }).catch(() => context.storageState());
  const channelName = (await page.locator('#channel-name, ytcp-channel-name').first().innerText().catch(() => '')).trim().slice(0,150);
  const encrypted = encryptJson(state);
  await query(
    `UPDATE youtube_accounts SET status='CONNECTED',encrypted_state=$2,channel_name=$3,connected_at=NOW(),last_checked_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1`,
    [userId,encrypted,channelName]
  );
  await addLog(userId,'success','YouTube browser session saved securely.',{ channelName,currentUrl:page.url() });
  await closeActive('completed');
}

export async function cancelYouTubeLogin(userId) {
  if (activeSession?.userId === userId) await closeActive('cancelled');
  await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,updated_at=NOW() WHERE user_id=$1`,[userId]);
}

export async function disconnectYouTube(userId) {
  if (activeSession?.userId === userId) await closeActive('disconnected');
  await query(`UPDATE youtube_accounts SET status='DISCONNECTED',encrypted_state=NULL,connected_at=NULL,last_checked_at=NOW(),last_error=NULL,channel_name='',channel_url='',updated_at=NOW() WHERE user_id=$1`,[userId]);
  await addLog(userId,'warning','YouTube channel disconnected and encrypted session deleted.');
}

export function loginSessionStatus(userId) {
  if (!activeSession || activeSession.userId !== userId) return { active:false };
  return { active:true, expiresAt:activeSession.expiresAt, remoteUrl:activeSession.remoteUrl };
}

export async function shutdownLoginManager() { await closeActive('server shutdown'); }
