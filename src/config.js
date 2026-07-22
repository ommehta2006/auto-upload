import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const railwayBaseUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const externalBaseUrl = (process.env.BASE_URL || railwayBaseUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function integer(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

export const config = Object.freeze({
  rootDir,
  port: integer('PORT', 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: externalBaseUrl,
  storageDir: path.resolve(rootDir, process.env.STORAGE_DIR || 'storage'),
  browserProfileRoot: path.resolve(rootDir, process.env.BROWSER_PROFILE_ROOT || path.join(process.env.STORAGE_DIR || 'storage', 'browser-profiles')),
  tempDir: path.resolve(rootDir, process.env.TEMP_DIR || 'tmp'),
  maxVideoBytes: integer('MAX_VIDEO_MB', 1024, 10, 20_000) * 1024 * 1024,
  maxImageBytes: integer('MAX_IMAGE_MB', 10, 1, 50) * 1024 * 1024,
  maxCaptionBytes: integer('MAX_CAPTION_MB', 5, 1, 20) * 1024 * 1024,
  maxExcelBytes: integer('MAX_EXCEL_MB', 10, 1, 100) * 1024 * 1024,
  maxStorageBytesPerUser: integer('MAX_STORAGE_MB_PER_USER', 4096, 100, 500_000) * 1024 * 1024,
  sessionHours: integer('SESSION_HOURS', 24, 1, 720),
  workerIntervalMs: integer('WORKER_INTERVAL_SECONDS', 20, 5, 3600) * 1000,
  workerConcurrency: integer('WORKER_CONCURRENCY', 1, 1, 3),
  loginSessionMinutes: integer('LOGIN_SESSION_MINUTES', 20, 5, 60),
  screenshotFolderName: 'screenshots',
  youtubeStudioUrl: process.env.YOUTUBE_STUDIO_URL || 'https://studio.youtube.com/',
  browserHeadless: process.env.BROWSER_HEADLESS !== 'false',
  navigationTimeoutMs: integer('NAVIGATION_TIMEOUT_MS', 90_000, 10_000, 300_000),
  uploadTimeoutMs: integer('UPLOAD_TIMEOUT_MS', 1_800_000, 60_000, 7_200_000),
  processingWaitMs: integer('PROCESSING_WAIT_MS', 180_000, 10_000, 900_000),
  slowMoMs: integer('BROWSER_SLOWMO_MS', 0, 0, 1000),
  display: process.env.DISPLAY || ':99',
  vncHost: process.env.VNC_HOST || '127.0.0.1',
  vncPort: integer('VNC_PORT', 5900, 1024, 65535),
  noVncPort: integer('NOVNC_PORT', 6080, 1024, 65535),
  noVncPublicUrl: process.env.NOVNC_PUBLIC_URL || `${externalBaseUrl}/remote/vnc.html`,
  railwayRegion: process.env.RAILWAY_REGION || process.env.RAILWAY_DEPLOYMENT_REGION || 'unknown',
  trustProxy: process.env.TRUST_PROXY !== 'false',
  cookieSecure: process.env.COOKIE_SECURE || 'auto',
  signupInviteCode: process.env.SIGNUP_INVITE_CODE || '',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe'
});
