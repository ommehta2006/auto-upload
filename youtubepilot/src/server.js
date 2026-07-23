import 'dotenv/config';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { pool, query } from './db.js';
import { csrfToken, verifyCsrf } from './middleware/csrf.js';
import { exposeFlash, flash } from './middleware/flash.js';
import authRoutes from './routes/auth.js';
import appRoutes from './routes/app.js';
import { startWorker, stopWorker } from './worker.js';
import { resolveRemoteAccessToken, shutdownLoginManager } from './services/login-manager.js';

const require = createRequire(import.meta.url);
const noVncRoot = path.resolve(path.dirname(require.resolve('@novnc/novnc')), '..');

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

app.get('/remote/vnc.html', (_req, res) => res.sendFile(path.join(config.rootDir, 'public', 'remote', 'vnc.html')));
app.use('/remote/core', express.static(path.join(noVncRoot, 'core'), {
  maxAge: config.nodeEnv === 'production' ? '1d' : 0,
  etag: true
}));
app.use('/remote/vendor', express.static(path.join(noVncRoot, 'vendor'), {
  maxAge: config.nodeEnv === 'production' ? '1d' : 0,
  etag: true
}));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
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
  maxAge: config.nodeEnv === 'production' ? '1d' : 0,
  etag: true
}));

const PgStore = connectPgSimple(session);
app.use(session({
  store: new PgStore({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
  name: 'youtubepilot.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure === 'true' ? true : config.cookieSecure === 'false' ? false : 'auto',
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

app.get('/', (req, res) => res.redirect(req.session?.userId ? '/app' : '/login'));
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

const remoteProxy = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/remote/websockify') {
    socket.destroy();
    return;
  }
  const target = resolveRemoteAccessToken(url.searchParams.get('token'));
  if (!target) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  remoteProxy.handleUpgrade(request, socket, head, ws => {
    const vnc = net.createConnection({ host: target.host, port: target.port });
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      vnc.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };
    vnc.on('data', chunk => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true }, error => {
        if (error) closeBoth();
      });
    });
    vnc.on('error', closeBoth);
    vnc.on('close', closeBoth);
    ws.on('message', data => {
      if (vnc.writable) vnc.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    ws.on('error', closeBoth);
    ws.on('close', closeBoth);
  });
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
