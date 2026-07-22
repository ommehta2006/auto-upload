import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { query, withTransaction } from './db.js';
import { decryptJson, encryptJson } from './services/crypto.js';
import { addLog } from './services/logs.js';
import { absoluteStoragePath, pruneUserScreenshots, userScreenshotDir } from './services/storage.js';
import { uploadToYouTube, YouTubeAutomationError } from './services/youtube.js';
import { startYouTubeLogin } from './services/login-manager.js';

let stopping = false;
let activeWorkers = 0;
let loopTimer = null;

function withinWindow(now, start, end) {
  const current = now.toFormat('HH:mm');
  const normalizedStart = String(start).slice(0,5);
  const normalizedEnd = String(end).slice(0,5);
  if (normalizedStart === normalizedEnd) return true;
  if (normalizedStart < normalizedEnd) return current >= normalizedStart && current <= normalizedEnd;
  return current >= normalizedStart || current <= normalizedEnd;
}

async function markStaleUploads() {
  const stale = await query(
    `UPDATE uploads u SET status='REVIEW_REQUIRED',
       error='A previous worker stopped during upload. Check YouTube Studio before retrying to avoid a duplicate.',updated_at=NOW()
     FROM user_settings s WHERE u.user_id=s.user_id AND u.status='UPLOADING'
       AND u.last_attempt_at < NOW() - make_interval(mins => s.stale_upload_minutes)
     RETURNING u.user_id,u.upload_id`
  );
  for (const item of stale.rows) await addLog(item.user_id,'warning','Upload moved to review required after a stale worker attempt.',{ uploadId:item.upload_id });
}

async function candidateAllowed(client, candidate) {
  const now = DateTime.now().setZone(candidate.timezone);
  if (!now.isValid) return false;
  if (!withinWindow(now,candidate.upload_window_start,candidate.upload_window_end)) return false;
  const counts = await client.query(
    `SELECT COUNT(*) FILTER (WHERE status='UPLOADED' AND (uploaded_at AT TIME ZONE $2)::date=(NOW() AT TIME ZONE $2)::date)::int AS uploaded_today,
            MAX(uploaded_at) FILTER (WHERE status='UPLOADED') AS last_uploaded_at
     FROM uploads WHERE user_id=$1`, [candidate.user_id,candidate.timezone]
  );
  const { uploaded_today:today, last_uploaded_at:last } = counts.rows[0];
  if (today >= candidate.maximum_uploads_per_day) return false;
  if (last && candidate.minimum_gap_minutes > 0 && DateTime.fromJSDate(new Date(last)).plus({ minutes:candidate.minimum_gap_minutes }) > DateTime.now()) return false;
  if (candidate.last_attempt_at && candidate.retry_delay_minutes > 0 && DateTime.fromJSDate(new Date(candidate.last_attempt_at)).plus({ minutes:candidate.retry_delay_minutes }) > DateTime.now()) return false;
  return true;
}

