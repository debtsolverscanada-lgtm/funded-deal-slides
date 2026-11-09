// Keystone CRM — a small, self-hosted, Monday-style CRM.
// Zero dependencies: Node 22+ (built-in node:sqlite), one SQLite file, one process.
//
//   PORT=3000 DATA_DIR=./data node server.js
//
// Data lives in DATA_DIR/keystone.db. Back that file up and you have everything.

'use strict';
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(`Keystone needs Node.js 22.5 or newer, and this computer has ${process.versions.node}. Install the LTS version from https://nodejs.org and run it again.`);
    process.exit(1);
  }
}
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { syncFromMonday } = require('./monday.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 2 * 1024 * 1024;
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'keystone.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    pw TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY, col TEXT NOT NULL, id TEXT NOT NULL,
    data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS docs_col ON docs(col);
`);
try { db.exec('ALTER TABLE users ADD COLUMN home_board TEXT'); } catch (e) { /* already there */ }

// ---------- helpers ----------
const now = () => new Date().toISOString();
const newId = (p = '') => p + crypto.randomBytes(9).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

// Only these document paths exist. Segments: letters, digits, _ - . ~ : @ +
const SEG = '[A-Za-z0-9_\\-.~:@+]{1,200}';
const COLLECTION_RE = new RegExp(`^(boards|boards/${SEG}/items|meta)$`);
const DOC_RE = new RegExp(`^(boards/${SEG}|boards/${SEG}/items/${SEG}|meta/${SEG})$`);
function splitDoc(p) { const i = p.lastIndexOf('/'); return { col: p.slice(0, i), id: p.slice(i + 1) }; }

// Deep merge: nested plain objects merge, everything else (arrays included) replaces.
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  users: db.prepare('SELECT id, email, name, role, created_at, disabled, home_board FROM users ORDER BY name'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (id, email, name, role, pw, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  session: db.prepare('SELECT s.token, s.expires, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  docsInCol: db.prepare('SELECT id, data FROM docs WHERE col = ?'),
  doc: db.prepare('SELECT id, data FROM docs WHERE path = ?'),
  upsertDoc: db.prepare(`INSERT INTO docs (path, col, id, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  deleteDoc: db.prepare('DELETE FROM docs WHERE path = ?'),
  deleteCol: db.prepare('DELETE FROM docs WHERE col = ?'),
};

function createUser({ email, name, role, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (!['admin', 'member', 'viewer'].includes(role)) throw new HttpError(400, 'Role must be admin, member or viewer.');
  if (String(password || '').length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (q.userByEmail.get(email)) throw new HttpError(409, 'Someone already uses that email.');
  const id = newId('u_');
  q.insertUser.run(id, email, name, role, hashPassword(password), now());
  return { id, email, name, role };
}
module.exports = { createUser, db, q, merge, now };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- request handling ----------
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'That change is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); }
      catch { reject(new HttpError(400, 'Send a JSON object.')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function currentUser(req) {
  const token = cookies(req).ks_session;
  if (!token) return null;
  const row = q.session.get(token);
  if (!row || row.disabled || row.expires < now()) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, homeBoard: row.home_board || '', token };
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, homeBoard: u.homeBoard ?? u.home_board ?? '' });
const canWrite = u => u && (u.role === 'admin' || u.role === 'member');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(buf);
  });
}

