import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { DateTime, IANAZone } from 'luxon';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyMultipartCsrf } from '../middleware/csrf.js';
import { flash } from '../middleware/flash.js';
import { uploadSchema, settingsSchema, firstZodError } from '../validation.js';
import { saveUploadedFile, removeStoredFile, absoluteStoragePath, safeName } from '../services/storage.js';
import { probeVideo, validateContentType } from '../services/media-probe.js';
import { parseUploadsWorkbook, buildUploadsWorkbook } from '../services/excel.js';
import { addLog } from '../services/logs.js';
import { startYouTubeLogin, restartYouTubeLogin, completeYouTubeLogin, cancelYouTubeLogin, disconnectYouTube, loginSessionStatus, issueRemoteBrowserUrl } from '../services/login-manager.js';
import { checkYouTubeSession } from '../services/session-health.js';
import { assessDuplicateRisk } from '../services/duplicate-risk.js';

const router = Router();
router.use(requireAuth);
await fs.mkdir(config.tempDir,{ recursive:true });

const uploadStorage = multer.diskStorage({
  destination:config.tempDir,
  filename:(_req,file,cb) => cb(null,`${crypto.randomUUID()}-${safeName(file.originalname)}`)
});
const mediaUpload = multer({
  storage:uploadStorage,
  limits:{ fileSize:Math.max(config.maxVideoBytes,config.maxImageBytes,config.maxCaptionBytes),files:10,fields:20 }
});
const excelUpload = multer({
  storage:uploadStorage,
  limits:{ fileSize:config.maxExcelBytes,files:1,fields:10 },
  fileFilter:(_req,file,cb) => /\.xlsx$/i.test(file.originalname) ? cb(null,true) : cb(new Error('Only .xlsx Excel workbooks are supported.'))
});
const uploadLimit = rateLimit({ windowMs:15 * 60_000,limit:50,standardHeaders:'draft-8',legacyHeaders:false });

const UPLOAD_COLUMNS = `
  upload_id,content_type,media_id,thumbnail_id,caption_file_id,media_file_hint,title,description,tags,playlist_name,
  automation_start_at,visibility,youtube_publish_at,premiere,audience,age_restriction,paid_promotion,altered_content,
  automatic_chapters,featured_places,automatic_concepts,language,caption_certification,caption_language,caption_name,
  recording_date,recording_location,license,distribution,allow_embedding,notify_subscribers,category,comments_mode,
  comments_sort,show_like_count,remix_mode,related_video,enabled,status,error`;

const DEFAULT_SETTINGS = {
  automation_enabled: true,
  maximum_uploads_per_day: 6,
  minimum_gap_minutes: 20,
  max_attempts: 3,
  retry_delay_minutes: 20,
  stale_upload_minutes: 180,
  timezone: 'Asia/Kolkata',
  upload_window_start: '00:00',
  upload_window_end: '23:59',
  default_visibility: 'PRIVATE',
  default_audience: 'NOT_MADE_FOR_KIDS',
  default_category: '22',
  default_language: ''
};

async function settingsForUser(userId, columns = '*') {
  await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',[userId]);
  const result = await query(`SELECT ${columns} FROM user_settings WHERE user_id=$1`,[userId]);
  return { ...DEFAULT_SETTINGS, ...(result.rows[0] || {}) };
}

