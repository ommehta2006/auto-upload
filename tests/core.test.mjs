import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XlsxPopulate from 'xlsx-populate';
import { encryptJson, decryptJson } from '../src/services/crypto.js';
import { validateContentType } from '../src/services/media-probe.js';
import { uploadSchema } from '../src/validation.js';
import { parseUploadsWorkbook } from '../src/services/excel.js';
import { browserProfileDir, ensureChannelProfile } from '../src/services/persistent-browser.js';
import { assessDuplicateRisk } from '../src/services/duplicate-risk.js';

process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32,7).toString('base64');

test('encrypted session round-trip and tamper rejection', () => {
  const encrypted = encryptJson({ cookies:[{ name:'SID',value:'secret' }] });
  assert.deepEqual(decryptJson(encrypted),{ cookies:[{ name:'SID',value:'secret' }] });
  assert.throws(() => decryptJson(`${encrypted.slice(0,-1)}x`));
});

test('Short validation accepts vertical <=180s and rejects landscape/long', () => {
  assert.doesNotThrow(() => validateContentType({ width:1080,height:1920,durationSeconds:179.9 },'SHORT'));
  assert.throws(() => validateContentType({ width:1920,height:1080,durationSeconds:30 },'SHORT'),/vertical or square/i);
  assert.throws(() => validateContentType({ width:1080,height:1920,durationSeconds:181 },'SHORT'),/three minutes/i);
});

test('form validation requires publish time for scheduled visibility and blocks Short premiere', () => {
  const base = {
    uploadId:'TEST-1',contentType:'VIDEO',mediaId:'00000000-0000-4000-8000-000000000001',title:'Test',description:'',tags:'',playlistName:'',
    automationDate:'2026-08-01',automationTime:'10:00',visibility:'PRIVATE',premiere:'false',audience:'NOT_MADE_FOR_KIDS',ageRestriction:'false',
    paidPromotion:'false',alteredContent:'false',automaticChapters:'true',featuredPlaces:'true',automaticConcepts:'true',language:'',captionCertification:'NONE',
    captionLanguage:'',captionName:'',recordingLocation:'',license:'STANDARD',distribution:'EVERYWHERE',allowEmbedding:'true',notifySubscribers:'true',
    category:'22',commentsMode:'ALLOW_ALL',commentsSort:'TOP',showLikeCount:'true',remixMode:'VIDEO_AND_AUDIO',relatedVideo:'',enabled:'true'
  };
  assert.equal(uploadSchema.safeParse(base).success,true);
  assert.equal(uploadSchema.safeParse({ ...base,visibility:'SCHEDULE' }).success,false);
  assert.equal(uploadSchema.safeParse({ ...base,contentType:'SHORT',premiere:'true' }).success,false);
});

test('Excel parser reads Videos and Shorts sheets', async () => {
  const workbook = await XlsxPopulate.fromBlankAsync();
  workbook.sheet(0).name('Videos').cell('A1').value([['Upload ID','Enabled','Video File','Title','Automation Date','Automation Time','Visibility'],['VID-1',true,'video.mp4','Video title','2026-08-01','10:00','PRIVATE']]);
  workbook.addSheet('Shorts').cell('A1').value([['Upload ID','Enabled','Video File','Title','Automation Date','Automation Time','Visibility'],['SHORT-1',true,'short.mp4','Short title','2026-08-01','11:00','UNLISTED']]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'ytpilot-'));
  const file = path.join(directory,'plan.xlsx');
  await workbook.toFileAsync(file);
  const rows = await parseUploadsWorkbook(file,'Asia/Kolkata');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row => row.contentType),['VIDEO','SHORT']);
  assert.equal(rows.every(row => !row.validationError),true);
  await fs.rm(directory,{ recursive:true,force:true });
});

test('persistent browser profile paths are isolated by user and channel', async () => {
  const userA = '00000000-0000-4000-8000-000000000001';
  const userB = '00000000-0000-4000-8000-000000000002';
  const channelA = '00000000-0000-4000-8000-000000000101';
  const channelB = '00000000-0000-4000-8000-000000000102';
  const a = browserProfileDir(userA, channelA);
  assert.notEqual(a, browserProfileDir(userA, channelB));
  assert.notEqual(a, browserProfileDir(userB, channelA));
  assert.match(a, /browser-profiles/);
  assert.throws(() => browserProfileDir('../bad', channelA), /Invalid user identifier/);
  assert.throws(() => browserProfileDir(userA, '../../bad'), /Invalid channel identifier/);
});

test('persistent browser profile directory is created with private permissions', async () => {
  const userId = '00000000-0000-4000-8000-000000000011';
  const channelId = '00000000-0000-4000-8000-000000000111';
  const directory = await ensureChannelProfile(userId, channelId);
  const stat = await fs.stat(directory);
  assert.equal(stat.isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o700);
});

test('duplicate risk follows interrupted upload stage', () => {
  assert.deepEqual(assessDuplicateRisk({ workflow_stage:'BEFORE_FILE_SELECTION' }), {
    risk:'NONE',
    reviewRequired:false,
    reason:'Upload stopped before file selection.'
  });
  assert.equal(assessDuplicateRisk({ workflow_stage:'FILE_SELECTED' }).risk, 'POSSIBLE');
  assert.equal(assessDuplicateRisk({ workflow_stage:'SAVE_OR_PUBLISH_CLICKED' }).reviewRequired, true);
  assert.equal(assessDuplicateRisk({ workflow_stage:'COMPLETION_CONFIRMED', youtube_url:'https://youtu.be/testid' }).risk, 'HIGH');
});
