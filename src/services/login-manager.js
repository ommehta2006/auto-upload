import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { config } from '../config.js';
import { query } from '../db.js';
import { decryptJson, encryptJson, randomToken } from './crypto.js';
import { addLog } from './logs.js';
import { acquireBrowserLock, archiveChannelProfile, ensureChannelProfile, launchYouTubePersistentContext, seedPersistentProfileFromStorageState } from './persistent-browser.js';

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
  await session.browserLock?.release().catch(() => {});
  stopProcess(session.websockify);
  stopProcess(session.x11vnc);
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

function remoteEntryUrl() {
  return `${config.baseUrl}/app/youtube/remote`;
}

function writeRemoteToken(session, accessToken) {
  fs.writeFileSync(session.tokenFile, `${accessToken}: ${config.vncHost}:${config.vncPort}\n`, { mode: 0o600 });
  session.accessToken = accessToken;
  session.remoteUrl = remoteUrl(accessToken);
  session.remoteUrlIssuedAt = new Date();
}

async function startSigninBrowser({ userId, channelId, existingState, timezone }) {
  const profileDir = await ensureChannelProfile(userId, channelId);
  const { context } = await launchYouTubePersistentContext({
    userId,
    channelId,
    mode:'VERIFICATION',
    headless:false,
    timezoneId:timezone || 'Asia/Kolkata'
  });
  await seedPersistentProfileFromStorageState(profileDir, context, existingState);
  const page = context.pages()[0] || await context.newPage();
  return { context, page, profileDir };
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

async function recoverStudioOops(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    if (!/oops,\s*something went wrong/i.test(body)) return;
    const retry = page.getByRole('button', { name:/^retry$/i }).first();
    if (await retry.isVisible({ timeout: 1000 }).catch(() => false)) {
      await retry.click({ timeout: 2000 }).catch(() => {});
    } else {
      await page.reload({ waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs }).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function assertStudioReadyForAutomation(userId, page) {
  if (!page.url().toLowerCase().includes('studio.youtube.com')) {
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs }).catch(() => {});
  }
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    await recoverStudioOops(page);
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
    if (activeSession.userId === userId) return { remoteUrl: remoteEntryUrl(), expiresAt: activeSession.expiresAt, alreadyActive: true };
    throw new Error('Another YouTube connection is currently in progress. Try again after it finishes.');
  }
  const accountResult = await query(
    `INSERT INTO youtube_accounts (user_id,status) VALUES ($1,'CONNECTING')
     ON CONFLICT (user_id) DO UPDATE SET status='CONNECTING',last_error=NULL,browser_profile_id=COALESCE(NULLIF(youtube_accounts.browser_profile_id,''),youtube_accounts.id::text),updated_at=NOW()
     RETURNING *`, [userId]
  );
  const account = accountResult.rows[0];
  const channelId = account.browser_profile_id || account.id;
  let remote; let context; let signin; let browserLock;
  try {
    const existingState = account.encrypted_state ? decryptJson(account.encrypted_state) : undefined;
    browserLock = await acquireBrowserLock({ userId, channelId, owner:'VERIFICATION', metadata:{ reason:'youtube_login' } });
    const accessToken = randomToken(18);
    remote = await startRemoteDesktop(accessToken);
    signin = await startSigninBrowser({ userId, channelId, existingState });
    ({ context } = signin);
    const { page } = signin;
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    await recoverStudioOops(page);
    const expiresAt = new Date(Date.now() + config.loginSessionMinutes * 60_000);
    const url = remoteUrl(accessToken);
    const timeout = setTimeout(async () => {
      await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,last_error='YouTube connection window expired.',updated_at=NOW() WHERE user_id=$1`, [userId]).catch(() => {});
      await closeActive('expired');
    }, config.loginSessionMinutes * 60_000);
    timeout.unref();
    activeSession = { userId, accountId:account.id, channelId, browserLock, context, page, profileDir:signin.profileDir, ...remote, remoteUrl:url, accessToken, expiresAt, timeout };
    await addLog(userId,'info','YouTube connection window opened.',{ channelId, expiresAt, event:'verification_session_started' });
    return { remoteUrl:remoteEntryUrl(), expiresAt, alreadyActive:false };
  } catch (error) {
    await context?.close().catch(() => {});
    await browserLock?.release().catch(() => {});
    stopProcess(remote?.websockify); stopProcess(remote?.x11vnc);
    if (remote?.tokenFile) await fs.promises.rm(remote.tokenFile,{ force:true }).catch(() => {});
    const profileHealth = error.code === 'BROWSER_PROFILE_LOCKED' ? 'BROWSER_PROFILE_LOCKED' : 'UNKNOWN';
    await query(`UPDATE youtube_accounts SET status='ERROR',browser_profile_health=$3,last_error=$2,updated_at=NOW() WHERE user_id=$1`,[userId,error.message,profileHealth]).catch(() => {});
    throw error;
  }
}

export async function restartYouTubeLogin(userId) {
  if (activeSession?.userId === userId) await closeActive('restarted');
  return startYouTubeLogin(userId);
}

export function issueRemoteBrowserUrl(userId) {
  if (!activeSession || activeSession.userId !== userId) throw new Error('No active YouTube connection window was found for this account.');
  const accessToken = randomToken(18);
  writeRemoteToken(activeSession, accessToken);
  return { remoteUrl:activeSession.remoteUrl, expiresAt:activeSession.expiresAt };
}

export async function completeYouTubeLogin(userId) {
  if (!activeSession || activeSession.userId !== userId) throw new Error('No active YouTube connection window was found for this account.');
  const { page, context, channelId } = activeSession;
  await assertStudioReadyForAutomation(userId, page);
  const state = await context.storageState({ indexedDB:true }).catch(() => context.storageState());
  const channelName = (await page.locator('#channel-name, ytcp-channel-name').first().innerText().catch(() => '')).trim().slice(0,150);
  const encrypted = encryptJson(state);
  await query(
    `UPDATE youtube_accounts SET status='CONNECTED',encrypted_state=$2,channel_name=$3,browser_profile_id=COALESCE(NULLIF(browser_profile_id,''),id::text),
       browser_profile_health='HEALTHY',connected_at=NOW(),last_checked_at=NOW(),last_successful_verification_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1`,
    [userId,encrypted,channelName]
  );
  const resumed = await query(
    `UPDATE uploads
        SET status=CASE WHEN workflow_stage IN ('BEFORE_STUDIO_OPEN','BEFORE_FILE_SELECTION') THEN 'READY' ELSE 'RESUME_AVAILABLE' END,
            enabled=TRUE,error='',attempts=0,last_attempt_at=NULL,updated_at=NOW()
      WHERE user_id=$1
        AND status IN ('LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED','PAUSED_FOR_VERIFICATION')
        AND youtube_url=''
      RETURNING upload_id`,
    [userId]
  );
  await addLog(userId,'success','YouTube browser session saved securely.',{
    channelId,
    channelName,
    currentUrl:page.url(),
    resumedUploads:resumed.rows.map(row => row.upload_id),
    event:'verification_completed'
  });
  await closeActive('completed');
}

export async function cancelYouTubeLogin(userId) {
  if (activeSession?.userId === userId) await closeActive('cancelled');
  await query(`UPDATE youtube_accounts SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,updated_at=NOW() WHERE user_id=$1`,[userId]);
}

export async function disconnectYouTube(userId) {
  if (activeSession?.userId === userId) await closeActive('disconnected');
  const account = await query('SELECT id,browser_profile_id FROM youtube_accounts WHERE user_id=$1',[userId]);
  const channelId = account.rows[0]?.browser_profile_id || account.rows[0]?.id;
  let browserLock; let archivedProfile = '';
  try {
    if (channelId) {
      browserLock = await acquireBrowserLock({ userId, channelId, owner:'RECONNECT', metadata:{ reason:'disconnect' } });
      archivedProfile = await archiveChannelProfile(userId, channelId);
    }
    await query(`UPDATE uploads SET status='PAUSED',enabled=FALSE,error='YouTube channel disconnected.',updated_at=NOW() WHERE user_id=$1 AND status IN ('READY','LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED','PAUSED_FOR_VERIFICATION','RESUME_AVAILABLE')`,[userId]);
    await query(`UPDATE youtube_accounts SET status='DISCONNECTED',encrypted_state=NULL,connected_at=NULL,last_checked_at=NOW(),last_error=NULL,channel_name='',channel_url='',browser_profile_health='UNKNOWN',updated_at=NOW() WHERE user_id=$1`,[userId]);
    await addLog(userId,'warning','YouTube channel disconnected and browser profile archived.',{ channelId, archivedProfile });
  } finally {
    await browserLock?.release().catch(() => {});
  }
}

export function loginSessionStatus(userId) {
  if (!activeSession || activeSession.userId !== userId) return { active:false };
  return { active:true, expiresAt:activeSession.expiresAt, remoteUrl:remoteEntryUrl() };
}

export async function shutdownLoginManager() { await closeActive('server shutdown'); }
