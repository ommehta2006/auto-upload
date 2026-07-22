import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { probeVideo, validateContentType } from './media-probe.js';

export class YouTubeAutomationError extends Error {
  constructor(message, code = 'AUTOMATION_FAILED', options = {}) {
    super(message);
    this.name = 'YouTubeAutomationError';
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.outcomeUncertain = options.outcomeUncertain ?? false;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const YOUTUBE_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const ACCOUNT_VERIFICATION_PATTERN = /verify it'?s you|verify it’s you|suspicious activity|confirm your identity|to continue, we need to confirm|check your phone|enter the code|two-step verification/i;
const ACCOUNT_VERIFICATION_WAIT_MS = 10 * 60_000;

async function visible(locator, timeout = 1200) {
  return locator?.first().isVisible({ timeout }).catch(() => false);
}

async function clickCandidates(candidates, timeout = 2500) {
  for (const candidate of candidates) {
    const locator = typeof candidate === 'function' ? candidate() : candidate;
    if (await visible(locator, Math.min(timeout, 1500))) {
      try { await locator.first().click({ timeout }); return true; } catch {}
    }
  }
  return false;
}

async function fillCandidates(candidates, value, timeout = 3000) {
  for (const candidate of candidates) {
    const locator = typeof candidate === 'function' ? candidate() : candidate;
    if (!(await visible(locator, 1200))) continue;
    try {
      const target = locator.first();
      if (await target.getAttribute('contenteditable').catch(() => null)) {
        await target.click();
        await target.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
        await target.fill(String(value));
      } else {
        await target.fill(String(value), { timeout });
      }
      return true;
    } catch {}
  }
  return false;
}

async function dismissObstructions(page, log = () => {}) {
  const studioSkip = [
    page.getByRole('link', { name:/skip to youtube studio/i }),
    page.getByText(/^skip to youtube studio$/i),
    page.locator('a,button,tp-yt-paper-button,ytcp-button,paper-button').filter({ hasText:/skip to youtube studio/i })
  ];
  for (const candidate of studioSkip) {
    if (await visible(candidate, 500)) {
      if (await candidate.first().click({ timeout: 1500 }).then(() => true).catch(() => false)) {
        log('info', 'Skipped YouTube Studio unsupported-browser interstitial.');
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        await sleep(2000);
        return 1;
      }
    }
  }

  const labels = [/^got it$/i,/^dismiss$/i,/^no thanks$/i,/^skip$/i,/^not now$/i,/^close$/i,/^okay$/i,/^understood$/i,/^maybe later$/i];
  let dismissed = 0;
  for (const label of labels) {
    const buttons = page.getByRole('button', { name: label });
    const count = Math.min(await buttons.count().catch(() => 0), 5);
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (!(await visible(button, 300))) continue;
      const dialogText = await button.locator('xpath=ancestor::*[@role="dialog"][1]').innerText().catch(() => '');
      if (/details|video elements|checks|visibility|upload videos/i.test(dialogText)) continue;
      if (await button.click({ timeout: 1200 }).then(() => true).catch(() => false)) {
        dismissed += 1;
        await sleep(150);
      }
    }
  }
  const closeButtons = page.locator('ytcp-dialog:not(ytcp-uploads-dialog) #close-button, tp-yt-iron-dropdown:not([aria-hidden="true"]) [aria-label="Close"]');
  const closeCount = Math.min(await closeButtons.count().catch(() => 0), 3);
  for (let i = 0; i < closeCount; i += 1) {
    const button = closeButtons.nth(i);
    if (await visible(button, 200)) {
      await button.click({ timeout: 1000 }).catch(() => {});
      dismissed += 1;
    }
  }
  if (dismissed) log('info', `Dismissed ${dismissed} non-blocking YouTube popup${dismissed === 1 ? '' : 's'}.`);
  return dismissed;
}

async function hasAccountVerification(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  return ACCOUNT_VERIFICATION_PATTERN.test(body);
}

async function waitForManualAccountApproval(page, log = () => {}, captureVerificationScreenshot = async () => '') {
  if (!(await hasAccountVerification(page))) return false;
  await clickCandidates([
    page.locator('[role="dialog"]').getByRole('button', { name:/^next$/i }),
    page.getByRole('button', { name:/^next$/i }),
    page.getByText(/^next$/i),
    page.getByRole('button', { name:/verify now|continue|yes,? it'?s me/i }),
    page.locator('button,[role="button"]').filter({ hasText:/verify now|continue|yes,? it'?s me/i })
  ], 5000);
  await sleep(2500);
  const screenshot = await captureVerificationScreenshot().catch(() => '');
  if (screenshot) {
    log('warning', 'Google verification challenge screenshot captured.', { screenshot });
  }
  log('warning', 'Google account verification is waiting for manual approval. The worker will wait up to 10 minutes.');
  const started = Date.now();
  while (Date.now() - started < ACCOUNT_VERIFICATION_WAIT_MS) {
    if (!(await hasAccountVerification(page))) {
      log('info', 'Google account verification cleared; continuing upload.');
      await sleep(2500);
      return true;
    }
    await sleep(5000);
  }
  throw new YouTubeAutomationError('Google account verification was not approved within 10 minutes.', 'ACCOUNT_ACTION_REQUIRED', { retryable:false });
}

async function assertLoggedIn(page, log = () => {}, captureVerificationScreenshot = async () => '') {
  const url = page.url().toLowerCase();
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (url.includes('accounts.google.com') || url.includes('servicelogin') || /sign in to continue to youtube/i.test(body)) {
    throw new YouTubeAutomationError('YouTube login is required. Reconnect the channel.', 'LOGIN_REQUIRED', { retryable:false });
  }
  if (/couldn'?t sign you in/i.test(body)) {
    throw new YouTubeAutomationError('Google could not sign in with this browser session. Reconnect the channel and complete Google login.', 'ACCOUNT_ACTION_REQUIRED', { retryable:false });
  }
  if (ACCOUNT_VERIFICATION_PATTERN.test(body)) {
    await waitForManualAccountApproval(page, log, captureVerificationScreenshot);
  }
}

async function waitForStudioReady(page, log = () => {}, captureVerificationScreenshot = async () => '') {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    await dismissObstructions(page, log);
    await assertLoggedIn(page, log, captureVerificationScreenshot);
    const createVisible = await visible(page.locator('#create-icon'), 600)
      || await visible(page.getByRole('button', { name:/create/i }), 600)
      || await visible(page.getByText(/^create$/i), 600)
      || await visible(page.getByText(/upload videos?/i), 600);
    if (createVisible) return;
    await sleep(1500);
  }
}

async function openUploadDialog(page) {
  await dismissObstructions(page);
  const createClicked = await clickCandidates([
    page.locator('#create-icon'),
    page.locator('ytcp-button#create-icon'),
    page.getByRole('button', { name:/create/i }),
    page.getByText(/^create$/i)
  ], 4000);
  if (!createClicked) throw new YouTubeAutomationError('The YouTube Studio Create button was not found.');
  await sleep(500);
  await dismissObstructions(page);
  const uploadClicked = await clickCandidates([
    page.getByText(/^upload videos?$/i),
    page.getByRole('menuitem', { name:/upload videos?/i }),
    page.locator('tp-yt-paper-item').filter({ hasText:/upload videos?/i })
  ], 5000);
  if (!uploadClicked) throw new YouTubeAutomationError('The Upload videos action was not found.');
}

async function chooseVideoFile(page, videoPath) {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state:'attached', timeout:20_000 }).catch(() => {});
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = inputs.nth(i);
    const accept = String(await candidate.getAttribute('accept').catch(() => '') || '');
    if (!accept || /video|mp4|mov|webm|\*/i.test(accept)) {
      try { await candidate.setInputFiles(videoPath); return; } catch {}
    }
  }
  throw new YouTubeAutomationError('The YouTube video file picker could not be controlled.');
}

async function waitForDetails(page, log = () => {}, captureVerificationScreenshot = async () => '') {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await assertLoggedIn(page, log, captureVerificationScreenshot);
    const ready = await visible(page.locator('#title-textarea #textbox'), 700)
      || await visible(page.getByText(/^details$/i), 700)
      || await visible(page.getByText(/is this video made for kids/i), 700);
    if (ready) return;
    await sleep(1200);
  }
  throw new YouTubeAutomationError('YouTube did not open the video details screen after selecting the file.');
}

