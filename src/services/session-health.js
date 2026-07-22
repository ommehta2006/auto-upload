import { config } from '../config.js';
import { query } from '../db.js';
import { acquireBrowserLock, launchYouTubePersistentContext } from './persistent-browser.js';
import { addLog } from './logs.js';

const VERIFICATION_PATTERN = /verify it'?s you|verify it’s you|confirm it'?s really you|extra layer of security|verify your identity|to continue, we need to confirm|sign in again|check your phone|use your passkey|enter a verification code|two-step verification/i;
const STUDIO_PATTERN = /channel dashboard|your channel|upload videos|customi[sz]ation|audio library|channel analytics|content/i;

async function pageTextAcrossFrames(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout:1500 }).catch(() => '');
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

export async function checkYouTubeSession({ userId, channelId, timezone = 'Asia/Kolkata' }) {
  const started = Date.now();
  let browserLock; let context; let result = 'UNKNOWN'; let error = '';
  await addLog(userId,'info','YouTube session health check started.',{ channelId,browserMode:'SESSION_CHECK',event:'session_health_started' }).catch(() => {});
  try {
    browserLock = await acquireBrowserLock({ userId, channelId, owner:'SESSION_CHECK', metadata:{ reason:'health_check' } });
    const launched = await launchYouTubePersistentContext({ userId, channelId, mode:'SESSION_CHECK', headless:config.browserHeadless, timezoneId:timezone });
    context = launched.context;
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.youtubeStudioUrl, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    await page.waitForTimeout(3000);
    const url = page.url().toLowerCase();
    const text = await pageTextAcrossFrames(page);
    if (url.includes('accounts.google.com') || url.includes('servicelogin') || /sign in/i.test(text)) {
      result = 'LOGIN_REQUIRED';
    } else if (VERIFICATION_PATTERN.test(text)) {
      result = 'VERIFICATION_REQUIRED';
    } else if (STUDIO_PATTERN.test(text)) {
      result = 'HEALTHY';
    } else if (/oops,\s*something went wrong|studio is unavailable|try again later/i.test(text)) {
      result = 'STUDIO_UNAVAILABLE';
    }
  } catch (healthError) {
    error = healthError.message || 'Session health check failed.';
    result = healthError.code === 'BROWSER_PROFILE_LOCKED' ? 'BROWSER_PROFILE_LOCKED' : 'UNKNOWN';
  } finally {
    await context?.close().catch(() => {});
    await browserLock?.release().catch(() => {});
  }
  const accountStatus = result === 'HEALTHY' ? 'CONNECTED'
    : result === 'LOGIN_REQUIRED' ? 'SESSION_EXPIRED'
    : result === 'VERIFICATION_REQUIRED' ? 'VERIFICATION_REQUIRED'
    : result === 'BROWSER_PROFILE_LOCKED' ? 'CONNECTED'
    : 'RECONNECT_REQUIRED';
  await query(
    `UPDATE youtube_accounts SET status=$3,browser_profile_health=$4,last_session_check_at=NOW(),last_checked_at=NOW(),last_error=$5,updated_at=NOW()
     WHERE user_id=$1 AND id=$2`,
    [userId,channelId,accountStatus,result,error || null]
  );
  await addLog(userId,result === 'HEALTHY' ? 'success' : 'warning','YouTube session health check completed.',{
    channelId,
    browserMode:'SESSION_CHECK',
    status:result,
    durationMs:Date.now() - started,
    errorCode:error ? result : '',
    event:'session_health_completed'
  }).catch(() => {});
  return { status:result, error };
}