async function dashboardData(userId) {
  const [user,settings,account,media,uploads,logs,counts,storage] = await Promise.all([
    query('SELECT id,email,display_name,created_at FROM users WHERE id=$1',[userId]),
    settingsForUser(userId),
    query('SELECT id,label,status,channel_name,channel_url,last_checked_at,last_error,connected_at,browser_profile_health,last_session_check_at,last_successful_verification_at,last_successful_upload_at FROM youtube_accounts WHERE user_id=$1',[userId]),
    query('SELECT * FROM media_files WHERE user_id=$1 ORDER BY created_at DESC LIMIT 300',[userId]),
    query(`SELECT u.*,m.original_name AS media_name,m.size_bytes AS media_size,t.original_name AS thumbnail_name,c.original_name AS caption_name_file
           FROM uploads u LEFT JOIN media_files m ON m.id=u.media_id LEFT JOIN media_files t ON t.id=u.thumbnail_id LEFT JOIN media_files c ON c.id=u.caption_file_id
           WHERE u.user_id=$1 ORDER BY u.automation_start_at DESC LIMIT 400`,[userId]),
    query('SELECT * FROM activity_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 80',[userId]),
    query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE content_type='VIDEO')::int AS videos,
      COUNT(*) FILTER (WHERE content_type='SHORT')::int AS shorts,
      COUNT(*) FILTER (WHERE status='READY')::int AS ready,
      COUNT(*) FILTER (WHERE status='UPLOADED')::int AS uploaded,
      COUNT(*) FILTER (WHERE status IN ('FAILED','LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED','PAUSED_FOR_VERIFICATION','RESUME_AVAILABLE','REVIEW_REQUIRED','FILE_MISSING'))::int AS attention
      FROM uploads WHERE user_id=$1`,[userId]),
    query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS used_bytes FROM media_files WHERE user_id=$1',[userId])
  ]);
  return {
    user:user.rows[0],settings,account:account.rows[0],media:media.rows,uploads:uploads.rows,logs:logs.rows,
    counts:counts.rows[0],storageUsedBytes:Number(storage.rows[0].used_bytes || 0),loginSession:loginSessionStatus(userId),railwayRegion:config.railwayRegion
  };
}

router.get('/app',async (req,res,next) => {
  try { res.render('dashboard',{ title:'Creator Command Center',...(await dashboardData(req.session.userId)) }); }
  catch (error) { next(error); }
});

function kindLimit(kind) {
  return kind === 'VIDEO' ? config.maxVideoBytes : kind === 'THUMBNAIL' ? config.maxImageBytes : config.maxCaptionBytes;
}

router.post('/app/media/:kind',uploadLimit,mediaUpload.array('files',10),verifyMultipartCsrf,async (req,res,next) => {
  const kind = String(req.params.kind || '').toUpperCase();
  const files = req.files || [];
  const stored = [];
  try {
    if (!['VIDEO','THUMBNAIL','CAPTION'].includes(kind)) return res.sendStatus(404);
    if (!files.length) throw new Error('Select at least one file.');
    if (files.some(file => file.size > kindLimit(kind))) throw new Error(`A selected ${kind.toLowerCase()} exceeds the configured size limit.`);
    const incomingBytes = files.reduce((sum,file) => sum + Number(file.size || 0),0);
    const repaired = [];
    await withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`storage:${req.session.userId}`]);
      const usage = await client.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS used FROM media_files WHERE user_id=$1',[req.session.userId]);
      if (Number(usage.rows[0].used || 0) + incomingBytes > config.maxStorageBytesPerUser) {
        throw new Error(`Storage quota exceeded. This account can store up to ${Math.round(config.maxStorageBytesPerUser / 1024 / 1024)} MB.`);
      }
      for (const file of files) {
        const saved = await saveUploadedFile(req.session.userId,kind,file);
        stored.push(saved.relativePath);
        let metadata = {};
        if (kind === 'VIDEO') metadata = await probeVideo(saved.absolutePath).catch(error => ({ probeError:error.message }));
        const inserted = await client.query(
          `INSERT INTO media_files (user_id,kind,original_name,stored_name,relative_path,mime_type,size_bytes,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
          [req.session.userId,kind,saved.originalName,saved.storedName,saved.relativePath,saved.mimeType,saved.sizeBytes,JSON.stringify(metadata)]
        );
        if (kind === 'VIDEO') {
          const fixed = await client.query(
            `UPDATE uploads SET media_id=$3,status=CASE WHEN enabled THEN 'READY' ELSE 'PAUSED' END,error='',updated_at=NOW()
             WHERE user_id=$1 AND media_id IS NULL AND LOWER(media_file_hint)=LOWER($2) AND status='FILE_MISSING' RETURNING upload_id`,
            [req.session.userId,saved.originalName,inserted.rows[0].id]
          );
          repaired.push(...fixed.rows.map(row => row.upload_id));
        }
      }
    });
    await addLog(req.session.userId,'success',`${kindLabel(kind)} uploaded.`,{ count:files.length,bytes:incomingBytes,repaired });
    flash(req,'success',`${files.length} ${kindLabel(kind).toLowerCase()}${files.length === 1 ? '' : 's'} uploaded successfully.`);
    res.redirect('/app#library');
  } catch (error) {
    await Promise.all(stored.map(relative => removeStoredFile(relative).catch(() => {})));
    for (const file of files) await fs.rm(file.path,{ force:true }).catch(() => {});
    if (error?.code === '23505') return next(new Error(`A ${kindLabel(kind).toLowerCase()} with the same filename already exists.`));
    next(error);
  }
});

