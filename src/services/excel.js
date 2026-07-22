import XlsxPopulate from 'xlsx-populate';
import { DateTime } from 'luxon';

const HEADERS = [
  'Upload ID','Enabled','Video File','Title','Description','Tags','Playlist','Automation Date','Automation Time',
  'Visibility','YouTube Publish Date','YouTube Publish Time','Premiere','Audience','Age Restriction','Paid Promotion',
  'Altered Content','Automatic Chapters','Featured Places','Automatic Concepts','Thumbnail File','Caption File','Language',
  'Caption Certification','Caption Language','Caption Name','Recording Date','Recording Location','License','Distribution',
  'Allow Embedding','Notify Subscribers','Category ID','Comments Mode','Comments Sort','Show Like Count','Remix Mode',
  'Related Video','Status','YouTube URL','Error'
];

const key = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
const bool = (value, fallback=false) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value || '').trim().toLowerCase();
  if (['true','yes','y','1','on','enabled'].includes(text)) return true;
  if (['false','no','n','0','off','disabled'].includes(text)) return false;
  return fallback;
};
const text = (value, fallback='') => String(value ?? fallback).trim();

function datePart(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return DateTime.fromJSDate(value).toFormat('yyyy-MM-dd');
  if (typeof value === 'number') return DateTime.fromJSDate(new Date(Date.UTC(1899,11,30) + value * 86400000)).toFormat('yyyy-MM-dd');
  const raw = text(value);
  for (const format of ['yyyy-MM-dd','dd/MM/yyyy','MM/dd/yyyy','dd-MM-yyyy']) {
    const parsed = DateTime.fromFormat(raw,format);
    if (parsed.isValid) return parsed.toFormat('yyyy-MM-dd');
  }
  return '';
}

function timePart(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return DateTime.fromJSDate(value).toFormat('HH:mm');
  if (typeof value === 'number') {
    const minutes = Math.round((value % 1) * 1440);
    return `${String(Math.floor(minutes / 60) % 24).padStart(2,'0')}:${String(minutes % 60).padStart(2,'0')}`;
  }
  const raw = text(value);
  for (const format of ['HH:mm','H:mm','hh:mm a','h:mm a']) {
    const parsed = DateTime.fromFormat(raw,format);
    if (parsed.isValid) return parsed.toFormat('HH:mm');
  }
  return '';
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = text(value,fallback).toUpperCase().replace(/[\s-]+/g,'_');
  return allowed.includes(normalized) ? normalized : fallback;
}