async function claimNextUpload() {
  return withTransaction(async client => {
    const candidates = await client.query(
      `SELECT u.*,m.relative_path AS media_path,m.original_name AS media_name,
              t.relative_path AS thumbnail_path,c.relative_path AS caption_path,
              s.maximum_uploads_per_day,s.minimum_gap_minutes,s.max_attempts,s.retry_delay_minutes,s.stale_upload_minutes,
              s.timezone,s.upload_window_start,s.upload_window_end,a.id AS channel_id,a.browser_profile_id,a.encrypted_state,a.status AS account_status
       FROM uploads u
       JOIN user_settings s ON s.user_id=u.user_id
       LEFT JOIN media_files m ON m.id=u.media_id
       LEFT JOIN media_files t ON t.id=u.thumbnail_id
       LEFT JOIN media_files c ON c.id=u.caption_file_id
       LEFT JOIN youtube_accounts a ON a.user_id=u.user_id
       WHERE u.enabled=TRUE AND u.status='READY' AND u.automation_start_at<=NOW() AND s.automation_enabled=TRUE
       ORDER BY u.automation_start_at ASC LIMIT 25 FOR UPDATE OF u SKIP LOCKED`
    );
    if (candidates.rowCount) console.log(`Worker found ${candidates.rowCount} due READY upload candidate${candidates.rowCount === 1 ? '' : 's'}.`);
    for (const candidate of candidates.rows) {
      if (!candidate.media_id || !candidate.media_path) {
        await client.query(`UPDATE uploads SET status='FILE_MISSING',error='The source video is missing.',updated_at=NOW() WHERE id=$1`,[candidate.id]);
        console.log(`Worker marked ${candidate.upload_id} as FILE_MISSING.`);
        continue;
      }
      if (!candidate.channel_id || candidate.account_status !== 'CONNECTED') {
        await client.query(`UPDATE uploads SET status='LOGIN_REQUIRED',error='Connect YouTube before this upload can run.',updated_at=NOW() WHERE id=$1`,[candidate.id]);
        console.log(`Worker marked ${candidate.upload_id} as LOGIN_REQUIRED because the YouTube account is not connected.`);
        continue;
      }
      if (candidate.attempts >= candidate.max_attempts) {
        await client.query(`UPDATE uploads SET status='FAILED',error='Maximum upload attempts reached.',updated_at=NOW() WHERE id=$1`,[candidate.id]);
        console.log(`Worker marked ${candidate.upload_id} as FAILED after max attempts.`);
        continue;
      }
      if (!(await candidateAllowed(client,candidate))) continue;
      const claimed = await client.query(
        `UPDATE uploads SET status='UPLOADING',attempts=attempts+1,last_attempt_at=NOW(),error='',warnings='[]'::jsonb,updated_at=NOW()
         WHERE id=$1 AND status='READY' RETURNING *`, [candidate.id]
      );
      if (claimed.rowCount) {
        console.log(`Worker claimed ${candidate.upload_id} for upload.`);
        return { ...candidate, ...claimed.rows[0] };
      }
    }
    return null;
  });
}