function kindLabel(kind) { return kind === 'VIDEO' ? 'Video' : kind === 'THUMBNAIL' ? 'Thumbnail' : 'Caption file'; }

router.post('/app/import-excel',uploadLimit,excelUpload.single('excel'),verifyMultipartCsrf,async (req,res,next) => {
  try {
    if (!req.file) throw new Error('Select an Excel workbook.');
    const settings = await settingsForUser(req.session.userId);
    const [rows,files] = await Promise.all([
      parseUploadsWorkbook(req.file.path,settings.timezone),
      query('SELECT id,kind,original_name FROM media_files WHERE user_id=$1',[req.session.userId])
    ]);
    const byKind = new Map(files.rows.map(file => [`${file.kind}:${file.original_name.toLowerCase()}`,file.id]));
    let imported=0; let invalid=0; const invalidRows=[];
    await withTransaction(async client => {
      for (const row of rows) {
        if (row.validationError) { invalid += 1; if (invalidRows.length < 30) invalidRows.push({ row:row.rowNumber,id:row.uploadId,error:row.validationError }); continue; }
        const mediaId = byKind.get(`VIDEO:${row.videoFile.toLowerCase()}`) || null;
        const thumbnailId = row.thumbnailFile ? byKind.get(`THUMBNAIL:${row.thumbnailFile.toLowerCase()}`) || null : null;
        const captionId = row.captionFile ? byKind.get(`CAPTION:${row.captionFile.toLowerCase()}`) || null : null;
        const status = mediaId ? (row.enabled ? 'READY' : 'PAUSED') : 'FILE_MISSING';
        const error = mediaId ? '' : `Video not uploaded: ${row.videoFile}`;
        const values = uploadValues(req.session.userId,row,mediaId,thumbnailId,captionId,status,error);
        await client.query(
          `INSERT INTO uploads (user_id,${UPLOAD_COLUMNS}) VALUES (${values.map((_,i) => `$${i + 1}`).join(',')})
           ON CONFLICT (user_id,upload_id) DO UPDATE SET
             content_type=EXCLUDED.content_type,media_id=EXCLUDED.media_id,thumbnail_id=EXCLUDED.thumbnail_id,caption_file_id=EXCLUDED.caption_file_id,
             media_file_hint=EXCLUDED.media_file_hint,title=EXCLUDED.title,description=EXCLUDED.description,tags=EXCLUDED.tags,playlist_name=EXCLUDED.playlist_name,
             automation_start_at=EXCLUDED.automation_start_at,visibility=EXCLUDED.visibility,youtube_publish_at=EXCLUDED.youtube_publish_at,premiere=EXCLUDED.premiere,
             audience=EXCLUDED.audience,age_restriction=EXCLUDED.age_restriction,paid_promotion=EXCLUDED.paid_promotion,altered_content=EXCLUDED.altered_content,
             automatic_chapters=EXCLUDED.automatic_chapters,featured_places=EXCLUDED.featured_places,automatic_concepts=EXCLUDED.automatic_concepts,
             language=EXCLUDED.language,caption_certification=EXCLUDED.caption_certification,caption_language=EXCLUDED.caption_language,caption_name=EXCLUDED.caption_name,
             recording_date=EXCLUDED.recording_date,recording_location=EXCLUDED.recording_location,license=EXCLUDED.license,distribution=EXCLUDED.distribution,
             allow_embedding=EXCLUDED.allow_embedding,notify_subscribers=EXCLUDED.notify_subscribers,category=EXCLUDED.category,comments_mode=EXCLUDED.comments_mode,
             comments_sort=EXCLUDED.comments_sort,show_like_count=EXCLUDED.show_like_count,remix_mode=EXCLUDED.remix_mode,related_video=EXCLUDED.related_video,
             enabled=EXCLUDED.enabled,status=CASE WHEN uploads.status='UPLOADED' THEN uploads.status ELSE EXCLUDED.status END,
             error=CASE WHEN uploads.status='UPLOADED' THEN uploads.error ELSE EXCLUDED.error END,updated_at=NOW()`, values
        );
        imported += 1;
      }
    });
    await addLog(req.session.userId,invalid ? 'warning' : 'success','Excel upload plan imported.',{ imported,invalid,invalidRows });
    flash(req,invalid ? 'warning' : 'success',`Imported ${imported} rows.${invalid ? ` Skipped ${invalid} invalid rows.` : ''}`);
    res.redirect('/app#queue');
  } catch (error) { next(error); }
  finally { if (req.file?.path) await fs.rm(req.file.path,{ force:true }).catch(() => {}); }
});