function readRows(sheet, contentType, timezone) {
  if (!sheet) return [];
  const used = sheet.usedRange();
  if (!used) return [];
  const values = used.value();
  const header = values[0] || [];
  const indexes = new Map(header.map((name,index) => [key(name),index]));
  const get = (row,name) => row[indexes.get(key(name))];
  const rows = [];
  for (let index=1; index<values.length; index+=1) {
    const row = values[index] || [];
    if (!row.some(value => text(value))) continue;
    const automationDate = datePart(get(row,'Automation Date'));
    const automationTime = timePart(get(row,'Automation Time'));
    const uploadId = text(get(row,'Upload ID'));
    const videoFile = text(get(row,'Video File'));
    const title = text(get(row,'Title'));
    let validationError = '';
    if (!uploadId) validationError = 'Upload ID is required.';
    else if (!/^[a-zA-Z0-9._-]+$/.test(uploadId)) validationError = 'Upload ID contains unsupported characters.';
    else if (!videoFile) validationError = 'Video File is required.';
    else if (!title) validationError = 'Title is required.';
    else if (!automationDate || !automationTime) validationError = 'Automation date or time is invalid.';
    const local = automationDate && automationTime ? DateTime.fromFormat(`${automationDate} ${automationTime}`,'yyyy-MM-dd HH:mm',{ zone:timezone }) : null;
    if (!validationError && !local?.isValid) validationError = 'Automation date/time is invalid in the selected timezone.';
    const visibility = normalizeEnum(get(row,'Visibility'),['PUBLIC','PRIVATE','UNLISTED','SCHEDULE'],'PRIVATE');
    const publishDate = datePart(get(row,'YouTube Publish Date'));
    const publishTime = timePart(get(row,'YouTube Publish Time'));
    let publishAt = null;
    if (visibility === 'SCHEDULE') {
      if (!publishDate || !publishTime) validationError ||= 'Scheduled visibility requires YouTube publish date and time.';
      else {
        const parsed = DateTime.fromFormat(`${publishDate} ${publishTime}`,'yyyy-MM-dd HH:mm',{ zone:timezone });
        if (!parsed.isValid) validationError ||= 'YouTube publish date/time is invalid.';
        else if (local?.isValid && parsed <= local) validationError ||= 'YouTube publish time must be later than the automation start time.';
        else publishAt = parsed.toUTC().toISO();
      }
    }
    rows.push({
      rowNumber:index + 1, validationError, contentType, uploadId, enabled:bool(get(row,'Enabled'),true), videoFile,
      title:title.slice(0,100), description:text(get(row,'Description')).slice(0,5000), tags:text(get(row,'Tags')).slice(0,500),
      playlistName:text(get(row,'Playlist')).slice(0,150), automationStartAt:local?.toUTC().toISO() || null,
      visibility, youtubePublishAt:publishAt, premiere:contentType === 'VIDEO' && bool(get(row,'Premiere'),false),
      audience:normalizeEnum(get(row,'Audience'),['MADE_FOR_KIDS','NOT_MADE_FOR_KIDS'],'NOT_MADE_FOR_KIDS'),
      ageRestriction:bool(get(row,'Age Restriction'),false), paidPromotion:bool(get(row,'Paid Promotion'),false),
      alteredContent:bool(get(row,'Altered Content'),false), automaticChapters:bool(get(row,'Automatic Chapters'),true),
      featuredPlaces:bool(get(row,'Featured Places'),true), automaticConcepts:bool(get(row,'Automatic Concepts'),true),
      thumbnailFile:text(get(row,'Thumbnail File')), captionFile:text(get(row,'Caption File')), language:text(get(row,'Language')).slice(0,80),
      captionCertification:text(get(row,'Caption Certification'),'NONE').toUpperCase().replace(/[\s-]+/g,'_'),
      captionLanguage:text(get(row,'Caption Language')).slice(0,80), captionName:text(get(row,'Caption Name')).slice(0,100),
      recordingDate:datePart(get(row,'Recording Date')) || null, recordingLocation:text(get(row,'Recording Location')).slice(0,200),
      license:normalizeEnum(get(row,'License'),['STANDARD','CREATIVE_COMMONS'],'STANDARD'),
      distribution:normalizeEnum(get(row,'Distribution'),['EVERYWHERE','MONETIZED_PLATFORMS'],'EVERYWHERE'),
      allowEmbedding:bool(get(row,'Allow Embedding'),true), notifySubscribers:bool(get(row,'Notify Subscribers'),true),
      category:/^\d{1,3}$/.test(text(get(row,'Category ID'))) ? text(get(row,'Category ID')) : '22',
      commentsMode:normalizeEnum(get(row,'Comments Mode'),['ALLOW_ALL','HOLD_POTENTIALLY_INAPPROPRIATE','INCREASE_STRICTNESS','HOLD_ALL','DISABLE'],'ALLOW_ALL'),
      commentsSort:normalizeEnum(get(row,'Comments Sort'),['TOP','NEWEST'],'TOP'), showLikeCount:bool(get(row,'Show Like Count'),true),
      remixMode:normalizeEnum(get(row,'Remix Mode'),['VIDEO_AND_AUDIO','AUDIO_ONLY','NONE'],'VIDEO_AND_AUDIO'),
      relatedVideo:text(get(row,'Related Video')).slice(0,300)
    });
  }
  return rows;
}

