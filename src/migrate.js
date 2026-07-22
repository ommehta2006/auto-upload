import 'dotenv/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(here, '../db/schema.sql');

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const sql = await fs.readFile(schemaPath, 'utf8');
  await pool.query(sql);
  await pool.query(`
    ALTER TABLE user_settings
      ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS maximum_uploads_per_day INTEGER DEFAULT 6,
      ADD COLUMN IF NOT EXISTS minimum_gap_minutes INTEGER DEFAULT 20,
      ADD COLUMN IF NOT EXISTS max_attempts INTEGER DEFAULT 3,
      ADD COLUMN IF NOT EXISTS retry_delay_minutes INTEGER DEFAULT 20,
      ADD COLUMN IF NOT EXISTS stale_upload_minutes INTEGER DEFAULT 180,
      ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata',
      ADD COLUMN IF NOT EXISTS upload_window_start TIME DEFAULT '00:00',
      ADD COLUMN IF NOT EXISTS upload_window_end TIME DEFAULT '23:59',
      ADD COLUMN IF NOT EXISTS default_visibility TEXT DEFAULT 'PRIVATE',
      ADD COLUMN IF NOT EXISTS default_audience TEXT DEFAULT 'NOT_MADE_FOR_KIDS',
      ADD COLUMN IF NOT EXISTS default_category TEXT DEFAULT '22',
      ADD COLUMN IF NOT EXISTS default_language TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await pool.query(`
    UPDATE user_settings SET
      automation_enabled=COALESCE(automation_enabled, TRUE),
      maximum_uploads_per_day=COALESCE(maximum_uploads_per_day, 6),
      minimum_gap_minutes=COALESCE(minimum_gap_minutes, 20),
      max_attempts=COALESCE(max_attempts, 3),
      retry_delay_minutes=COALESCE(retry_delay_minutes, 20),
      stale_upload_minutes=COALESCE(stale_upload_minutes, 180),
      timezone=COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'),
      upload_window_start=COALESCE(upload_window_start, TIME '00:00'),
      upload_window_end=COALESCE(upload_window_end, TIME '23:59'),
      default_visibility=COALESCE(NULLIF(default_visibility, ''), 'PRIVATE'),
      default_audience=COALESCE(NULLIF(default_audience, ''), 'NOT_MADE_FOR_KIDS'),
      default_category=COALESCE(NULLIF(default_category, ''), '22'),
      default_language=COALESCE(default_language, ''),
      created_at=COALESCE(created_at, NOW()),
      updated_at=COALESCE(updated_at, NOW())
  `);
  await pool.query(`
    ALTER TABLE user_settings
      ALTER COLUMN automation_enabled SET NOT NULL,
      ALTER COLUMN maximum_uploads_per_day SET NOT NULL,
      ALTER COLUMN minimum_gap_minutes SET NOT NULL,
      ALTER COLUMN max_attempts SET NOT NULL,
      ALTER COLUMN retry_delay_minutes SET NOT NULL,
      ALTER COLUMN stale_upload_minutes SET NOT NULL,
      ALTER COLUMN timezone SET NOT NULL,
      ALTER COLUMN upload_window_start SET NOT NULL,
      ALTER COLUMN upload_window_end SET NOT NULL,
      ALTER COLUMN default_visibility SET NOT NULL,
      ALTER COLUMN default_audience SET NOT NULL,
      ALTER COLUMN default_category SET NOT NULL,
      ALTER COLUMN default_language SET NOT NULL,
      ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN updated_at SET NOT NULL
  `);
  await pool.query(`
    INSERT INTO user_settings (user_id)
    SELECT id FROM users
    ON CONFLICT (user_id) DO NOTHING
  `);
  console.log('Database migration completed.');
} finally {
  await pool.end();
}
