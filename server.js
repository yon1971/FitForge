'use strict';
// FitForge server: serves the app and a small JSON API backed by Postgres.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const MAIL_NAME = process.env.MAIL_FROM_NAME || 'FitForge';
const MAIL_PROVIDER = BREVO_API_KEY ? 'brevo' : RESEND_API_KEY ? 'resend' : '';
const EMAIL_ENABLED = !!(MAIL_PROVIDER && MAIL_FROM);
const mailAddr = () => (MAIL_FROM.match(/<([^>]+)>/) || [, MAIL_FROM])[1].trim();
let lastMail = { ok: null, at: null, error: null };
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();

// Database: NEW_DATABASE_URL (e.g. Neon) takes over from DATABASE_URL (old Render DB) once set.
const OLD_URL = process.env.DATABASE_URL || '';
const NEW_URL = process.env.NEW_DATABASE_URL || '';
const sslFor = url => url && !/localhost|127\.0\.0\.1|@dpg-[^.]+\/|sslmode=disable|host=\//.test(url) ? { rejectUnauthorized: false } : false;
const mkPool = url => new Pool({ connectionString: url.replace(/[?&]channel_binding=require/, ''), ssl: sslFor(url), max: 5 });
let pool = mkPool(NEW_URL || OLD_URL);
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      provider TEXT NOT NULL DEFAULT 'email',
      provider_key TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      pass_hash TEXT,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      code TEXT, code_at TIMESTAMPTZ, code_tries INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{"plans":[],"sessions":[]}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      meta JSONB,
      at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS events_user_idx ON events(user_id);
    CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);
    CREATE TABLE IF NOT EXISTS shared_plans (
      id TEXT PRIMARY KEY,
      owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_plan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      items JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(owner_id, source_plan_id)
    );
    ALTER TABLE shared_plans ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'straight';
    ALTER TABLE shared_plans ADD COLUMN IF NOT EXISTS stretch JSONB;
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      rating INT,
      context TEXT,
      device TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      reply TEXT,
      replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback(status);
    CREATE TABLE IF NOT EXISTS shared_views (
      shared_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(shared_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shared_adds (
      shared_id TEXT NOT NULL REFERENCES shared_plans(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(shared_id, user_id)
    );
  `);
}

/* ---------- helpers ---------- */
const scryptHash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => e ? rej(e) : res(salt + ':' + k.toString('hex'))));
async function checkPw(pw, stored) {
  if (!stored) return false;
  const [salt, hex] = stored.split(':');
  const h = (await scryptHash(pw, salt)).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hex, 'hex'));
}
const isAdmin = u => !!(u && u.verified && u.email && ADMIN_EMAILS.includes(u.email.toLowerCase()));
const pub = u => ({ id: u.id, email: u.email || '', name: u.name, provider: u.provider, verified: u.verified, isAdmin: isAdmin(u), createdAt: u.created_at });
const emailOk = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200;

async function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO sessions(token,user_id) VALUES($1,$2)', [token, userId]);
  return token;
}
async function logEvent(userId, type, meta) {
  try { await q('INSERT INTO events(user_id,type,meta) VALUES($1,$2,$3)', [userId, type, meta ? JSON.stringify(meta) : null]); } catch (e) { console.error('event', e.message); }
}
function codeEmail(code, lang, kind) {
  const he = lang === 'he', reset = kind === 'reset';
  const subject = reset ? (he ? `קוד לאיפוס הסיסמה ב-FitForge: ${code}` : `Your FitForge password reset code: ${code}`) : he ? `קוד האימות שלך ב-FitForge: ${code}` : `Your FitForge verification code: ${code}`;
  const t = reset ? (he
    ? { hi: 'איפוס סיסמה', p1: 'הזינו את הקוד הזה באפליקציה ובחרו סיסמה חדשה:', p2: 'הקוד תקף ל־15 דקות.', p3: 'לא ביקשתם לאפס סיסמה? אפשר להתעלם מההודעה — הסיסמה שלכם לא שונתה.' }
    : { hi: 'Reset your password', p1: 'Enter this code in the app, then choose a new password:', p2: 'The code expires in 15 minutes.', p3: "Didn't ask to reset your password? You can ignore this email — your password hasn't changed." })
    : he
    ? { hi: 'אימות כתובת האימייל', p1: 'הזינו את הקוד הזה באפליקציה כדי לסיים את ההרשמה:', p2: 'הקוד תקף ל־15 דקות.', p3: 'לא נרשמתם ל-FitForge? אפשר פשוט להתעלם מההודעה.' }
    : { hi: 'Confirm your email', p1: 'Enter this code in the app to finish signing up:', p2: 'The code expires in 15 minutes.', p3: "Didn't sign up for FitForge? You can ignore this email." };
  const html = `<!doctype html><html dir="${he ? 'rtl' : 'ltr'}"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0f1217;padding:20px 26px;color:#d7ff3a;font-size:22px;font-weight:800;letter-spacing:.5px">FitForge</td></tr>
<tr><td style="padding:26px;color:#111827;text-align:${he ? 'right' : 'left'}">
<h1 style="margin:0 0 10px;font-size:21px">${t.hi}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#374151">${t.p1}</p>
<div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;background:#f3f4f6;border-radius:12px;padding:16px 0;color:#111827" dir="ltr">${code}</div>
<p style="margin:18px 0 6px;font-size:14px;color:#6b7280">${t.p2}</p>
<p style="margin:0;font-size:13px;color:#9ca3af">${t.p3}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${t.hi}\n\n${t.p1}\n\n${code}\n\n${t.p2}\n${t.p3}`;
  return { subject, html, text };
}

async function sendMail(to, { subject, html, text }) {
  if (!EMAIL_ENABLED) return { ok: false, error: 'Email sending is not configured' };
  try {
    let r;
    if (MAIL_PROVIDER === 'brevo') {
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { name: MAIL_NAME, email: mailAddr() }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
      });
    } else {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM.includes('<') ? MAIL_FROM : `${MAIL_NAME} <${MAIL_FROM}>`, to, subject, html, text })
      });
    }
    if (r.ok) { lastMail = { ok: true, at: new Date().toISOString(), error: null }; return { ok: true }; }
    const body = (await r.text()).slice(0, 300);
    console.error('email send failed', MAIL_PROVIDER, r.status, body);
    lastMail = { ok: false, at: new Date().toISOString(), error: `${r.status} ${body}` };
    return { ok: false, error: `${r.status} ${body}` };
  } catch (e) {
    console.error('email send failed', e.message);
    lastMail = { ok: false, at: new Date().toISOString(), error: e.message };
    return { ok: false, error: e.message };
  }
}

async function sendCode(user, lang, kind) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q('UPDATE users SET code=$1, code_at=now(), code_tries=0 WHERE id=$2', [code, user.id]);
  if (EMAIL_ENABLED) {
    const r = await sendMail(user.email, codeEmail(code, lang, kind));
    return r.ok ? { emailSent: true } : { mailError: true };
  }
  return { demoCode: code };
}
const reqLang = req => (req.headers['x-lang'] === 'he' ? 'he' : 'en');

// tiny in-memory rate limiter for auth endpoints
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.path + '|' + (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0];
    const now = Date.now(); const h = (hits.get(key) || []).filter(t => now - t < windowMs);
    h.push(now); hits.set(key, h);
    if (h.length > max) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 600000)) hits.delete(k); }, 600000).unref();

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
async function auth(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return res.status(401).json({ error: 'Not signed in' });
  const r = await q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1', [tok]);
  if (!r.rows[0]) return res.status(401).json({ error: 'Session expired' });
  req.user = r.rows[0]; req.token = tok;
  if (Date.now() - new Date(req.user.last_seen_at).getTime() > 60000) q('UPDATE users SET last_seen_at=now() WHERE id=$1', [req.user.id]).catch(() => {});
  next();
}
const adminOnly = (req, res, next) => isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admins only' });

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/auth/signup', limit(10, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!emailOk(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  let u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (u && u.verified) return res.status(409).json({ error: 'exists' });
  const hash = await scryptHash(pw);
  if (u) u = (await q('UPDATE users SET pass_hash=$1 WHERE id=$2 RETURNING *', [hash, u.id])).rows[0];
  else {
    u = (await q("INSERT INTO users(email,provider,name,pass_hash) VALUES($1,'email',$2,$3) RETURNING *", [email, email.split('@')[0].slice(0, 40), hash])).rows[0];
    await logEvent(u.id, 'signup', { provider: 'email' });
  }
  res.json({ needVerify: true, email, ...(await sendCode(u, reqLang(req))) });
}));

app.post('/api/auth/login', limit(15, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const u = (await q("SELECT * FROM users WHERE email=$1 AND provider='email'", [email])).rows[0];
  if (!u) return res.status(404).json({ error: 'notfound' });
  if (!(await checkPw(pw, u.pass_hash))) return res.status(401).json({ error: 'Incorrect password. Please try again.' });
  if (!u.verified) return res.json({ needVerify: true, email, ...(await sendCode(u, reqLang(req))) });
  const token = await newSession(u.id); await logEvent(u.id, 'login');
  res.json({ token, user: pub(u) });
}));

app.post('/api/auth/resend', limit(5, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = (await q('SELECT * FROM users WHERE email=$1 AND verified=false', [email])).rows[0];
  if (!u) return res.status(404).json({ error: 'No pending verification for this email.' });
  res.json(await sendCode(u, reqLang(req)));
}));

app.post('/api/auth/verify', limit(20, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), code = String(req.body.code || '');
  const u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (!u || !u.code) return res.status(400).json({ error: 'No pending verification. Please sign in again.' });
  if (Date.now() - new Date(u.code_at).getTime() > 15 * 60000) return res.status(400).json({ error: 'This code has expired. Tap resend to get a new one.' });
  if (u.code_tries >= 6) return res.status(429).json({ error: 'Too many wrong tries. Tap resend to get a new code.' });
  if (code !== u.code) { await q('UPDATE users SET code_tries=code_tries+1 WHERE id=$1', [u.id]); return res.status(400).json({ error: 'That code is not right. Check it and try again.' }); }
  const v = (await q('UPDATE users SET verified=true, code=NULL WHERE id=$1 RETURNING *', [u.id])).rows[0];
  const token = await newSession(v.id); await logEvent(v.id, 'verified'); await logEvent(v.id, 'login');
  res.json({ token, user: pub(v) });
}));

// Forgot password: email a 6-digit code, then set a new password with it.
app.post('/api/auth/forgot', limit(5, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!emailOk(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (u && u.provider !== 'email' && !u.pass_hash) return res.status(400).json({ error: 'This account uses Sign in with Google. Use the Google button to sign in.' });
  if (!u) {
    // Don't reveal whether an account exists when real emails are on.
    if (EMAIL_ENABLED) return res.json({ emailSent: true });
    return res.status(404).json({ error: 'No account with this email.' });
  }
  const r = await sendCode(u, reqLang(req), 'reset');
  await logEvent(u.id, 'reset_requested');
  res.json(r);
}));

app.post('/api/auth/reset', limit(20, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), code = String(req.body.code || '').trim(), pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const u = (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (!u || !u.code) return res.status(400).json({ error: 'No reset code was requested. Tap “Send code” again.' });
  if (Date.now() - new Date(u.code_at).getTime() > 15 * 60000) return res.status(400).json({ error: 'This code has expired. Tap “Send a new code”.' });
  if (u.code_tries >= 6) return res.status(429).json({ error: 'Too many wrong tries. Tap “Send a new code”.' });
  if (code !== u.code) { await q('UPDATE users SET code_tries=code_tries+1 WHERE id=$1', [u.id]); return res.status(400).json({ error: 'That code is not right. Check it and try again.' }); }
  const hash = await scryptHash(pw);
  const v = (await q('UPDATE users SET pass_hash=$1, verified=true, code=NULL WHERE id=$2 RETURNING *', [hash, u.id])).rows[0];
  await q('DELETE FROM sessions WHERE user_id=$1', [v.id]); // sign out other devices
  const token = await newSession(v.id); await logEvent(v.id, 'password_reset'); await logEvent(v.id, 'login');
  res.json({ token, user: pub(v) });
}));

app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null, emailEnabled: EMAIL_ENABLED }));

// Real "Sign in with Google": the browser gets an ID token from Google, we verify it with Google.
app.post('/api/auth/google', limit(20, 60000), wrap(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Google sign-in is not set up yet.' });
  const cred = String(req.body.credential || '');
  if (!cred || cred.length > 4000) return res.status(400).json({ error: 'Bad request' });
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(t.iss) || +t.exp * 1000 < Date.now())
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  if (String(t.email_verified) !== 'true' || !emailOk(String(t.email || '').toLowerCase())) return res.status(401).json({ error: 'Your Google account email is not verified.' });
  const email = t.email.toLowerCase(), key = 'google:' + t.sub, name = String(t.given_name || t.name || email.split('@')[0]).slice(0, 40);
  // match by Google id first, then by email (links to an existing email/password account)
  let u = (await q('SELECT * FROM users WHERE provider_key=$1', [key])).rows[0] || (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (u) u = (await q('UPDATE users SET provider_key=COALESCE(provider_key,$1), email=COALESCE(email,$2), verified=true, code=NULL, name=CASE WHEN name=\'\' THEN $3 ELSE name END WHERE id=$4 RETURNING *', [key, email, name, u.id])).rows[0];
  else {
    u = (await q("INSERT INTO users(email,provider,provider_key,name,verified) VALUES($1,'google',$2,$3,true) RETURNING *", [email, key, name])).rows[0];
    await logEvent(u.id, 'signup', { provider: 'google' });
  }
  const token = await newSession(u.id); await logEvent(u.id, 'login', { provider: 'google' });
  res.json({ token, user: pub(u) });
}));

app.get('/api/me', wrap(auth), (req, res) => res.json({ user: pub(req.user) }));
app.post('/api/logout', wrap(auth), wrap(async (req, res) => { await q('DELETE FROM sessions WHERE token=$1', [req.token]); res.json({ ok: true }); }));

app.get('/api/data', wrap(auth), wrap(async (req, res) => {
  const r = await q('SELECT data, updated_at FROM workspaces WHERE user_id=$1', [req.user.id]);
  res.json(r.rows[0] ? { ...r.rows[0].data, updatedAt: new Date(r.rows[0].updated_at).getTime() } : { plans: [], sessions: [] });
}));
app.put('/api/data', wrap(auth), wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.plans) || !Array.isArray(b.sessions)) return res.status(400).json({ error: 'Bad data' });
  const data = { plans: b.plans.slice(0, 500), sessions: b.sessions.slice(-5000) };
  // private profile (only ever returned to its owner)
  if (b.profile && typeof b.profile === 'object' && JSON.stringify(b.profile).length < 4000) data.profile = b.profile;
  if (Array.isArray(b.weights)) data.weights = b.weights.filter(w => w && Number.isFinite(+w.at) && +w.kg >= 25 && +w.kg <= 350).slice(-1000).map(w => ({ at: +w.at, kg: Math.round(+w.kg * 10) / 10 }));
  if (b.profileSkipped) data.profileSkipped = +b.profileSkipped || Date.now();
  if (b.settings && typeof b.settings === 'object') data.settings = { lang: ['en', 'he'].includes(b.settings.lang) ? b.settings.lang : 'en' };
  await q(`INSERT INTO workspaces(user_id,data,updated_at) VALUES($1,$2,now())
           ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [req.user.id, JSON.stringify(data)]);
  res.json({ ok: true });
}));

