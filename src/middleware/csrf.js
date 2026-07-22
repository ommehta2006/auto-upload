import crypto from 'node:crypto';

const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length === two.length && crypto.timingSafeEqual(one, two);
}

function signature(value) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET || 'csrf-development-secret')
    .update(value)
    .digest('base64url');
}

function signedToken() {
  const body = `${Date.now().toString(36)}.${crypto.randomBytes(18).toString('base64url')}`;
  return `${body}.${signature(body)}`;
}

function validateSignedToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;

  const [encodedTime, nonce, submittedSignature] = parts;
  if (!encodedTime || !nonce || !submittedSignature) return false;

  const createdAt = Number.parseInt(encodedTime, 36);
  if (!Number.isFinite(createdAt)) return false;

  const age = Date.now() - createdAt;
  if (age < 0 || age > TOKEN_MAX_AGE_MS) return false;

  return safeEqual(submittedSignature, signature(`${encodedTime}.${nonce}`));
}

function validate(req, res, next) {
  const submitted = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrfToken;
  const validSessionToken = expected && submitted && safeEqual(expected, submitted);
  const validSignedToken = submitted && validateSignedToken(submitted);

  if (!validSessionToken && !validSignedToken) {
    return res.status(403).render('error', {
      title: 'Security check failed',
      message: 'The form expired or was submitted from an invalid page. Refresh the page and try again.'
    });
  }
  next();
}

export function csrfToken(req) {
  return signedToken();
}

export function verifyCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // Multer must parse multipart fields first; upload routes call verifyMultipartCsrf afterward.
  if (req.is('multipart/form-data')) return next();
  return validate(req, res, next);
}

export function verifyMultipartCsrf(req, res, next) {
  return validate(req, res, next);
}