function uploadValues(userId,row,mediaId,thumbnailId,captionId,status,error) {
  return [userId,row.uploadId,row.contentType,mediaId,thumbnailId,captionId,row.videoFile,row.title,row.description,row.tags,row.playlistName,
    row.automationStartAt,row.visibility,row.youtubePublishAt,row.premiere,row.audience,row.ageRestriction,row.paidPromotion,row.alteredContent,
    row.automaticChapters,row.featuredPlaces,row.automaticConcepts,row.language,row.captionCertification,row.captionLanguage,row.captionName,
    row.recordingDate,row.recordingLocation,row.license,row.distribution,row.allowEmbedding,row.notifySubscribers,row.category,row.commentsMode,
    row.commentsSort,row.showLikeCount,row.remixMode,row.relatedVideo,row.enabled,status,error];
}

router.get('/app/export-excel',async (req,res,next) => {
  try {
    const [uploads,settings] = await Promise.all([
      query(`SELECT u.*,m.original_name AS media_name,t.original_name AS thumbnail_name,c.original_name AS caption_name_file FROM uploads u
             LEFT JOIN media_files m ON m.id=u.media_id LEFT JOIN media_files t ON t.id=u.thumbnail_id LEFT JOIN media_files c ON c.id=u.caption_file_id
             WHERE u.user_id=$1 ORDER BY u.automation_start_at`,[req.session.userId]),
      settingsForUser(req.session.userId)
    ]);
    const buffer = await buildUploadsWorkbook({ uploads:uploads.rows,settings });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="youtube_upload_plan.xlsx"');
    res.send(buffer);
  } catch (error) { next(error); }
});

async function normalizedSubmission(userId,body) {
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) throw new Error(firstZodError(parsed.error));
  const data = parsed.data;
  const settings = await settingsForUser(userId,'timezone');
  const media = (await query(`SELECT * FROM media_files WHERE id=$1 AND user_id=$2 AND kind='VIDEO'`,[data.mediaId,userId])).rows[0];
  if (!media) throw new Error('The selected source video does not belong to this account.');
  validateContentType(await probeVideo(absoluteStoragePath(media.relative_path)),data.contentType);
  let thumbnail=null; let caption=null;
  if (data.thumbnailId) {
    thumbnail = (await query(`SELECT id FROM media_files WHERE id=$1 AND user_id=$2 AND kind='THUMBNAIL'`,[data.thumbnailId,userId])).rows[0];
    if (!thumbnail) throw new Error('The selected thumbnail does not belong to this account.');
  }
  if (data.captionFileId) {
    caption = (await query(`SELECT id FROM media_files WHERE id=$1 AND user_id=$2 AND kind='CAPTION'`,[data.captionFileId,userId])).rows[0];
    if (!caption) throw new Error('The selected caption file does not belong to this account.');
  }
  const automation = DateTime.fromFormat(`${data.automationDate} ${data.automationTime}`,'yyyy-MM-dd HH:mm',{ zone:settings.timezone });
  if (!automation.isValid) throw new Error('Automation date or time is invalid for the selected timezone.');
  let publishAt=null;
  if (data.visibility === 'SCHEDULE') {
    const publish = DateTime.fromFormat(`${data.youtubePublishDate} ${data.youtubePublishTime}`,'yyyy-MM-dd HH:mm',{ zone:settings.timezone });
    if (!publish.isValid) throw new Error('YouTube publish date/time is invalid.');
    if (publish <= automation) throw new Error('YouTube publish time must be later than the automation start time.');
    publishAt = publish.toUTC().toISO();
  }
  return { data,settings,media,thumbnail,caption,automationAt:automation.toUTC().toISO(),publishAt };
}