const EVENT_TYPES = new Set(['app_open', 'helper_used', 'workout_start', 'workout_complete', 'workout_quit', 'plan_saved', 'plan_deleted', 'howto_open']);
app.post('/api/event', wrap(auth), wrap(async (req, res) => {
  const type = String(req.body.type || '');
  if (!EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Unknown event' });
  const meta = req.body.meta && typeof req.body.meta === 'object' ? req.body.meta : null;
  await logEvent(req.user.id, type, meta && JSON.stringify(meta).length < 2000 ? meta : null);
  res.json({ ok: true });
}));

/* ---------- shared plans (community) ---------- */
const CATEGORIES = ['upper', 'lower', 'full', 'push', 'pull', 'core', 'arms', 'mixed'];
function cleanItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 60) return null;
  const out = [];
  for (const it of items) {
    if (!it || typeof it.exId !== 'string' || it.exId.length > 40) return null;
    const n = (v, a, b, d) => { v = +v; return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
    out.push({ exId: it.exId, sets: n(it.sets, 1, 20, 3), reps: n(it.reps, 1, 200, 10), secs: n(it.secs, 5, 900, 30), time: !!it.time, rest: n(it.rest, 0, 900, 60), weight: n(it.weight, 0, 500, 0) });
  }
  return out;
}
const SHARED_SELECT = `SELECT s.id, s.name, s.category, s.mode, s.stretch, s.items, s.created_at, s.updated_at, s.owner_id, s.source_plan_id, u.name AS owner_name,
    (SELECT count(*)::int FROM shared_views v WHERE v.shared_id=s.id) AS views,
    (SELECT count(*)::int FROM shared_adds a WHERE a.shared_id=s.id) AS adds,
    EXISTS(SELECT 1 FROM shared_adds a WHERE a.shared_id=s.id AND a.user_id=$1) AS added_by_me
  FROM shared_plans s JOIN users u ON u.id=s.owner_id`;
