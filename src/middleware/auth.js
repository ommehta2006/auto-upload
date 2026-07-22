export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

export function requireGuest(req, res, next) {
  if (req.session?.userId) return res.redirect('/app');
  next();
}