router.post('/app/uploads',async (req,res,next) => {
  try {
    const normalized = await normalizedSubmission(req.session.userId,req.body);
    const row = formToRow(normalized);
    const values = uploadValues(req.session.userId,row,normalized.media.id,normalized.thumbnail?.id || null,normalized.caption?.id || null,row.enabled ? 'READY' : 'PAUSED','');
    await query(`INSERT INTO uploads (user_id,${UPLOAD_COLUMNS}) VALUES (${values.map((_,i) => `$${i + 1}`).join(',')})`,values);
    await addLog(req.session.userId,'success',`${row.contentType === 'SHORT' ? 'Short' : 'Video'} added to queue.`,{ uploadId:row.uploadId });
    flash(req,'success','Upload added to the automation queue.');
    res.redirect('/app#queue');
  } catch (error) {
    if (error?.code === '23505') return next(new Error('That Upload ID already exists. Use a unique value.'));
    next(error);
  }
});

function formToRow({ data,media,automationAt,publishAt }) {
  return {
    uploadId:data.uploadId,contentType:data.contentType,videoFile:media.original_name,title:data.title,description:data.description,tags:data.tags,
    playlistName:data.playlistName,automationStartAt:automationAt,visibility:data.visibility,youtubePublishAt:publishAt,premiere:data.premiere,
    audience:data.audience,ageRestriction:data.ageRestriction,paidPromotion:data.paidPromotion,alteredContent:data.alteredContent,
    automaticChapters:data.automaticChapters,featuredPlaces:data.featuredPlaces,automaticConcepts:data.automaticConcepts,language:data.language,
    captionCertification:data.captionCertification,captionLanguage:data.captionLanguage,captionName:data.captionName,recordingDate:data.recordingDate || null,
    recordingLocation:data.recordingLocation,license:data.license,distribution:data.distribution,allowEmbedding:data.allowEmbedding,
    notifySubscribers:data.notifySubscribers,category:data.category,commentsMode:data.commentsMode,commentsSort:data.commentsSort,
    showLikeCount:data.showLikeCount,remixMode:data.remixMode,relatedVideo:data.relatedVideo,enabled:data.enabled
  };
}

router.get('/app/uploads/:id/edit',async (req,res,next) => {
  try {
    const [upload,media,settings] = await Promise.all([
      query(`SELECT * FROM uploads WHERE id=$1 AND user_id=$2`,[req.params.id,req.session.userId]),
      query('SELECT * FROM media_files WHERE user_id=$1 ORDER BY kind,created_at DESC',[req.session.userId]),
      settingsForUser(req.session.userId)
    ]);
    if (!upload.rowCount) return res.sendStatus(404);
    if (['UPLOADED','UPLOADING'].includes(upload.rows[0].status)) throw new Error('Uploaded or currently uploading items cannot be edited.');
    const item = upload.rows[0]; const zone = settings.timezone;
    const automation = DateTime.fromJSDate(new Date(item.automation_start_at)).setZone(zone);
    const publish = item.youtube_publish_at ? DateTime.fromJSDate(new Date(item.youtube_publish_at)).setZone(zone) : null;
    res.render('edit-upload',{ title:'Edit upload',item,media:media.rows,settings,automationDate:automation.toFormat('yyyy-MM-dd'),automationTime:automation.toFormat('HH:mm'),publishDate:publish?.toFormat('yyyy-MM-dd') || '',publishTime:publish?.toFormat('HH:mm') || '' });
  } catch (error) { next(error); }
});

