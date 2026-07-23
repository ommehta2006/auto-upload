import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query, withTransaction } from '../db.js';
import { requireGuest } from '../middleware/auth.js';
import { flash } from '../middleware/flash.js';
import { registerSchema, loginSchema, firstZodError } from '../validation.js';
import { ensureUserStorage } from '../services/storage.js';
import { addLog } from '../services/logs.js';
import { config } from '../config.js';

const router = Router();
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false });
const DUMMY_PASSWORD_HASH = '$2b$12$MtbhxBR6Sx5jYpUmb6Xk6.4eAoLAAYlfxRYfNMkACUtbI1Y44FdY.';
export const AUTH_SUCCESS_REDIRECT = '/app';

export function authSuccessDestination(session) {
  if (session && typeof session === 'object') delete session.returnTo;
  return AUTH_SUCCESS_REDIRECT;
}

function invitationMatches(submitted) {
  if (!config.signupInviteCode) return true;
  const expected = Buffer.from(config.signupInviteCode);
  const actual = Buffer.from(String(submitted || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

router.get('/register', requireGuest, (req, res) => res.render('register', { title: 'Create account', inviteRequired: Boolean(config.signupInviteCode) }));
router.post('/register', requireGuest, authLimit, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      flash(req, 'error', firstZodError(parsed.error));
      return res.redirect('/register');
    }
    if (!invitationMatches(parsed.data.invitationCode)) {
      flash(req, 'error', 'The customer invitation code is incorrect.');
      return res.redirect('/register');
    }
    const existing = await query('SELECT 1 FROM users WHERE email=$1', [parsed.data.email]);
    if (existing.rowCount) {
      flash(req, 'error', 'An account already exists for this email address.');
      return res.redirect('/login');
    }
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const user = await withTransaction(async client => {
      const created = await client.query(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id,email,display_name`,
        [parsed.data.email, parsed.data.displayName, hash]
      );
      await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [created.rows[0].id]);
      await client.query('INSERT INTO youtube_accounts (user_id) VALUES ($1)', [created.rows[0].id]);
      return created.rows[0];
    });
    await ensureUserStorage(user.id);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.displayName = user.display_name;
      req.session.save(async saveError => {
        if (saveError) return next(saveError);
        await addLog(user.id, 'success', 'Account created.');
        res.redirect(authSuccessDestination(req.session));
      });
    });
  } catch (error) { next(error); }
});

router.get('/login', requireGuest, (req, res) => res.render('login', { title: 'Sign in' }));
router.post('/login', requireGuest, authLimit, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      flash(req, 'error', 'Enter a valid email and password.');
      return res.redirect('/login');
    }
    const result = await query('SELECT * FROM users WHERE email=$1 AND is_active=TRUE', [parsed.data.email]);
    const user = result.rows[0];
    const valid = await bcrypt.compare(parsed.data.password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!valid) {
      flash(req, 'error', 'The email or password is incorrect.');
      return res.redirect('/login');
    }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.displayName = user.display_name;
      req.session.save(saveError => saveError ? next(saveError) : res.redirect(authSuccessDestination(req.session)));
    });
  } catch (error) { next(error); }
});

router.post('/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('youtubepilot.sid');
    res.redirect('/login');
  });
});

export default router;