const sharedOut = (r, me) => ({ id: r.id, name: r.name, category: r.category, mode: r.mode || 'straight', stretch: r.stretch || null, items: r.items, ownerName: r.owner_name || 'Someone', isMine: r.owner_id === me, sourcePlanId: r.owner_id === me ? r.source_plan_id : undefined,
  views: r.views, adds: r.adds, addedByMe: r.added_by_me, createdAt: r.created_at, updatedAt: r.updated_at });

app.get('/api/shared', wrap(auth), wrap(async (req, res) => {
  const cat = String(req.query.category || ''), sort = String(req.query.sort || 'views');
  const order = sort === 'adds' ? 'adds DESC, views DESC' : sort === 'new' ? 'created_at DESC' : 'views DESC, adds DESC';
  const params = [req.user.id]; let where = '';
  if (CATEGORIES.includes(cat)) { params.push(cat); where = ' WHERE s.category=$2'; }
  const rows = (await q(`SELECT * FROM (${SHARED_SELECT}${where}) t ORDER BY ${order}, created_at DESC LIMIT 300`, params)).rows;
  const counts = (await q('SELECT category, count(*)::int n FROM shared_plans GROUP BY category')).rows;
  res.json({ plans: rows.map(r => sharedOut(r, req.user.id)), counts: Object.fromEntries(counts.map(c => [c.category, c.n])) });
}));

