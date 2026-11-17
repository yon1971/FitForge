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
const EMAIL_ENABLED = !!(RESEND_API_KEY && MAIL_FROM);
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1|@dpg-[^.]+\/|sslmode=disable/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5
});
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
async function sendCode(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  await q('UPDATE users SET code=$1, code_at=now(), code_tries=0 WHERE id=$2', [code, user.id]);
  if (EMAIL_ENABLED) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: MAIL_FROM, to: user.email, subject: 'Your FitForge verification code', html: `<p>Your FitForge code is:</p><h1 style="letter-spacing:6px">${code}</h1><p>It expires in 15 minutes.</p>` })
      });
      if (r.ok) return {};
      console.error('email send failed', r.status, await r.text());
    } catch (e) { console.error('email send failed', e.message); }
  }
  return { demoCode: code };
}

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
  res.json({ needVerify: true, email, ...(await sendCode(u)) });
}));

app.post('/api/auth/login', limit(15, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const u = (await q("SELECT * FROM users WHERE email=$1 AND provider='email'", [email])).rows[0];
  if (!u) return res.status(404).json({ error: 'notfound' });
  if (!(await checkPw(pw, u.pass_hash))) return res.status(401).json({ error: 'Incorrect password. Please try again.' });
  if (!u.verified) return res.json({ needVerify: true, email, ...(await sendCode(u)) });
  const token = await newSession(u.id); await logEvent(u.id, 'login');
  res.json({ token, user: pub(u) });
}));

app.post('/api/auth/resend', limit(5, 60000), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = (await q('SELECT * FROM users WHERE email=$1 AND verified=false', [email])).rows[0];
  if (!u) return res.status(404).json({ error: 'No pending verification for this email.' });
  res.json(await sendCode(u));
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
  await q(`INSERT INTO workspaces(user_id,data,updated_at) VALUES($1,$2,now())
           ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [req.user.id, JSON.stringify(data)]);
  res.json({ ok: true });
}));

const EVENT_TYPES = new Set(['app_open', 'helper_used', 'workout_start', 'workout_complete', 'workout_quit', 'plan_saved', 'plan_deleted']);
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
const SHARED_SELECT = `SELECT s.id, s.name, s.category, s.mode, s.items, s.created_at, s.updated_at, s.owner_id, s.source_plan_id, u.name AS owner_name,
    (SELECT count(*)::int FROM shared_views v WHERE v.shared_id=s.id) AS views,
    (SELECT count(*)::int FROM shared_adds a WHERE a.shared_id=s.id) AS adds,
    EXISTS(SELECT 1 FROM shared_adds a WHERE a.shared_id=s.id AND a.user_id=$1) AS added_by_me
  FROM shared_plans s JOIN users u ON u.id=s.owner_id`;
const sharedOut = (r, me) => ({ id: r.id, name: r.name, category: r.category, mode: r.mode || 'straight', items: r.items, ownerName: r.owner_name || 'Someone', isMine: r.owner_id === me, sourcePlanId: r.owner_id === me ? r.source_plan_id : undefined,
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
  if (!name || !src || !items) return res.status(400).json({ error: 'This plan can\'t be shared — it needs a name and at least one exercise.' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Choose a category before sharing.' });
  const id = crypto.randomBytes(9).toString('base64url');
  const r = await q(`INSERT INTO shared_plans(id,owner_id,source_plan_id,name,category,items,mode) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(owner_id,source_plan_id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, items=EXCLUDED.items, mode=EXCLUDED.mode, updated_at=now()
     RETURNING id, (xmax = 0) AS inserted`, [id, req.user.id, src, name, category, JSON.stringify(items), mode]);
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
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error. Please try again.' }); });

migrate().then(() => app.listen(PORT, () => console.log('FitForge listening on ' + PORT + (ADMIN_EMAILS.length ? ' · admins: ' + ADMIN_EMAILS.length : ' · no ADMIN_EMAILS set'))))
  .catch(e => { console.error('DB migration failed', e); process.exit(1); });
