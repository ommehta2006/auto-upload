import crypto from 'node:crypto';

function safeEqual(a, b) {
  const one = Buffer.from(String(a || ''));
  const two = Buffer.from(String(b || ''));
  return one.length === two.length && crypto.timingSafeEqual(one, two);
}

function validate(req, res, next) {
  const submitted = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session?.csrfToken;
  if (!expected || !submitted || !safeEqual(expected, submitted)) {
    return res.status(403).render('error', {
      title: 'Security check failed',
      message: 'The form expired or was submitted from an invalid page. Refresh the page and try again.'
    });
  }
  next();
}

export function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
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