// share or update a shared plan (one shared copy per source plan)
app.post('/api/shared', wrap(auth), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40), category = String(b.category || ''), src = String(b.planId || '').slice(0, 40);
  const items = cleanItems(b.items), mode = b.mode === 'circuit' ? 'circuit' : 'straight';
  const cs = l => Array.isArray(l) ? l.slice(0, 15).filter(r => r && typeof r.id === 'string' && r.id.length < 30).map(r => ({ id: r.id, secs: Math.min(180, Math.max(5, +r.secs || 30)) })) : [];
  const st = b.stretch && ['off', 'cool', 'both'].includes(b.stretch.mode) ? { mode: b.stretch.mode, min: [3, 5, 8].includes(+b.stretch.min) ? +b.stretch.min : 5, auto: !!b.stretch.auto, warm: cs(b.stretch.warm), cool: cs(b.stretch.cool) } : null;
  if (!name || !src || !items) return res.status(400).json({ error: 'This plan can\'t be shared — it needs a name and at least one exercise.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choose a category before sharing.' });
  const id = crypto.randomBytes(9).toString('base64url');
  const r = await q(`INSERT INTO shared_plans(id,owner_id,source_plan_id,name,category,items,mode,stretch) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(owner_id,source_plan_id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, items=EXCLUDED.items, mode=EXCLUDED.mode, stretch=EXCLUDED.stretch, updated_at=now()
     RETURNING id, (xmax = 0) AS inserted`, [id, req.user.id, src, name, category, JSON.stringify(items), mode, st ? JSON.stringify(st) : null]);
  if (r.rows[0].inserted) await logEvent(req.user.id, 'plan_shared', { sharedId: r.rows[0].id });
  res.json({ id: r.rows[0].id });
}));

