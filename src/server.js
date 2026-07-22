import 'dotenv/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool, query } from './db.js';
import { csrfToken, verifyCsrf } from './middleware/csrf.js';
import { exposeFlash, flash } from './middleware/flash.js';
import authRoutes from './routes/auth.js';
import appRoutes from './routes/app.js';
import { startWorker, stopWorker } from './worker.js';
import { shutdownLoginManager } from './services/login-manager.js';

for (const required of ['DATABASE_URL', 'SESSION_SECRET', 'SESSION_ENCRYPTION_KEY']) {
  if (!process.env[required]) throw new Error(`${required} is required.`);
}

await fs.mkdir(config.storageDir, { recursive: true, mode: 0o700 });
await fs.mkdir(config.tempDir, { recursive: true, mode: 0o700 });

async function cleanStaleTempFiles() {
  const cutoff = Date.now() - 60 * 60_000;
  const entries = await fs.readdir(config.tempDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async entry => {
    if (!entry.isFile()) return;
    const filePath = path.join(config.tempDir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(filePath, { force: true });
  }));
}
await cleanStaleTempFiles();
const tempCleanupTimer = setInterval(() => void cleanStaleTempFiles().catch(error => console.error('Temp cleanup failed:', error)), 60 * 60_000);
tempCleanupTimer.unref();

await query(`UPDATE youtube_accounts
             SET status=CASE WHEN encrypted_state IS NULL THEN 'DISCONNECTED' ELSE 'CONNECTED' END,
                 updated_at=NOW()
             WHERE status='CONNECTING'`);

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(config.rootDir, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/assets', express.static(path.join(config.rootDir, 'public'), {
  maxAge: 0,
  cacheControl: false,
  etag: true
}));

app.use((req, _res, next) => {
  const forwardedProto = String(req.get('x-forwarded-proto') || '');
  if (config.trustProxy && forwardedProto.split(',').map(value => value.trim()).includes('https')) {
    req.headers['x-forwarded-proto'] = 'https';
  }
  next();
});

const PgStore = connectPgSimple(session);
app.use(session({
  store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
  name: 'youtubepilot.sid',
  secret: process.env.SESSION_SECRET,
  proxy: config.trustProxy,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure !== 'false',
    maxAge: config.sessionHours * 60 * 60 * 1000
  }
}));

app.use(exposeFlash);
app.use((req, res, next) => {
  res.locals.csrfToken = csrfToken(req);
  res.locals.currentUser = req.session?.userId ? {
    id: req.session.userId,
    email: req.session.userEmail,
    displayName: req.session.displayName
  } : null;
  res.locals.appLimits = {
    maxVideoBytes: config.maxVideoBytes,
    maxImageBytes: config.maxImageBytes,
    maxCaptionBytes: config.maxCaptionBytes,
    maxExcelBytes: config.maxExcelBytes,
    maxStorageBytesPerUser: config.maxStorageBytesPerUser
  };
  res.locals.formatDate = (value, timeZone = 'Asia/Kolkata') => {
    if (!value) return '—';
    try {
      return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
    } catch {
      return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value));
    }
  };
  res.locals.formatBytes = bytes => {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  };
  next();
});
app.use(verifyCsrf);

app.get('/', (req, res) => res.render('home', { title: 'YouTubePilot · Autonomous Creator Studio & YouTube Automation' }));
app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});
app.use(authRoutes);
app.use(appRoutes);

app.use((req, res) => res.status(404).render('error', {
  title: 'Page not found',
  message: 'The requested page does not exist.'
}));

app.use(async (error, req, res, _next) => {
  console.error(error);
  const pendingUploads = [
    ...(Array.isArray(req.files) ? req.files : []),
    ...(req.file ? [req.file] : [])
  ];
  await Promise.all(pendingUploads.map(file => file?.path ? fs.rm(file.path, { force: true }).catch(() => {}) : Promise.resolve()));
  const friendlyMessage = error?.code === 'LIMIT_FILE_SIZE'
    ? 'The selected upload exceeds the configured file-size limit.'
    : error?.code === 'LIMIT_FILE_COUNT'
      ? 'Too many files were selected for one upload.'
      : error?.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'The upload contains an unexpected file field.'
        : (error.message || 'The request could not be completed.');
  if (req.session) {
    flash(req, 'error', friendlyMessage);
  }
  if (res.headersSent) return;
  const acceptsHtml = req.accepts('html');
  if (acceptsHtml && req.session?.userId) return res.redirect('/app');
  if (acceptsHtml) return res.status(500).render('error', {
    title: 'Something went wrong',
    message: config.nodeEnv === 'production' ? friendlyMessage : friendlyMessage
  });
  res.status(500).json({ error: 'REQUEST_FAILED' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`YouTubePilot listening on port ${config.port}`);
  startWorker();
});

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  server.close();
  await stopWorker();
  await shutdownLoginManager();
  await pool.end();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