async function setTextBox(page, kind, value, required = false) {
  if (!value && !required) return true;
  const map = {
    title: [page.locator('#title-textarea #textbox'),page.locator('ytcp-social-suggestion-input').first().locator('#textbox'),page.getByLabel(/title/i).first()],
    description: [page.locator('#description-textarea #textbox'),page.locator('ytcp-social-suggestion-input').nth(1).locator('#textbox'),page.getByLabel(/description/i).first()]
  };
  const ok = await fillCandidates(map[kind] || [], value, 5000);
  if (!ok && required) throw new YouTubeAutomationError(`The YouTube ${kind} field could not be filled.`);
  return ok;
}

async function setThumbnail(page, thumbnailPath) {
  if (!thumbnailPath) return false;
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = inputs.nth(i);
    const accept = String(await candidate.getAttribute('accept').catch(() => '') || '');
    if (/image|png|jpeg|jpg|webp/i.test(accept)) {
      await candidate.setInputFiles(thumbnailPath);
      return true;
    }
  }
  return false;
}

async function chooseByText(page, pattern) {
  const target = page.getByText(pattern, { exact:false }).first();
  if (!(await visible(target, 1200))) return false;
  const clickable = target.locator('xpath=ancestor-or-self::*[self::tp-yt-paper-radio-button or self::tp-yt-paper-checkbox or self::ytcp-checkbox-lit or @role="radio" or @role="checkbox" or @role="option" or self::button][1]');
  if (await visible(clickable, 300)) return clickable.click({ timeout:2500 }).then(() => true).catch(() => false);
  return target.click({ timeout:2500 }).then(() => true).catch(() => false);
}