export async function parseUploadsWorkbook(filePath, timezone='Asia/Kolkata') {
  const workbook = await XlsxPopulate.fromFileAsync(filePath);
  return [
    ...readRows(workbook.sheet('Videos'),'VIDEO',timezone),
    ...readRows(workbook.sheet('Shorts'),'SHORT',timezone)
  ];
}

function valueFor(post, header, timezone) {
  const local = DateTime.fromJSDate(new Date(post.automation_start_at)).setZone(timezone);
  const publish = post.youtube_publish_at ? DateTime.fromJSDate(new Date(post.youtube_publish_at)).setZone(timezone) : null;
  const map = {
    'Upload ID':post.upload_id,'Enabled':post.enabled,'Video File':post.media_name || post.media_file_hint,'Title':post.title,
    'Description':post.description,'Tags':post.tags,'Playlist':post.playlist_name,'Automation Date':local.toFormat('yyyy-MM-dd'),
    'Automation Time':local.toFormat('HH:mm'),'Visibility':post.visibility,'YouTube Publish Date':publish?.toFormat('yyyy-MM-dd') || '',
    'YouTube Publish Time':publish?.toFormat('HH:mm') || '','Premiere':post.premiere,'Audience':post.audience,
    'Age Restriction':post.age_restriction,'Paid Promotion':post.paid_promotion,'Altered Content':post.altered_content,
    'Automatic Chapters':post.automatic_chapters,'Featured Places':post.featured_places,'Automatic Concepts':post.automatic_concepts,
    'Thumbnail File':post.thumbnail_name || '','Caption File':post.caption_name_file || '','Language':post.language,
    'Caption Certification':post.caption_certification,'Caption Language':post.caption_language,'Caption Name':post.caption_name,
    'Recording Date':post.recording_date ? String(post.recording_date).slice(0,10) : '','Recording Location':post.recording_location,
    'License':post.license,'Distribution':post.distribution,'Allow Embedding':post.allow_embedding,'Notify Subscribers':post.notify_subscribers,
    'Category ID':post.category,'Comments Mode':post.comments_mode,'Comments Sort':post.comments_sort,'Show Like Count':post.show_like_count,
    'Remix Mode':post.remix_mode,'Related Video':post.related_video,'Status':post.status,'YouTube URL':post.youtube_url,'Error':post.error
  };
  return map[header] ?? '';
}

export async function buildUploadsWorkbook({ uploads, settings }) {
  const workbook = await XlsxPopulate.fromBlankAsync();
  const first = workbook.sheet(0).name('Videos');
  const shorts = workbook.addSheet('Shorts');
  for (const [sheet,type] of [[first,'VIDEO'],[shorts,'SHORT']]) {
    sheet.cell('A1').value([HEADERS]);
    const rows = uploads.filter(item => item.content_type === type).map(item => HEADERS.map(header => valueFor(item,header,settings.timezone)));
    if (rows.length) sheet.cell('A2').value(rows);
    sheet.row(1).style({ bold:true,fill:'FF0F172A',fontColor:'FFFFFFFF',horizontalAlignment:'center',verticalAlignment:'center' });
    sheet.freezePanes(1,3);
    HEADERS.forEach((header,index) => sheet.column(index + 1).width(Math.min(38,Math.max(12,header.length + 2))));
    sheet.column(4).width(30); sheet.column(5).width(42); sheet.column(41).width(36);
    sheet.usedRange()?.style({ wrapText:true,verticalAlignment:'top',border:true });
    sheet.autoFilter('A1:AO1');
  }
  const settingsSheet = workbook.addSheet('Settings');
  settingsSheet.cell('A1').value([['Setting','Value'],['Timezone',settings.timezone],['Automation Enabled',settings.automation_enabled],['Daily Limit',settings.maximum_uploads_per_day],['Minimum Gap Minutes',settings.minimum_gap_minutes]]);
  settingsSheet.row(1).style({ bold:true,fill:'FFFF0000',fontColor:'FFFFFFFF' });
  settingsSheet.column('A').width(28); settingsSheet.column('B').width(28);
  return workbook.outputAsync();
}

export { HEADERS };