app.delete('/api/shared/by-plan/:planId', wrap(auth), wrap(async (req, res) => {
  await q('DELETE FROM shared_plans WHERE owner_id=$1 AND source_plan_id=$2', [req.user.id, req.params.planId]);
  res.json({ ok: true });
}));

app.post('/api/shared/:id/view', wrap(auth), wrap(async (req, res) => {
  const s = (await q('SELECT owner_id FROM shared_plans WHERE id=$1', [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: 'This plan is no longer shared.' });
  if (s.owner_id !== req.user.id) await q('INSERT INTO shared_views(shared_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.post('/api/shared/:id/add', wrap(auth), wrap(async (req, res) => {
  const r = (await q(SHARED_SELECT + ' WHERE s.id=$2', [req.user.id, req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'This plan is no longer shared.' });
  if (r.owner_id !== req.user.id) {
    await q('INSERT INTO shared_views(shared_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.id, req.user.id]);
    const ins = await q('INSERT INTO shared_adds(shared_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.id, req.user.id]);
    if (ins.rowCount) await logEvent(req.user.id, 'plan_added_from_shared', { sharedId: r.id });
  }
  const fresh = (await q(SHARED_SELECT + ' WHERE s.id=$2', [req.user.id, req.params.id])).rows[0];
  res.json({ plan: sharedOut(fresh, req.user.id) });
}));

/* ---------- feedback ---------- */
const FB_TYPES = ['idea', 'bug', 'praise', 'other'], FB_STATUS = ['new', 'read', 'done'];
app.post('/api/feedback', limit(6, 60000), wrap(auth), wrap(async (req, res) => {
  const b = req.body || {};
  const type = FB_TYPES.includes(b.type) ? b.type : 'other';
  const message = String(b.message || '').trim().slice(0, 3000);
  if (message.length < 3) return res.status(400).json({ error: 'Please write a few words.' });
  const rating = Number.isInteger(+b.rating) && +b.rating >= 1 && +b.rating <= 5 ? +b.rating : null;
  const r = await q('INSERT INTO feedback(user_id,type,message,rating,context,device) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [req.user.id, type, message, rating, String(b.context || '').slice(0, 200), String(req.headers['user-agent'] || '').slice(0, 300)]);
  await logEvent(req.user.id, 'feedback', { type });
  res.json({ id: r.rows[0].id });
}));
app.get('/api/feedback/mine', wrap(auth), wrap(async (req, res) => {
  const r = await q('SELECT id,type,message,rating,status,reply,replied_at,created_at FROM feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ items: r.rows });
}));
app.get('/api/admin/feedback/count', wrap(auth), adminOnly, wrap(async (req, res) => {
  const r = await q("SELECT count(*)::int n FROM feedback WHERE status='new'");
  res.json({ new: r.rows[0].n });
}));
app.get('/api/admin/feedback', wrap(auth), adminOnly, wrap(async (req, res) => {
  const st = String(req.query.status || '');
  const params = []; let where = '';
  if (FB_STATUS.includes(st)) { params.push(st); where = 'WHERE f.status=$1'; }
  const r = await q(`SELECT f.*, u.name AS user_name, u.email AS user_email, u.provider AS user_provider FROM feedback f LEFT JOIN users u ON u.id=f.user_id ${where} ORDER BY f.created_at DESC LIMIT 300`, params);
  const c = await q('SELECT status, type, count(*)::int n FROM feedback GROUP BY status, type');
  const counts = { new: 0, read: 0, done: 0, all: 0, types: {} };
  for (const x of c.rows) { counts[x.status] = (counts[x.status] || 0) + x.n; counts.all += x.n; counts.types[x.type] = (counts.types[x.type] || 0) + x.n; }
  const avg = (await q('SELECT round(avg(rating)::numeric,1)::float a, count(rating)::int n FROM feedback WHERE rating IS NOT NULL')).rows[0];
  res.json({ items: r.rows, counts, rating: avg });
}));
app.patch('/api/admin/feedback/:id', wrap(auth), adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), b = req.body || {};
  if (b.status && !FB_STATUS.includes(b.status)) return res.status(400).json({ error: 'Bad status' });
  if (b.status) await q('UPDATE feedback SET status=$1 WHERE id=$2', [b.status, id]);
  if (typeof b.reply === 'string') await q("UPDATE feedback SET reply=NULLIF($1,''), replied_at=CASE WHEN $1='' THEN NULL ELSE now() END, status=CASE WHEN status='new' THEN 'read' ELSE status END WHERE id=$2", [b.reply.trim().slice(0, 2000), id]);
  res.json({ ok: true });
}));
app.post('/api/admin/feedback/mark-all-read', wrap(auth), adminOnly, wrap(async (req, res) => {
  await q("UPDATE feedback SET status='read' WHERE status='new'"); res.json({ ok: true });
}));

/* ---------- admin ---------- */
const DAY = 864e5;
async function loadAll() {
  const users = (await q('SELECT u.*, w.data FROM users u LEFT JOIN workspaces w ON w.user_id=u.id ORDER BY u.created_at')).rows;
  const ev = (await q(`SELECT user_id, type, count(*)::int n, max(at) last,
                         count(*) FILTER (WHERE at > now() - interval '7 days')::int n7
                       FROM events GROUP BY user_id, type`)).rows;
  const evBy = {};
  for (const e of ev) (evBy[e.user_id] = evBy[e.user_id] || {})[e.type] = e;
  return { users, evBy };
}
function userStats(u, evBy, now) {
  const d = u.data || { plans: [], sessions: [] }, ss = d.sessions || [], plans = d.plans || [];
  const e = evBy[u.id] || {};
  const total = ss.reduce((a, s) => a + (+s.dur || 0), 0);
  const last = ss.reduce((m, s) => Math.max(m, +s.at || 0), 0);
  return {
    ...pub(u), lastSeenAt: u.last_seen_at,
    plans: plans.length,
    exercisesInPlans: plans.reduce((a, p) => a + ((p.items || []).length), 0),
    workouts: ss.length,
    workouts7d: ss.filter(s => now - s.at < 7 * DAY).length,
    workouts30d: ss.filter(s => now - s.at < 30 * DAY).length,
    trainingSec: total,
    avgWorkoutSec: ss.length ? Math.round(total / ss.length) : 0,
    lastWorkoutAt: last || null,
    appOpens: (e.app_open?.n || 0) + (e.login?.n || 0),
    appOpens7d: (e.app_open?.n7 || 0) + (e.login?.n7 || 0),
    quits: e.workout_quit?.n || 0
  };
}

app.get('/api/admin/email', wrap(auth), adminOnly, (req, res) => res.json({ enabled: EMAIL_ENABLED, provider: MAIL_PROVIDER || null, from: EMAIL_ENABLED ? mailAddr() : null, last: lastMail }));
app.post('/api/admin/test-email', wrap(auth), adminOnly, wrap(async (req, res) => {
  if (!EMAIL_ENABLED) return res.status(400).json({ error: 'Email sending is not set up yet.' });
  const r = await sendMail(req.user.email, codeEmail('123456', reqLang(req)));
  if (!r.ok) return res.status(502).json({ error: 'Sending failed: ' + r.error });
  res.json({ ok: true, to: req.user.email });
}));
app.get('/api/admin/overview', wrap(auth), adminOnly, wrap(async (req, res) => {
  const now = Date.now(), { users, evBy } = await loadAll();
  const stats = users.map(u => userStats(u, evBy, now));
  const dayKey = t => new Date(t).toISOString().slice(0, 10);
  const days = []; for (let i = 29; i >= 0; i--) days.push(dayKey(now - i * DAY));
  const perDay = Object.fromEntries(days.map(k => [k, { workouts: 0, signups: 0, opens: 0, active: new Set() }]));
  const exCount = {}, muscleHint = {};
  let durs = [];
  for (const u of users) {
    const d = u.data || {};
    for (const s of d.sessions || []) { const k = dayKey(+s.at); if (perDay[k]) { perDay[k].workouts++; perDay[k].active.add(u.id); } durs.push(+s.dur || 0); }
    for (const p of d.plans || []) for (const it of p.items || []) exCount[it.exId] = (exCount[it.exId] || 0) + 1;
    const ck = dayKey(u.created_at); if (perDay[ck]) perDay[ck].signups++;
  }
  const opens = (await q(`SELECT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD') d, count(*)::int n, count(DISTINCT user_id)::int u
                          FROM events WHERE type IN ('app_open','login') AND at > now() - interval '30 days' GROUP BY 1`)).rows;
  for (const o of opens) if (perDay[o.d]) perDay[o.d].opens = o.n;
  const quits = (await q(`SELECT count(*)::int n FROM events WHERE type='workout_quit'`)).rows[0].n;
  const starts = (await q(`SELECT count(*)::int n FROM events WHERE type='workout_start'`)).rows[0].n;
  const sh = (await q(`SELECT count(*)::int n, (SELECT count(*)::int FROM shared_adds) adds, (SELECT count(*)::int FROM shared_views) views FROM shared_plans`)).rows[0];
  const topShared = (await q(`SELECT s.name, s.category, u.name owner, (SELECT count(*)::int FROM shared_views v WHERE v.shared_id=s.id) views, (SELECT count(*)::int FROM shared_adds a WHERE a.shared_id=s.id) adds
                              FROM shared_plans s JOIN users u ON u.id=s.owner_id ORDER BY adds DESC, views DESC LIMIT 5`)).rows;
  const providers = {}; for (const u of users) providers[u.provider] = (providers[u.provider] || 0) + 1;
  const hours = Array(24).fill(0); for (const u of users) for (const s of (u.data || {}).sessions || []) hours[new Date(+s.at).getUTCHours()]++;
  durs.sort((a, b) => a - b);
  res.json({
    generatedAt: now,
    totals: {
      users: users.length, verified: users.filter(u => u.verified).length,
      newUsers7d: users.filter(u => now - new Date(u.created_at) < 7 * DAY).length,
      active7d: users.filter(u => now - new Date(u.last_seen_at) < 7 * DAY).length,
      active30d: users.filter(u => now - new Date(u.last_seen_at) < 30 * DAY).length,
      plans: stats.reduce((a, s) => a + s.plans, 0),
      workouts: stats.reduce((a, s) => a + s.workouts, 0),
      workouts7d: stats.reduce((a, s) => a + s.workouts7d, 0),
      trainingSec: stats.reduce((a, s) => a + s.trainingSec, 0),
      avgWorkoutSec: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
      medianWorkoutSec: durs.length ? durs[Math.floor(durs.length / 2)] : 0,
      appOpens30d: opens.reduce((a, o) => a + o.n, 0),
      workoutStarts: starts, workoutQuits: quits,
      completionRate: starts ? Math.round(Math.min(1, (starts - quits) / starts) * 100) : null,
      usersWithPlan: stats.filter(s => s.plans > 0).length,
      usersWithWorkout: stats.filter(s => s.workouts > 0).length,
      profiles: users.filter(u => u.data && u.data.profile && u.data.profile.completedAt).length,
      sharedPlans: sh.n, sharedViews: sh.views, sharedAdds: sh.adds
    },
    topShared,
    daily: days.map(k => ({ day: k, workouts: perDay[k].workouts, signups: perDay[k].signups, opens: perDay[k].opens, activeUsers: perDay[k].active.size })),
    topExercises: Object.entries(exCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ id, n })),
    providers, hoursUTC: hours,
    users: stats.sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
  });
}));

app.get('/api/admin/users/:id', wrap(auth), adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = (await q('SELECT u.*, w.data FROM users u LEFT JOIN workspaces w ON w.user_id=u.id WHERE u.id=$1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { evBy } = await loadAll();
  const d = u.data || { plans: [], sessions: [] };
  const recentEvents = (await q('SELECT type, at FROM events WHERE user_id=$1 ORDER BY at DESC LIMIT 30', [id])).rows;
  res.json({
    user: userStats(u, evBy, Date.now()),
    plans: (d.plans || []).map(p => {
      const ss = (d.sessions || []).filter(s => s.planId === p.id);
      return { id: p.id, name: p.name, items: (p.items || []).map(i => i.exId), runs: ss.length, best: ss.length ? Math.min(...ss.map(s => s.dur)) : null, last: ss.length ? Math.max(...ss.map(s => s.at)) : null };
    }),
    sessions: (d.sessions || []).slice().sort((a, b) => b.at - a.at).slice(0, 25).map(s => ({ ...s, planName: ((d.plans || []).find(p => p.id === s.planId) || {}).name || '(deleted plan)' })),
    recentEvents
  });
}));

app.delete('/api/me', wrap(auth), wrap(async (req, res) => {
  await q('DELETE FROM users WHERE id=$1', [req.user.id]);
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy-he', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy-he.html')));
app.get('/terms-he', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms-he.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Please try again.' }); });

// One-time copy from the old database into the new one (only if the new one is empty).
const TABLES = [
  ['users', 'users_id_seq'], ['sessions'], ['workspaces'], ['events', 'events_id_seq'],
  ['shared_plans'], ['shared_views'], ['shared_adds'], ['feedback', 'feedback_id_seq']
];
async function copyFromOld() {
  if (!NEW_URL || !OLD_URL || NEW_URL === OLD_URL) return;
  const n = (await q('SELECT count(*)::int n FROM users')).rows[0].n;
  if (n > 0) { console.log('[migrate] new database already has ' + n + ' users — skipping copy'); return; }
  const old = mkPool(OLD_URL);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const report = [];
      for (const [table, seq] of TABLES) {
        let rows;
        try { rows = (await old.query(`SELECT * FROM ${table}`)).rows; } catch (e) { report.push(table + ': not in old db'); continue; }
        if (rows.length) {
          const cols = Object.keys(rows[0]);
          for (let k = 0; k < rows.length; k += 200) {
            const chunk = rows.slice(k, k + 200), vals = [], ph = [];
            chunk.forEach((r, ri) => {
              ph.push('(' + cols.map((c, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')');
              cols.forEach(c => { const v = r[c]; vals.push(v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v); });
            });
            await client.query(`INSERT INTO ${table} (${cols.map(c => '"' + c + '"').join(',')}) VALUES ${ph.join(',')}`, vals);
          }
        }
        if (seq) await client.query(`SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}),1))`);
        const check = (await client.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
        report.push(`${table}: ${rows.length} copied, ${check} in new db${check === rows.length ? ' ✓' : ' ✗ MISMATCH'}`);
        if (check !== rows.length) throw new Error('count mismatch in ' + table);
      }
      await client.query('COMMIT');
      console.log('[migrate] copy complete:\n  ' + report.join('\n  '));
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } finally { await old.end(); }
}

migrate().then(copyFromOld).then(() => console.log('[db] using ' + (NEW_URL ? 'NEW_DATABASE_URL' : 'DATABASE_URL'))).then(() => app.listen(PORT, () => console.log('FitForge listening on ' + PORT + (ADMIN_EMAILS.length ? ' · admins: ' + ADMIN_EMAILS.length : ' · no ADMIN_EMAILS set'))))
  .catch(e => { console.error('DB migration failed', e); process.exit(1); });
