export function flash(req, type, message) {
  req.session.flash = { type, message };
}

export function exposeFlash(req, res, next) {
  res.locals.flash = req.session?.flash || null;
  if (req.session?.flash) delete req.session.flash;
  next();
}