async function setAudience(page, post) {
  const pattern = post.audience === 'MADE_FOR_KIDS' ? /yes, it'?s made for kids/i : /no, it'?s not made for kids/i;
  if (!(await chooseByText(page, pattern))) throw new YouTubeAutomationError('The required audience setting could not be selected.');
  if (post.age_restriction) {
    await chooseByText(page, /yes, restrict my video to viewers over 18|restrict.*18/i);
  }
}

async function showMore(page) {
  return clickCandidates([
    page.getByRole('button', { name:/show more/i }),
    page.getByText(/^show more$/i),
    page.locator('#toggle-button').filter({ hasText:/show more/i })
  ], 4000);
}

async function setCheckboxNearText(page, pattern, desired) {
  const text = page.getByText(pattern, { exact:false }).first();
  if (!(await visible(text, 800))) return false;
  const checkbox = text.locator('xpath=ancestor::*[self::ytcp-checkbox-lit or self::tp-yt-paper-checkbox or @role="checkbox"][1]');
  const target = (await visible(checkbox, 300)) ? checkbox : text.locator('xpath=ancestor::*[1]').locator('ytcp-checkbox-lit,tp-yt-paper-checkbox,[role="checkbox"]').first();
  if (!(await visible(target, 500))) return false;
  const checked = (await target.getAttribute('aria-checked').catch(() => null)) === 'true' || await target.evaluate(el => Boolean(el.checked)).catch(() => false);
  if (checked !== desired) await target.click({ timeout:2500 });
  return true;
}

async function setTags(page, tags) {
  if (!tags) return true;
  return fillCandidates([
    page.locator('#tags-container input'),
    page.locator('ytcp-free-text-chip-bar input'),
    page.getByLabel(/tags/i)
  ], tags, 4000);
}

async function openDropdownNearLabel(page, labelPattern) {
  const label = page.getByText(labelPattern, { exact:false }).first();
  if (!(await visible(label, 800))) return false;
  const container = label.locator('xpath=ancestor::*[self::ytcp-dropdown-trigger or self::ytcp-form-input-container or self::div][1]');
  const trigger = container.locator('ytcp-dropdown-trigger,tp-yt-paper-dropdown-menu,[role="button"],#label').first();
  if (await visible(trigger, 500)) return trigger.click({ timeout:2500 }).then(() => true).catch(() => false);
  return label.click({ timeout:2500 }).then(() => true).catch(() => false);
}

async function selectDropdown(page, labelPattern, optionPattern) {
  if (!(await openDropdownNearLabel(page, labelPattern))) return false;
  await sleep(300);
  const option = page.getByText(optionPattern, { exact:false }).last();
  if (!(await visible(option, 1200))) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  return option.click({ timeout:2500 }).then(() => true).catch(() => false);
}

