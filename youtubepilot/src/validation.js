import { z } from 'zod';

const checkbox = z.preprocess(value => value === 'on' || value === 'true' || value === true || value === 1, z.boolean());
const optionalDate = z.preprocess(value => String(value || '').trim() || undefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional());
const optionalDateTime = z.preprocess(value => String(value || '').trim() || undefined, z.string().optional());
const email = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const password = z.string().min(12, 'Password must contain at least 12 characters.').max(200);

export const registerSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  email,
  password,
  confirmPassword: z.string(),
  invitationCode: z.string().trim().max(200).optional().default('')
}).refine(data => data.password === data.confirmPassword, { message: 'Passwords do not match.', path: ['confirmPassword'] });

export const loginSchema = z.object({ email, password: z.string().min(1).max(200) });

export const uploadSchema = z.object({
  uploadId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/, 'Upload ID may use letters, numbers, dots, dashes, and underscores.'),
  contentType: z.enum(['VIDEO','SHORT']),
  mediaId: z.string().uuid(),
  thumbnailId: z.preprocess(value => String(value || '').trim() || undefined, z.string().uuid().optional()),
  captionFileId: z.preprocess(value => String(value || '').trim() || undefined, z.string().uuid().optional()),
  title: z.string().trim().min(1).max(100),
  description: z.string().max(5000).default(''),
  tags: z.string().max(500).default(''),
  playlistName: z.string().max(150).default(''),
  automationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  automationTime: z.string().regex(/^\d{2}:\d{2}$/),
  visibility: z.enum(['PUBLIC','PRIVATE','UNLISTED','SCHEDULE']),
  youtubePublishDate: optionalDate,
  youtubePublishTime: z.preprocess(value => String(value || '').trim() || undefined, z.string().regex(/^\d{2}:\d{2}$/).optional()),
  premiere: checkbox,
  audience: z.enum(['MADE_FOR_KIDS','NOT_MADE_FOR_KIDS']),
  ageRestriction: checkbox,
  paidPromotion: checkbox,
  alteredContent: checkbox,
  automaticChapters: checkbox,
  featuredPlaces: checkbox,
  automaticConcepts: checkbox,
  language: z.string().max(80).default(''),
  captionCertification: z.string().max(80).default('NONE'),
  captionLanguage: z.string().max(80).default(''),
  captionName: z.string().max(100).default(''),
  recordingDate: optionalDate,
  recordingLocation: z.string().max(200).default(''),
  license: z.enum(['STANDARD','CREATIVE_COMMONS']),
  distribution: z.enum(['EVERYWHERE','MONETIZED_PLATFORMS']),
  allowEmbedding: checkbox,
  notifySubscribers: checkbox,
  category: z.string().regex(/^\d{1,3}$/),
  commentsMode: z.enum(['ALLOW_ALL','HOLD_POTENTIALLY_INAPPROPRIATE','INCREASE_STRICTNESS','HOLD_ALL','DISABLE']),
  commentsSort: z.enum(['TOP','NEWEST']),
  showLikeCount: checkbox,
  remixMode: z.enum(['VIDEO_AND_AUDIO','AUDIO_ONLY','NONE']),
  relatedVideo: z.string().max(300).default(''),
  enabled: checkbox
}).superRefine((data, ctx) => {
  if (data.visibility === 'SCHEDULE' && (!data.youtubePublishDate || !data.youtubePublishTime)) {
    ctx.addIssue({ code: 'custom', message: 'A YouTube publish date and time are required for scheduled visibility.', path: ['youtubePublishDate'] });
  }
  if (data.contentType === 'SHORT' && data.premiere) {
    ctx.addIssue({ code: 'custom', message: 'Premiere is not available for Shorts.', path: ['premiere'] });
  }
});

export const settingsSchema = z.object({
  automationEnabled: checkbox,
  maximumUploadsPerDay: z.coerce.number().int().min(1).max(50),
  minimumGapMinutes: z.coerce.number().int().min(0).max(1440),
  maxAttempts: z.coerce.number().int().min(1).max(10),
  retryDelayMinutes: z.coerce.number().int().min(1).max(1440),
  timezone: z.string().trim().min(1).max(80),
  uploadWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
  uploadWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  defaultVisibility: z.enum(['PUBLIC','PRIVATE','UNLISTED','SCHEDULE']),
  defaultAudience: z.enum(['MADE_FOR_KIDS','NOT_MADE_FOR_KIDS']),
  defaultCategory: z.string().regex(/^\d{1,3}$/),
  defaultLanguage: z.string().max(80).default('')
});

export function firstZodError(error) {
  return error?.issues?.[0]?.message || 'Please check the submitted values.';
}