router.post('/app/uploads/:id/edit',async (req,res,next) => {
  try {
    const current = await query('SELECT status FROM uploads WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]);
    if (!current.rowCount) return res.sendStatus(404);
    if (['UPLOADED','UPLOADING'].includes(current.rows[0].status)) throw new Error('Uploaded or currently uploading items cannot be edited.');
    const normalized = await normalizedSubmission(req.session.userId,req.body);
    const row = formToRow(normalized);
    const values = uploadValues(req.session.userId,row,normalized.media.id,normalized.thumbnail?.id || null,normalized.caption?.id || null,row.enabled ? 'READY' : 'PAUSED','');
    await query(
      `UPDATE uploads SET upload_id=$3,content_type=$4,media_id=$5,thumbnail_id=$6,caption_file_id=$7,media_file_hint=$8,title=$9,description=$10,tags=$11,
       playlist_name=$12,automation_start_at=$13,visibility=$14,youtube_publish_at=$15,premiere=$16,audience=$17,age_restriction=$18,
       paid_promotion=$19,altered_content=$20,automatic_chapters=$21,featured_places=$22,automatic_concepts=$23,language=$24,
       caption_certification=$25,caption_language=$26,caption_name=$27,recording_date=$28,recording_location=$29,license=$30,distribution=$31,
       allow_embedding=$32,notify_subscribers=$33,category=$34,comments_mode=$35,comments_sort=$36,show_like_count=$37,remix_mode=$38,
       related_video=$39,enabled=$40,status=$41,error='',attempts=0,updated_at=NOW() WHERE id=$1 AND user_id=$2`,
      [req.params.id,...values.slice(0,-1)]
    );
    await addLog(req.session.userId,'success','Queued upload updated.',{ uploadId:row.uploadId });
    flash(req,'success','Upload updated.'); res.redirect('/app#queue');
  } catch (error) {
    if (error?.code === '23505') { flash(req,'error','That Upload ID already exists.'); return res.redirect(`/app/uploads/${encodeURIComponent(req.params.id)}/edit`); }
    next(error);
  }
});

router.post('/app/uploads/:id/retry',async (req,res,next) => {
  try {
    const current = await query(
      `SELECT u.*,a.status AS account_status
         FROM uploads u
         LEFT JOIN youtube_accounts a ON a.user_id=u.user_id
        WHERE u.id=$1 AND u.user_id=$2`,
      [req.params.id,req.session.userId]
    );
    if (!current.rowCount) throw new Error('The upload could not be retried.');
    if (['ACCOUNT_ACTION_REQUIRED','PAUSED_FOR_VERIFICATION','RESUME_AVAILABLE','LOGIN_REQUIRED'].includes(current.rows[0].status) && current.rows[0].account_status !== 'CONNECTED') {
      flash(req,'error','Complete YouTube Studio verification and save the channel connection before retrying this upload.');
      return res.redirect('/app#channel');
    }
    const risk = assessDuplicateRisk(current.rows[0]);
    await addLog(req.session.userId,'info','Duplicate risk check completed.',{ uploadId:current.rows[0].upload_id,workflowStage:current.rows[0].workflow_stage,status:risk.risk,event:'duplicate_check_completed' });
    if (risk.reviewRequired) {
      await query(`UPDATE uploads SET status='REVIEW_REQUIRED',duplicate_risk=$3,error=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2`,[req.params.id,req.session.userId,risk.risk,risk.reason]);
      flash(req,'error',`Upload needs review before retry: ${risk.reason}`);
      return res.redirect('/app#queue');
    }
    if (risk.risk !== 'NONE' && req.body.confirmDuplicateRisk !== 'true') {
      flash(req,'error',`Duplicate risk is ${risk.risk}. Confirm resume from the queue before retrying.`);
      return res.redirect('/app#queue');
    }
    const result = await query(`UPDATE uploads SET status='READY',error='',enabled=TRUE,attempts=0,last_attempt_at=NULL,warnings='[]'::jsonb,duplicate_risk=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status<>'UPLOADED' RETURNING upload_id`,[req.params.id,req.session.userId,risk.risk]);
    if (!result.rowCount) throw new Error('The upload could not be retried. Completed uploads are immutable.');
    flash(req,'success','Upload moved back to READY.'); res.redirect('/app#queue');
  } catch (error) { next(error); }
});

router.post('/app/uploads/:id/resume',async (req,res,next) => {
  try {
    const current = await query(
      `SELECT u.*,a.status AS account_status
         FROM uploads u
         LEFT JOIN youtube_accounts a ON a.user_id=u.user_id
        WHERE u.id=$1 AND u.user_id=$2`,
      [req.params.id,req.session.userId]
    );
    if (!current.rowCount) throw new Error('The upload could not be resumed.');
    if (current.rows[0].account_status !== 'CONNECTED') {
      flash(req,'error','Complete and save the YouTube verification session before resuming this upload.');
      return res.redirect('/app#channel');
    }
    const risk = assessDuplicateRisk(current.rows[0]);
    await addLog(req.session.userId,'info','Duplicate risk check completed.',{ uploadId:current.rows[0].upload_id,workflowStage:current.rows[0].workflow_stage,status:risk.risk,event:'duplicate_check_completed' });
    if (risk.reviewRequired) {
      await query(`UPDATE uploads SET status='REVIEW_REQUIRED',duplicate_risk=$3,error=$4,updated_at=NOW() WHERE id=$1 AND user_id=$2`,[req.params.id,req.session.userId,risk.risk,risk.reason]);
      flash(req,'error',`Upload needs review before resume: ${risk.reason}`);
      return res.redirect('/app#queue');
    }
    if (risk.risk !== 'NONE' && req.body.confirmDuplicateRisk !== 'true') {
      flash(req,'error',`Duplicate risk is ${risk.risk}. Use the confirmed resume action.`);
      return res.redirect('/app#queue');
    }
    const result = await query(`UPDATE uploads SET status='READY',enabled=TRUE,error='',attempts=0,last_attempt_at=NULL,warnings='[]'::jsonb,duplicate_risk=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status IN ('RESUME_AVAILABLE','PAUSED_FOR_VERIFICATION','LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED') RETURNING upload_id`,[req.params.id,req.session.userId,risk.risk]);
    if (!result.rowCount) throw new Error('Only paused or resumable uploads can be resumed.');
    flash(req,'success','Upload resumed and moved to READY.');
    res.redirect('/app#queue');
  } catch (error) { next(error); }
});

router.post('/app/uploads/:id/cancel',async (req,res,next) => {
  try {
    const result = await query(`UPDATE uploads SET status='PAUSED',enabled=FALSE,error='Upload cancelled by user.',updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status<>'UPLOADED' RETURNING upload_id`,[req.params.id,req.session.userId]);
    if (!result.rowCount) throw new Error('The upload could not be cancelled.');
    await addLog(req.session.userId,'warning','Upload cancelled by user.',{ uploadId:result.rows[0].upload_id });
    flash(req,'success','Upload cancelled.');
    res.redirect('/app#queue');
  } catch (error) { next(error); }
});

router.post('/app/uploads/:id/toggle',async (req,res,next) => {
  try {
    const result = await query(`UPDATE uploads SET enabled=NOT enabled,status=CASE WHEN status='PAUSED' THEN 'READY' WHEN status='READY' THEN 'PAUSED' ELSE status END,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status NOT IN ('UPLOADED','UPLOADING') RETURNING enabled`,[req.params.id,req.session.userId]);
    if (!result.rowCount) throw new Error('This upload cannot be paused now.');
    flash(req,'success',result.rows[0].enabled ? 'Upload enabled.' : 'Upload paused.'); res.redirect('/app#queue');
  } catch (error) { next(error); }
});

router.post('/app/uploads/:id/delete',async (req,res,next) => {
  try {
    const result = await query(`DELETE FROM uploads WHERE id=$1 AND user_id=$2 AND status<>'UPLOADING' RETURNING upload_id`,[req.params.id,req.session.userId]);
    if (!result.rowCount) throw new Error('An upload cannot be deleted while processing.');
    flash(req,'success','Queued upload deleted.'); res.redirect('/app#queue');
  } catch (error) { next(error); }
});

router.post('/app/media/:id/delete',async (req,res,next) => {
  try {
    const used = await query('SELECT COUNT(*)::int AS count FROM uploads WHERE user_id=$1 AND (media_id=$2 OR thumbnail_id=$2 OR caption_file_id=$2)',[req.session.userId,req.params.id]);
    if (used.rows[0].count > 0) throw new Error('This file is used by a queued upload. Update or delete that upload first.');
    const result = await query('DELETE FROM media_files WHERE id=$1 AND user_id=$2 RETURNING relative_path,original_name',[req.params.id,req.session.userId]);
    if (!result.rowCount) throw new Error('File not found.');
    await removeStoredFile(result.rows[0].relative_path);
    flash(req,'success','File deleted.'); res.redirect('/app#library');
  } catch (error) { next(error); }
});

router.post('/app/settings',async (req,res,next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) { flash(req,'error',firstZodError(parsed.error)); return res.redirect('/app#settings'); }
    if (!IANAZone.isValidZone(parsed.data.timezone)) throw new Error('Enter a valid IANA timezone, such as Asia/Kolkata.');
    const d = parsed.data;
    await query(`UPDATE user_settings SET automation_enabled=$2,maximum_uploads_per_day=$3,minimum_gap_minutes=$4,max_attempts=$5,retry_delay_minutes=$6,
      timezone=$7,upload_window_start=$8,upload_window_end=$9,default_visibility=$10,default_audience=$11,default_category=$12,default_language=$13,updated_at=NOW() WHERE user_id=$1`,
      [req.session.userId,d.automationEnabled,d.maximumUploadsPerDay,d.minimumGapMinutes,d.maxAttempts,d.retryDelayMinutes,d.timezone,d.uploadWindowStart,d.uploadWindowEnd,d.defaultVisibility,d.defaultAudience,d.defaultCategory,d.defaultLanguage]);
    flash(req,'success','Automation settings saved.'); res.redirect('/app#settings');
  } catch (error) { next(error); }
});