async function processUpload(post) {
  const screenshotDir = userScreenshotDir(post.user_id);
  fs.mkdirSync(screenshotDir,{ recursive:true, mode:0o700 });
  const screenshotName = `${Date.now()}-${String(post.upload_id).replace(/[^a-zA-Z0-9._-]/g,'_')}.png`;
  const screenshotPath = path.join(screenshotDir,screenshotName);
  const log = (level,message,details={}) => void addLog(post.user_id,level,message,{ uploadId:post.upload_id,...details });
  try {
    const state = post.encrypted_state ? decryptJson(post.encrypted_state) : undefined;
    const mediaPath = absoluteStoragePath(post.media_path);
    const thumbnailPath = post.thumbnail_path ? absoluteStoragePath(post.thumbnail_path) : null;
    const captionPath = post.caption_path ? absoluteStoragePath(post.caption_path) : null;
    const publishLocal = post.youtube_publish_at ? DateTime.fromJSDate(new Date(post.youtube_publish_at)).setZone(post.timezone) : null;
    post.youtube_publish_local_date = publishLocal?.toFormat('yyyy-MM-dd') || '';
    post.youtube_publish_local_time = publishLocal?.toFormat('HH:mm') || '';
    const onStage = async workflowStage => {
      await query(`UPDATE uploads SET workflow_stage=$2,updated_at=NOW() WHERE id=$1`, [post.id,workflowStage]);
    };
    log('info',`Starting ${post.content_type === 'SHORT' ? 'Short' : 'video'} upload.`,{ media:post.media_name });
    const result = await uploadToYouTube({ post,storageState:state,videoPath:mediaPath,thumbnailPath,captionPath,screenshotPath,log,onStage });
    await withTransaction(async client => {
      await client.query(
        `UPDATE uploads SET status='UPLOADED',uploaded_at=NOW(),youtube_video_id=$2,youtube_url=$3,warnings=$4::jsonb,error='',updated_at=NOW() WHERE id=$1`,
        [post.id,result.videoId || '',result.url || '',JSON.stringify(result.warnings || [])]
      );
      await client.query(
        `UPDATE youtube_accounts SET status='CONNECTED',encrypted_state=$2,browser_profile_id=COALESCE(NULLIF(browser_profile_id,''),id::text),
           browser_profile_health='HEALTHY',last_checked_at=NOW(),last_successful_upload_at=NOW(),last_error=NULL,updated_at=NOW() WHERE user_id=$1`,
        [post.user_id,encryptJson(result.storageState)]
      );
    });
    await addLog(post.user_id,result.warnings?.length ? 'warning' : 'success','YouTube upload completed.',{
      uploadId:post.upload_id,url:result.url,videoId:result.videoId,warnings:result.warnings,probe:result.probe
    });
  } catch (error) {
    const code = error instanceof YouTubeAutomationError ? error.code : 'AUTOMATION_FAILED';
    const status = ['LOGIN_REQUIRED','YOUTUBE_LOGIN_REQUIRED'].includes(code) ? 'LOGIN_REQUIRED'
      : ['ACCOUNT_ACTION_REQUIRED','GOOGLE_VERIFICATION_REQUIRED'].includes(code) ? 'PAUSED_FOR_VERIFICATION'
      : code === 'REVIEW_REQUIRED' || error?.outcomeUncertain ? 'REVIEW_REQUIRED'
      : post.attempts >= post.max_attempts ? 'FAILED' : 'READY';
    await query(`UPDATE uploads SET status=$2,error=$3,updated_at=NOW() WHERE id=$1`,[post.id,status,String(error.message || 'Upload failed.').slice(0,2000)]);
    if (['LOGIN_REQUIRED','PAUSED_FOR_VERIFICATION'].includes(status)) {
      const accountStatus = status === 'LOGIN_REQUIRED' ? 'SESSION_EXPIRED' : 'VERIFICATION_REQUIRED';
      await query(`UPDATE youtube_accounts SET status=$2,browser_profile_health=$3,last_error=$4,last_checked_at=NOW(),updated_at=NOW() WHERE user_id=$1`,[post.user_id,accountStatus,status,String(error.message).slice(0,1000)]);
    }
    const screenshot = fs.existsSync(screenshotPath) ? screenshotName : '';
    await addLog(post.user_id,'error','YouTube upload failed.',{ uploadId:post.upload_id,status,code,error:error.message,screenshot });
    if (['LOGIN_REQUIRED','YOUTUBE_LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED','GOOGLE_VERIFICATION_REQUIRED'].includes(code)) {
      try {
        const session = await startYouTubeLogin(post.user_id);
        await addLog(post.user_id,'warning','Remote YouTube Studio login window is ready. Open it from the Channel panel, complete Google login or verification yourself, then save the encrypted session.',{
          uploadId:post.upload_id,
          expiresAt:session.expiresAt,
          remoteUrl:session.remoteUrl
        });
      } catch (sessionError) {
        await addLog(post.user_id,'warning','Could not automatically open the remote login window.',{
          uploadId:post.upload_id,
          error:sessionError.message
        });
      }
    }
  } finally {
    await pruneUserScreenshots(post.user_id).catch(() => {});
  }
}

async function workerTick() {
  await markStaleUploads().catch(error => console.error('Stale upload cleanup failed:',error));
  while (!stopping && activeWorkers < config.workerConcurrency) {
    const post = await claimNextUpload();
    if (!post) break;
    activeWorkers += 1;
    processUpload(post).catch(error => console.error('Unhandled upload error:',error)).finally(() => { activeWorkers -= 1; });
  }
}

export function startWorker() {
  if (loopTimer) return;
  stopping = false;
  console.log(`Worker started with interval ${config.workerIntervalMs}ms and concurrency ${config.workerConcurrency}.`);
  const run = async () => {
    try { await workerTick(); } catch (error) { console.error('Worker tick failed:',error); }
    if (!stopping) loopTimer = setTimeout(run,config.workerIntervalMs);
  };
  void run();
}

export async function stopWorker() {
  stopping = true;
  if (loopTimer) clearTimeout(loopTimer);
  const deadline = Date.now() + 30_000;
  while (activeWorkers > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,250));
}
