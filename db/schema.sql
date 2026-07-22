CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  maximum_uploads_per_day INTEGER NOT NULL DEFAULT 6 CHECK (maximum_uploads_per_day BETWEEN 1 AND 50),
  minimum_gap_minutes INTEGER NOT NULL DEFAULT 20 CHECK (minimum_gap_minutes BETWEEN 0 AND 1440),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_delay_minutes INTEGER NOT NULL DEFAULT 20 CHECK (retry_delay_minutes BETWEEN 1 AND 1440),
  stale_upload_minutes INTEGER NOT NULL DEFAULT 180 CHECK (stale_upload_minutes BETWEEN 20 AND 1440),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  upload_window_start TIME NOT NULL DEFAULT '00:00',
  upload_window_end TIME NOT NULL DEFAULT '23:59',
  default_visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (default_visibility IN ('PUBLIC','PRIVATE','UNLISTED','SCHEDULE')),
  default_audience TEXT NOT NULL DEFAULT 'NOT_MADE_FOR_KIDS' CHECK (default_audience IN ('MADE_FOR_KIDS','NOT_MADE_FOR_KIDS')),
  default_category TEXT NOT NULL DEFAULT '22',
  default_language TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'YouTube channel',
  status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN ('DISCONNECTED','CONNECTING','CONNECTED','SESSION_CHECKING','VERIFICATION_REQUIRED','VERIFICATION_IN_PROGRESS','VERIFICATION_COMPLETED','SESSION_EXPIRED','RECONNECT_REQUIRED','ATTENTION_REQUIRED','ERROR')),
  encrypted_state TEXT,
  browser_profile_id TEXT NOT NULL DEFAULT '',
  browser_profile_health TEXT NOT NULL DEFAULT 'UNKNOWN',
  last_session_check_at TIMESTAMPTZ,
  last_successful_verification_at TIMESTAMPTZ,
  last_successful_upload_at TIMESTAMPTZ,
  channel_name TEXT NOT NULL DEFAULT '',
  channel_url TEXT NOT NULL DEFAULT '',
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('VIDEO','THUMBNAIL','CAPTION')),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, kind, original_name),
  UNIQUE(user_id, stored_name)
);

CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
  thumbnail_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
  caption_file_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
  media_file_hint TEXT NOT NULL DEFAULT '',
  upload_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('VIDEO','SHORT')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  playlist_name TEXT NOT NULL DEFAULT '',
  automation_start_at TIMESTAMPTZ NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PUBLIC','PRIVATE','UNLISTED','SCHEDULE')),
  youtube_publish_at TIMESTAMPTZ,
  premiere BOOLEAN NOT NULL DEFAULT FALSE,
  audience TEXT NOT NULL DEFAULT 'NOT_MADE_FOR_KIDS' CHECK (audience IN ('MADE_FOR_KIDS','NOT_MADE_FOR_KIDS')),
  age_restriction BOOLEAN NOT NULL DEFAULT FALSE,
  paid_promotion BOOLEAN NOT NULL DEFAULT FALSE,
  altered_content BOOLEAN NOT NULL DEFAULT FALSE,
  automatic_chapters BOOLEAN NOT NULL DEFAULT TRUE,
  featured_places BOOLEAN NOT NULL DEFAULT TRUE,
  automatic_concepts BOOLEAN NOT NULL DEFAULT TRUE,
  language TEXT NOT NULL DEFAULT '',
  caption_certification TEXT NOT NULL DEFAULT 'NONE',
  caption_language TEXT NOT NULL DEFAULT '',
  caption_name TEXT NOT NULL DEFAULT '',
  recording_date DATE,
  recording_location TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT 'STANDARD' CHECK (license IN ('STANDARD','CREATIVE_COMMONS')),
  distribution TEXT NOT NULL DEFAULT 'EVERYWHERE' CHECK (distribution IN ('EVERYWHERE','MONETIZED_PLATFORMS')),
  allow_embedding BOOLEAN NOT NULL DEFAULT TRUE,
  notify_subscribers BOOLEAN NOT NULL DEFAULT TRUE,
  category TEXT NOT NULL DEFAULT '22',
  comments_mode TEXT NOT NULL DEFAULT 'ALLOW_ALL' CHECK (comments_mode IN ('ALLOW_ALL','HOLD_POTENTIALLY_INAPPROPRIATE','INCREASE_STRICTNESS','HOLD_ALL','DISABLE')),
  comments_sort TEXT NOT NULL DEFAULT 'TOP' CHECK (comments_sort IN ('TOP','NEWEST')),
  show_like_count BOOLEAN NOT NULL DEFAULT TRUE,
  remix_mode TEXT NOT NULL DEFAULT 'VIDEO_AND_AUDIO' CHECK (remix_mode IN ('VIDEO_AND_AUDIO','AUDIO_ONLY','NONE')),
  related_video TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','UPLOADING','UPLOADED','PROCESSING','FAILED','FILE_MISSING','LOGIN_REQUIRED','ACCOUNT_ACTION_REQUIRED','PAUSED_FOR_VERIFICATION','RESUME_AVAILABLE','REVIEW_REQUIRED','PAUSED')),
  workflow_stage TEXT NOT NULL DEFAULT 'BEFORE_STUDIO_OPEN',
  duplicate_risk TEXT NOT NULL DEFAULT 'NONE',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  youtube_video_id TEXT NOT NULL DEFAULT '',
  youtube_url TEXT NOT NULL DEFAULT '',
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, upload_id),
  CHECK (visibility <> 'SCHEDULE' OR youtube_publish_at IS NOT NULL),
  CHECK (content_type <> 'SHORT' OR premiere = FALSE)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info','warning','error','success')),
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_browser_locks (
  channel_id UUID PRIMARY KEY REFERENCES youtube_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lock_token UUID NOT NULL DEFAULT gen_random_uuid(),
  owner TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploads_due ON uploads(status, enabled, automation_start_at);
CREATE INDEX IF NOT EXISTS idx_uploads_user_status ON uploads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_uploads_content_type ON uploads(user_id, content_type, automation_start_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_user_kind ON media_files(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_user_created ON activity_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_locks_expires ON youtube_browser_locks(expires_at);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT user_sessions_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire);