router.post('/app/youtube/connect',async (req,res,next) => { try { await startYouTubeLogin(req.session.userId); flash(req,'info','Remote YouTube Studio opened. Complete login, then save the connection.'); res.redirect('/app/youtube/connect'); } catch (error) { next(error); } });
router.get('/app/youtube/connect',async (req,res,next) => { try { const session=loginSessionStatus(req.session.userId); if (!session.active) { flash(req,'error','The YouTube connection window is not active.'); return res.redirect('/app#channel'); } res.render('youtube-connect',{ title:'Connect YouTube',session }); } catch (error) { next(error); } });
router.get('/app/youtube/remote',async (req,res,next) => {
  try {
    if (req.query.restart === '1') await restartYouTubeLogin(req.session.userId);
    else await startYouTubeLogin(req.session.userId);
    const session = issueRemoteBrowserUrl(req.session.userId);
    res.redirect(session.remoteUrl);
  } catch (error) { next(error); }
});
router.post('/app/youtube/check',async (req,res,next) => {
  try {
    const account = await query('SELECT id FROM youtube_accounts WHERE user_id=$1',[req.session.userId]);
    if (!account.rowCount) throw new Error('No YouTube channel record was found.');
    const result = await checkYouTubeSession({ userId:req.session.userId, channelId:account.rows[0].id });
    flash(req,result.status === 'HEALTHY' ? 'success' : 'warning',`Session health: ${result.status}.`);
    res.redirect('/app#channel');
  } catch (error) { next(error); }
});
router.post('/app/youtube/complete',async (req,res,next) => {
  try {
    await completeYouTubeLogin(req.session.userId);
    flash(req,'success','YouTube connected. Scheduled uploads can run in the backend.');
    res.redirect('/app#channel');
  } catch (error) {
    if (loginSessionStatus(req.session.userId).active) {
      flash(req,'error',error.message || 'Complete Google login before saving the connection.');
      return res.redirect('/app/youtube/connect');
    }
    next(error);
  }
});
router.post('/app/youtube/cancel',async (req,res,next) => { try { await cancelYouTubeLogin(req.session.userId); flash(req,'info','YouTube connection window closed.'); res.redirect('/app#channel'); } catch (error) { next(error); } });
router.post('/app/youtube/disconnect',async (req,res,next) => { try { await disconnectYouTube(req.session.userId); flash(req,'success','YouTube session deleted securely.'); res.redirect('/app#channel'); } catch (error) { next(error); } });

router.get('/app/screenshots/:name',async (req,res,next) => {
  try {
    const name=path.basename(String(req.params.name || ''));
    if (!/^[a-zA-Z0-9._-]+\.png$/i.test(name)) return res.sendStatus(404);
    const filePath=path.resolve(config.storageDir,'users',String(req.session.userId),config.screenshotFolderName,name);
    await fs.access(filePath); res.download(filePath,name);
  } catch (error) { if (error?.code === 'ENOENT') return res.sendStatus(404); next(error); }
});
router.get('/app/media/:id/download',async (req,res,next) => {
  try { const result=await query('SELECT * FROM media_files WHERE id=$1 AND user_id=$2',[req.params.id,req.session.userId]); if (!result.rowCount) return res.sendStatus(404); res.download(absoluteStoragePath(result.rows[0].relative_path),result.rows[0].original_name); }
  catch (error) { next(error); }
});

export default router;
