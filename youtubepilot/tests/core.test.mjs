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
import { authSuccessDestination } from '../src/routes/auth.js';
import { browserExecutableCandidates, visibleBrowserExecutable } from '../src/services/chrome-runtime.js';

process.env.SESSION_ENCRYPTION_KEY = Buffer.alloc(32,7).toString('base64');

test('encrypted session round-trip and tamper rejection', () => {
  const encrypted = encryptJson({ cookies:[{ name:'SID',value:'secret' }] });
  assert.deepEqual(decryptJson(encrypted),{ cookies:[{ name:'SID',value:'secret' }] });
  const tamperSuffix = encrypted.endsWith('A') ? 'B' : 'A';
  assert.throws(() => decryptJson(`${encrypted.slice(0,-1)}${tamperSuffix}`));
});

test('successful auth always redirects to app dashboard', () => {
  const session = { returnTo:'/app/youtube/connect' };
  assert.equal(authSuccessDestination(session),'/app');
  assert.equal('returnTo' in session,false);
});

test('secure login browser detection supports Playwright Chromium', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'ytpilot-browser-'));
  const browserPath = path.join(directory,'chromium-999','chrome-linux','chrome');
  await fs.mkdir(path.dirname(browserPath),{ recursive:true });
  await fs.writeFile(browserPath,'');
  assert.equal(browserExecutableCandidates({ PLAYWRIGHT_BROWSERS_PATH:directory }).includes(browserPath),true);

  const originalVisibleChromePath = process.env.VISIBLE_CHROME_PATH;
  process.env.VISIBLE_CHROME_PATH = process.execPath;
  try {
    assert.equal(visibleBrowserExecutable(),process.execPath);
  } finally {
    if (originalVisibleChromePath === undefined) delete process.env.VISIBLE_CHROME_PATH;
    else process.env.VISIBLE_CHROME_PATH = originalVisibleChromePath;
    await fs.rm(directory,{ recursive:true,force:true });
  }
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