async function setPlaylist(page, playlistName) {
  if (!playlistName) return true;
  const opened = await clickCandidates([
    page.getByText(/^select$/i).first(),
    page.getByText(/playlist/i).locator('xpath=following::*[@role="button"][1]'),
    page.locator('ytcp-video-metadata-playlists #container')
  ], 3000);
  if (!opened) return false;
  await sleep(300);
  const option = page.getByText(new RegExp(`^${playlistName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'i')).first();
  if (!(await visible(option, 1500))) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  await option.click();
  await clickCandidates([page.getByRole('button',{ name:/done/i }),page.getByText(/^done$/i)],2000);
  return true;
}

async function applyAdvancedSettings(page, post, warnings) {
  const safe = async (name, action) => {
    try { if (!(await action())) warnings.push(`${name} was not available in the current YouTube Studio interface.`); }
    catch (error) { warnings.push(`${name}: ${error.message}`); }
  };
  await showMore(page);
  await dismissObstructions(page);
  await safe('Paid promotion', () => setCheckboxNearText(page,/paid promotion|contains paid promotion/i,post.paid_promotion));
  await safe('Altered content disclosure', () => setCheckboxNearText(page,/altered or synthetic|altered content/i,post.altered_content));
  await safe('Automatic chapters', () => setCheckboxNearText(page,/automatic chapters/i,post.automatic_chapters));
  await safe('Featured places', () => setCheckboxNearText(page,/featured places/i,post.featured_places));
  await safe('Automatic concepts', () => setCheckboxNearText(page,/automatic concepts/i,post.automatic_concepts));
  await safe('Tags', () => setTags(page,post.tags));
  if (post.language) await safe('Video language', () => selectDropdown(page,/video language|language/i,new RegExp(post.language,'i')));
  if (post.caption_certification && post.caption_certification !== 'NONE') await safe('Caption certification', () => selectDropdown(page,/caption certification/i,new RegExp(post.caption_certification.replaceAll('_',' '),'i')));
  if (post.recording_date) await safe('Recording date', () => fillCandidates([page.getByLabel(/recording date/i),page.locator('input[type="date"]')],String(post.recording_date).slice(0,10)));
  if (post.recording_location) await safe('Recording location', () => fillCandidates([page.getByLabel(/video location|recording location/i)],post.recording_location));
  await safe('License', () => selectDropdown(page,/license/i,post.license === 'CREATIVE_COMMONS' ? /creative commons/i : /standard youtube license/i));
  await safe('Distribution', () => selectDropdown(page,/distribution/i,post.distribution === 'MONETIZED_PLATFORMS' ? /monetized platforms/i : /everywhere/i));
  await safe('Allow embedding', () => setCheckboxNearText(page,/allow embedding/i,post.allow_embedding));
  await safe('Notify subscribers', () => setCheckboxNearText(page,/publish to subscriptions feed|notify subscribers/i,post.notify_subscribers));
  await safe('Category', () => selectDropdown(page,/category/i,new RegExp(categoryLabel(post.category),'i')));
  await safe('Comments', async () => {
    if (post.comments_mode === 'DISABLE') return setCheckboxNearText(page,/allow comments/i,false);
    const map = {
      ALLOW_ALL:/allow all comments/i,
      HOLD_POTENTIALLY_INAPPROPRIATE:/hold potentially inappropriate/i,
      INCREASE_STRICTNESS:/increase strictness/i,
      HOLD_ALL:/hold all comments/i
    };
    return selectDropdown(page,/comments and ratings|comment visibility/i,map[post.comments_mode]);
  });
  await safe('Comment sorting', () => selectDropdown(page,/sort by/i,post.comments_sort === 'NEWEST' ? /newest/i : /top/i));
  await safe('Show like count', () => setCheckboxNearText(page,/show how many viewers like/i,post.show_like_count));
  if (post.content_type === 'SHORT') {
    const remixPattern = post.remix_mode === 'NONE' ? /don'?t allow remixing|none/i : post.remix_mode === 'AUDIO_ONLY' ? /allow only audio remixing|audio only/i : /allow video and audio remixing|video and audio/i;
    await safe('Shorts remixing', () => selectDropdown(page,/shorts remixing|remixing/i,remixPattern));
    if (post.related_video) await safe('Related video', () => fillCandidates([page.getByLabel(/related video/i)],post.related_video));
  }
}

function categoryLabel(category) {
  return ({'1':'Film & Animation','2':'Autos & Vehicles','10':'Music','15':'Pets & Animals','17':'Sports','19':'Travel & Events','20':'Gaming','22':'People & Blogs','23':'Comedy','24':'Entertainment','25':'News & Politics','26':'Howto & Style','27':'Education','28':'Science & Technology','29':'Nonprofits & Activism'})[String(category)] || String(category);
}

async function nextStep(page) {
  await dismissObstructions(page);
  const button = page.locator('#next-button').first();
  if (await visible(button, 1000)) {
    await button.waitFor({ state:'visible', timeout:5000 });
    for (let i=0;i<30;i+=1) {
      const disabled = await button.getAttribute('disabled').catch(() => null);
      const ariaDisabled = await button.getAttribute('aria-disabled').catch(() => null);
      if (disabled === null && ariaDisabled !== 'true') { await button.click(); return true; }
      await sleep(1000); await dismissObstructions(page);
    }
  }
  return clickCandidates([page.getByRole('button',{ name:/^next$/i }),page.getByText(/^next$/i)],4000);
}

async function reachVisibility(page) {
  for (let i=0;i<3;i+=1) {
    if (!(await nextStep(page))) throw new YouTubeAutomationError(`YouTube could not continue past upload step ${i + 1}.`);
    await sleep(700);
  }
  await page.getByText(/^visibility$/i).waitFor({ state:'visible', timeout:20_000 }).catch(() => {});
}

async function setVisibility(page, post) {
  const map = { PUBLIC:/public/i, PRIVATE:/private/i, UNLISTED:/unlisted/i, SCHEDULE:/schedule/i };
  const selected = await chooseByText(page,map[post.visibility]);
  if (!selected) throw new YouTubeAutomationError(`The ${post.visibility.toLowerCase()} visibility option was not found.`);
  if (post.visibility === 'SCHEDULE') {
    const publishAt = new Date(post.youtube_publish_at);
    if (Number.isNaN(publishAt.getTime())) throw new YouTubeAutomationError('The scheduled YouTube publish date is invalid.','INVALID_SCHEDULE',{ retryable:false });
    const localDate = post.youtube_publish_local_date;
    const localTime = post.youtube_publish_local_time;
    const dateOk = await fillCandidates([page.getByLabel(/date/i),page.locator('#datepicker-trigger input'),page.locator('ytcp-date-picker input')],localDate,4000);
    const timeOk = await fillCandidates([page.getByLabel(/time/i),page.locator('ytcp-time-of-day-input input'),page.locator('input[aria-label*="Time" i],input[placeholder*="Time" i],input[type="time"]')],localTime,4000);
    if (!dateOk || !timeOk) throw new YouTubeAutomationError('YouTube scheduling date or time could not be filled.');
    if (post.premiere) await setCheckboxNearText(page,/set as premiere|premiere/i,true);
  }
}

async function finalize(page, post) {
  const label = post.visibility === 'PUBLIC' ? /publish/i : post.visibility === 'SCHEDULE' ? /schedule/i : /save/i;
  const clicked = await clickCandidates([
    page.locator('#done-button'),
    page.getByRole('button',{ name:label }),
    page.getByText(new RegExp(`^${label.source}$`,'i'))
  ],6000);
  if (!clicked) throw new YouTubeAutomationError('The final YouTube save/publish button was not found.');
  const started = Date.now();
  let lastText = '';
  while (Date.now() - started < config.processingWaitMs) {
    await dismissObstructions(page);
    const body = await page.locator('body').innerText().catch(() => '');
    lastText = body;
    if (/video published|video uploaded|video scheduled|checks complete|saved as private|upload complete/i.test(body)) break;
    const dialogVisible = await page.locator('ytcp-uploads-dialog').isVisible().catch(() => false);
    if (!dialogVisible) break;
    await sleep(1500);
  }
  const hrefs = await page.locator('a[href*="youtu.be"],a[href*="youtube.com/watch"],a[href*="youtube.com/shorts"]').evaluateAll(nodes => nodes.map(node => node.href)).catch(() => []);
  const textUrl = lastText.match(/https?:\/\/(?:www\.)?(?:youtu\.be\/[A-Za-z0-9_-]{6,}|youtube\.com\/(?:watch\?v=|shorts\/)[A-Za-z0-9_-]{6,})/i)?.[0] || '';
  const url = hrefs.find(Boolean) || textUrl;
  const videoId = url.match(/(?:youtu\.be\/|v=|shorts\/)([A-Za-z0-9_-]{6,})/)?.[1] || '';
  const successText = /video published|video uploaded|video scheduled|saved as private|upload complete/i.test(lastText);
  if (!url && !successText) {
    throw new YouTubeAutomationError('YouTube did not provide a definite completion result. Review the channel before retrying to avoid a duplicate.', 'REVIEW_REQUIRED', { retryable:false, outcomeUncertain:true });
  }
  return { url, videoId };
}

async function tryUploadCaptions(page, post, captionPath, warnings) {
  if (!captionPath) return;
  if (!post.youtube_video_id) { warnings.push('Caption file could not be attached because YouTube did not return a video ID.'); return; }
  try {
    await page.goto(`https://studio.youtube.com/video/${post.youtube_video_id}/translations`, { waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    await dismissObstructions(page);
    const add = await clickCandidates([page.getByText(/^add$/i),page.getByRole('button',{ name:/add subtitles|upload file/i })],4000);
    if (!add) throw new Error('caption controls were not found');
    const upload = await clickCandidates([page.getByText(/upload file/i),page.getByRole('button',{ name:/upload file/i })],3000);
    if (!upload) throw new Error('caption upload action was not found');
    const input = page.locator('input[type="file"]').last();
    await input.setInputFiles(captionPath);
    warnings.push('Caption file was submitted; verify timing and publication in YouTube Studio.');
  } catch (error) {
    warnings.push(`Caption upload needs review: ${error.message}.`);
  }
}

export async function uploadToYouTube({ post, storageState, videoPath, thumbnailPath, captionPath, screenshotPath, log = () => {} }) {
  const warnings = [];
  const probe = validateContentType(await probeVideo(videoPath), post.content_type);
  log('info','Video file validated.',probe);
  let browser; let context; let page; let popupTimer;
  let verificationScreenshotName = '';
  try {
    browser = await chromium.launch({
      headless:config.browserHeadless,
      slowMo:config.slowMoMs,
      args:['--no-sandbox','--disable-dev-shm-usage','--disable-notifications','--no-first-run','--disable-features=Translate,MediaRouter','--window-size=1440,1000']
    });
    context = await browser.newContext({ locale:'en-US', timezoneId:post.timezone || 'Asia/Kolkata', viewport:{ width:1440,height:1000 }, storageState, userAgent:YOUTUBE_USER_AGENT, acceptDownloads:false });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();
    const captureVerificationScreenshot = async () => {
      if (!page || !screenshotPath) return '';
      if (verificationScreenshotName) return verificationScreenshotName;
      const parsed = path.parse(screenshotPath);
      const verificationPath = path.join(parsed.dir, `${parsed.name}-google-verification${parsed.ext || '.png'}`);
      await page.screenshot({ path:verificationPath, fullPage:true });
      verificationScreenshotName = path.basename(verificationPath);
      return verificationScreenshotName;
    };
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    popupTimer = setInterval(() => void dismissObstructions(page,log).catch(() => {}),2000);
    popupTimer.unref();
    await page.goto(config.youtubeStudioUrl,{ waitUntil:'domcontentloaded', timeout:config.navigationTimeoutMs });
    await assertLoggedIn(page, log, captureVerificationScreenshot);
    await dismissObstructions(page,log);
    await waitForStudioReady(page,log,captureVerificationScreenshot);
    await openUploadDialog(page);
    await chooseVideoFile(page,videoPath);
    await waitForDetails(page,log,captureVerificationScreenshot);
    await setTextBox(page,'title',post.title,true);
    await setTextBox(page,'description',post.description,false);
    if (thumbnailPath && !(await setThumbnail(page,thumbnailPath))) warnings.push('Custom thumbnail control was not available; YouTube will use an automatic thumbnail.');
    if (post.playlist_name && !(await setPlaylist(page,post.playlist_name))) warnings.push(`Playlist “${post.playlist_name}” was not found or could not be selected.`);
    await setAudience(page,post);
    await applyAdvancedSettings(page,post,warnings);
    await reachVisibility(page);
    await setVisibility(page,post);
    const result = await finalize(page,post);
    post.youtube_video_id = result.videoId;
    await tryUploadCaptions(page,post,captionPath,warnings);
    const nextState = await context.storageState({ indexedDB:true }).catch(() => context.storageState());
    return { ...result, warnings, storageState:nextState, probe };
  } catch (error) {
    if (page && screenshotPath) await page.screenshot({ path:screenshotPath, fullPage:true }).catch(() => {});
    if (error instanceof YouTubeAutomationError) throw error;
    throw new YouTubeAutomationError(error.message || 'YouTube upload failed.');
  } finally {
    if (popupTimer) clearInterval(popupTimer);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