// crude per-IP login throttle
const loginFails = new Map();
function throttled(ip) {
  const r = loginFails.get(ip); if (!r) return false;
  if (Date.now() - r.at > 15 * 60 * 1000) { loginFails.delete(ip); return false; }
  return r.n >= 10;
}

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    if (throttled(ip)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
    const { email, password } = await readBody(req);
    const u = q.userByEmail.get(String(email || '').trim().toLowerCase());
    if (!u || u.disabled || !checkPassword(String(password || ''), u.pw)) {
      const r = loginFails.get(ip) || { n: 0, at: Date.now() }; r.n++; r.at = Date.now(); loginFails.set(ip, r);
      throw new HttpError(401, 'That email and password don’t match.');
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insertSession.run(token, u.id, expires);
    return send(res, 200, publicUser(u), { 'Set-Cookie': `ks_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}` });
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  // simple CSRF guard: state-changing calls must come from our own page (JSON + same-origin header)
  if (method !== 'GET' && req.headers['x-keystone'] !== '1') throw new HttpError(403, 'Request refused.');

  if (p === '/api/logout' && method === 'POST') { q.deleteSession.run(user.token); return send(res, 200, { ok: true }, { 'Set-Cookie': 'ks_session=; Path=/; Max-Age=0' }); }
  if (p === '/api/me') return send(res, 200, publicUser(user));

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ---- people ----
  if (p === '/api/users' && method === 'GET') {
    const list = q.users.all().map(u => user.role === 'admin' ? u : { id: u.id, name: u.name, role: u.role });
    return send(res, 200, list);
  }
  if (p === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can add people.');
    return send(res, 201, createUser(await readBody(req)));
  }
  const um = p.match(/^\/api\/users\/(u_[A-Za-z0-9_-]+)$/);
  if (um) {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can change people.');
    const target = q.userById.get(um[1]); if (!target) throw new HttpError(404, 'That person no longer exists.');
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.role && !['admin', 'member', 'viewer'].includes(b.role)) throw new HttpError(400, 'Role must be admin, member or viewer.');
      if (target.id === user.id && b.role && b.role !== 'admin') throw new HttpError(400, 'You can’t remove your own admin role.');
      if (b.password && String(b.password).length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
      if (b.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, target.id);
      if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim(), target.id);
      if (typeof b.homeBoard === 'string') db.prepare('UPDATE users SET home_board = ? WHERE id = ?').run(b.homeBoard || null, target.id);
      if (b.password) { db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(hashPassword(String(b.password)), target.id); q.deleteUserSessions.run(target.id); }
      if (typeof b.disabled === 'boolean') {
        if (target.id === user.id) throw new HttpError(400, 'You can’t turn off your own account.');
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, target.id);
        if (b.disabled) q.deleteUserSessions.run(target.id);
      }
      return send(res, 200, { ok: true });
    }
  }

  // ---- copy from Monday (admin only; reads Monday, never writes to it) ----
  if (p === '/api/admin/monday-sync') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can copy from Monday.');
    if (method === 'GET') return send(res, 200, { ...syncState, configured: !!process.env.MONDAY_API_TOKEN, workspaces: mondayWorkspaces() });
    if (method === 'POST') {
      if (syncState.running) throw new HttpError(409, 'A copy from Monday is already running.');
      if (!process.env.MONDAY_API_TOKEN) throw new HttpError(400, 'Add MONDAY_API_TOKEN to the server settings first.');
      startMondaySync(user);
      return send(res, 202, syncState);
    }
  }

  // ---- bulk upload of a Monday copy made elsewhere (admin only) ----
  if (p === '/api/admin/import-batch' && method === 'POST') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can upload data.');
    const body = await readBody(req, 30 * 1024 * 1024);
    const docs = Array.isArray(body.docs) ? body.docs : [];
    for (const d of docs) if (!d || !DOC_RE.test(String(d.path || '')) || !d.data || typeof d.data !== 'object') throw new HttpError(400, 'Bad record in upload.');
    db.exec('BEGIN');
    try {
      for (const d of docs) { const { col, id } = splitDoc(d.path); q.upsertDoc.run(d.path, col, id, JSON.stringify(d.data), now(), user.id); }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (body.done) broadcast({ op: 'reload' });
    return send(res, 200, { ok: true, saved: docs.length });
  }

  // ---- home summary for one workspace ----
  if (p === '/api/summary' && method === 'GET') {
    const ws = url.searchParams.get('ws') || 'main';
    const hit = summaryCache.get(ws);
    if (hit && Date.now() - hit.at < 60000) return send(res, 200, hit.data);
    const data = buildSummary(ws); summaryCache.set(ws, { at: Date.now(), data });
    return send(res, 200, data);
  }

  // ---- documents ----
  if (p === '/api/col' && method === 'GET') {
    const col = url.searchParams.get('path') || '';
    if (!COLLECTION_RE.test(col)) throw new HttpError(400, 'Unknown collection.');
    const rows = q.docsInCol.all(col).map(r => ({ id: r.id, data: JSON.parse(r.data) }));
    return send(res, 200, rows);
  }
  if (p === '/api/doc') {
    const dp = url.searchParams.get('path') || '';
    if (!DOC_RE.test(dp)) throw new HttpError(400, 'Unknown document.');
    const { col, id } = splitDoc(dp);
    if (method === 'GET') { const r = q.doc.get(dp); return send(res, 200, r ? { id, exists: true, data: JSON.parse(r.data) } : { id, exists: false }); }
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    if (dp.startsWith('meta/') && user.role !== 'admin') throw new HttpError(403, 'Only admins can change workspace settings.');
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      let data = body;
      if (method === 'PATCH') {
        const r = q.doc.get(dp); if (!r) throw new HttpError(404, 'That record no longer exists.');
        data = merge(JSON.parse(r.data), body);
      }
      const json = JSON.stringify(data);
      if (json.length > 1024 * 1024) throw new HttpError(413, 'That record is too large.');
      q.upsertDoc.run(dp, col, id, json, now(), user.id);
      broadcast({ op: 'set', col, id, data });
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      q.deleteDoc.run(dp);
      if (/^boards\/[^/]+$/.test(dp)) q.deleteCol.run(dp + '/items');
      broadcast({ op: 'delete', col, id });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- home summary ----------
const summaryCache = new Map();
function buildSummary(ws) {
  const day = d => d.toISOString().slice(0, 10);
  const today = day(new Date()), weekAgo = Date.now() - 7 * 864e5, inWeek = day(new Date(Date.now() + 7 * 864e5));
  const spark = Array(14).fill(0), sparkStart = new Date(Date.now() - 13 * 864e5); sparkStart.setUTCHours(0, 0, 0, 0);
  const boards = []; let total = 0, newWeek = 0, overdue = 0, dueToday = 0, upcoming = 0;
  for (const r of q.docsInCol.all('boards')) {
    let b; try { b = JSON.parse(r.data); } catch (e) { continue; }
    const w = (b.workspace && b.workspace.id) || 'main'; if (w !== ws) continue;
    const followCols = (b.columns || []).filter(c => c.type === 'date' && /follow|next|callback|due/i.test(c.title)).map(c => c.id);
    let count = 0, bNew = 0;
    for (const it of q.docsInCol.all(`boards/${r.id}/items`)) {
      let d; try { d = JSON.parse(it.data); } catch (e) { continue; }
      count++;
      const c = d.createdAt ? Date.parse(d.createdAt) : NaN;
      if (c >= weekAgo) bNew++;
      if (c >= sparkStart.getTime()) { const k = Math.floor((c - sparkStart.getTime()) / 864e5); if (k >= 0 && k < 14) spark[k]++; }
      for (const fc of followCols) {
        const v = (d.values || {})[fc]; if (!v) continue;
        if (v < today) overdue++; else if (v === today) dueToday++; else if (v <= inWeek) upcoming++;
        break;
      }
    }
    total += count; newWeek += bNew;
    boards.push({ id: r.id, name: b.name, count, newWeek: bNew, folder: b.folder || '' });
  }
  boards.sort((x, y) => y.count - x.count);
  return { ws, total, newWeek, spark, boards, followups: { overdue, dueToday, upcoming } };
}

// ---------- Monday sync job ----------
const mondayWorkspaces = () => String(process.env.MONDAY_WORKSPACE_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
let syncState = { running: false, msg: '', boards: 0, items: 0, startedAt: null, finishedAt: null, error: null };
const lastSync = q.doc.get('meta/monday-sync');
if (lastSync) { try { Object.assign(syncState, JSON.parse(lastSync.data), { running: false }); } catch (e) {} }
function startMondaySync(user) {
  syncState = { running: true, msg: 'Starting', boards: 0, items: 0, startedAt: now(), finishedAt: null, error: null, by: user.name };
  const save = (dp, col, id, data, opts = {}) => {
    if (opts.keep) { const r = q.doc.get(dp); if (r) { const old = JSON.parse(r.data); opts.keep.forEach(k => { if (old[k] !== undefined) data[k] = old[k]; }); } }
    q.upsertDoc.run(dp, col, id, JSON.stringify(data), now(), 'monday-sync');
  };
  const removeStale = (bid, seen) => {
    for (const r of q.docsInCol.all(`boards/${bid}/items`)) {
      if (seen.has(r.id)) continue;
      let d = {}; try { d = JSON.parse(r.data); } catch (e) {}
      if (d.mondayId) q.deleteDoc.run(`boards/${bid}/items/${r.id}`);
    }
  };
  syncFromMonday({
    token: process.env.MONDAY_API_TOKEN, workspaceIds: mondayWorkspaces(), save, removeStale,
    onProgress: ({ msg, boards, items }) => Object.assign(syncState, { msg, boards, items }),
  }).then(r => {
    Object.assign(syncState, { running: false, msg: 'Done', boards: r.boards, items: r.items, finishedAt: now() });
  }).catch(e => {
    console.error('Monday sync failed:', e);
    Object.assign(syncState, { running: false, error: e.message, finishedAt: now() });
  }).finally(() => {
    const { running, ...keep } = syncState;
    q.upsertDoc.run('meta/monday-sync', 'meta', 'monday-sync', JSON.stringify(keep), now(), 'monday-sync');
    broadcast({ op: 'reload' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/login') return serveStatic(req, res, 'login.html');
    if (url.pathname === '/' ) {
      if (!currentUser(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return serveStatic(req, res, 'index.html');
    }
    return serveStatic(req, res, url.pathname.replace(/^\/+/, ''));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
  }
});

if (require.main === module) {
  // ADMIN_EMAIL + ADMIN_PASSWORD always give a working admin sign-in: created if missing, password reset if it exists.
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    try {
      const existing = q.userByEmail.get(email);
      if (existing) {
        if (String(password).length < 8) throw new Error('ADMIN_PASSWORD needs at least 8 characters.');
        db.prepare("UPDATE users SET pw = ?, role = 'admin', disabled = 0 WHERE id = ?").run(hashPassword(password), existing.id);
        console.log('Admin sign-in ready:', email);
      } else { createUser({ email, name: process.env.ADMIN_NAME || 'Admin', role: 'admin', password }); console.log('Created admin sign-in:', email); }
    } catch (e) { console.error('Could not set up the admin sign-in:', e.message); }
  } else if (q.userCount.get().n === 0) {
    console.log('No accounts yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run:  node scripts/create-user.js you@example.com "Your Name" admin "a-strong-password"');
  }
  server.listen(PORT, () => console.log(`Keystone CRM running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
}
