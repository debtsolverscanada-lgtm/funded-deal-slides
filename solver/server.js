// Solver.ca — a small, self-hosted, Monday-style CRM.
// Zero dependencies: Node 22+ (built-in node:sqlite), one SQLite file, one process.
//
//   PORT=3000 DATA_DIR=./data node server.js
//
// Data lives in DATA_DIR/solver.db. Back that file up and you have everything.

'use strict';
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(`Solver.ca needs Node.js 22.5 or newer, and this computer has ${process.versions.node}. Install the LTS version from https://nodejs.org and run it again.`);
    process.exit(1);
  }
}
process.removeAllListeners('warning');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { syncFromMonday, pullFromMonday } = require('./monday.js');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FILE = 25 * 1024 * 1024;
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';

fs.mkdirSync(DATA_DIR, { recursive: true });
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
// Earlier versions called the file keystone.db: carry it over once.
{ const oldDb = path.join(DATA_DIR, 'keystone.db'), newDb = path.join(DATA_DIR, 'solver.db');
  if (!fs.existsSync(newDb) && fs.existsSync(oldDb)) for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(oldDb + ext)) fs.renameSync(oldDb + ext, newDb + ext); }
const db = new DatabaseSync(path.join(DATA_DIR, 'solver.db'));
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
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT NOT NULL, board TEXT, item TEXT, read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, at);
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, size INTEGER NOT NULL, board TEXT NOT NULL, item TEXT,
    created_at TEXT NOT NULL, created_by TEXT
  );
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

// ---------- who can see which board ----------
// A board doc may carry access: { private: true|false, members: [emails] }. Admins see every board;
// everyone else sees open boards and the private boards that list their email.
function canSee(u, access) {
  if (!access || !access.private) return true;
  if (!u) return false;
  if (u.role === 'admin') return true;
  const me = String(u.email || '').toLowerCase();
  return !!me && (access.members || []).some(e => String(e).toLowerCase() === me);
}
const boardCache = new Map(); // board id -> { t, v: { name, access, columns } | null }
function boardInfo(bid) {
  const hit = boardCache.get(bid); if (hit && Date.now() - hit.t < 10000) return hit.v;
  const r = q.doc.get('boards/' + bid); let v = null;
  if (r) { try { const d = JSON.parse(r.data); v = { name: d.name, access: d.access || null, columns: d.columns || [] }; } catch (e) {} }
  boardCache.set(bid, { t: Date.now(), v }); return v;
}
const boardOfPath = p => { const m = /^boards\/([^/]+)(\/items(\/[^/]+)?)?$/.exec(p || ''); return m ? m[1] : null; };
function mustSee(user, bid) { const b = boardInfo(bid); if (b && !canSee(user, b.access)) throw new HttpError(404, 'That board doesn’t exist or isn’t shared with you.'); return b; }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- live updates (server-sent events) ----------
// Each open page is tracked with its signed-in person, so private boards' changes only reach people who can see them.
const clients = new Map(); // res -> { id, email, role, name }
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  if (evt.op === 'notify') { for (const [res, u] of clients) if (u.id === evt.user) res.write(line); return; }
  const bid = evt.col === 'boards' ? evt.id : boardOfPath(evt.col);
  if (evt.col === 'boards') boardCache.delete(evt.id);
  const access = !bid ? null : evt.col === 'boards' && evt.op === 'set' ? (evt.data || {}).access : (boardInfo(bid) || {}).access;
  if (!access || !access.private) { for (const res of clients.keys()) res.write(line); return; }
  const gone = evt.col === 'boards' && evt.op === 'set' ? `data: ${JSON.stringify({ op: 'delete', col: 'boards', id: evt.id })}\n\n` : null;
  for (const [res, u] of clients) { if (canSee(u, access)) res.write(line); else if (gone) res.write(gone); }
}
function refreshClients(userId) {
  const row = q.userById.get(userId);
  for (const [res, u] of clients) if (u.id === userId) { if (!row || row.disabled) { clients.delete(res); res.end(); } else Object.assign(u, { email: row.email, role: row.role, name: row.name }); }
}
setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 25000).unref();

// ---------- Penny's heads-ups ("buzz"): small, friendly updates shown by the pet ----------
// Sent like other live updates, so private boards only reach people who can see them. Nothing is stored or sent outside.
function buzz(bid, iid, before, after, by, extra) {
  try {
    if (!after && !extra) return;
    const r = q.doc.get('boards/' + bid); if (!r) return; const b = JSON.parse(r.data);
    const name = String((after || before || {}).name || 'A lead').slice(0, 60), out = [];
    const people = (b.columns || []).filter(c => c.type === 'person').map(c => String(((after || {}).values || {})[c.id] || '')).join(', ');
    const send1 = (kind, text) => out.push({ kind, text, board: bid, boardName: b.name, item: String(iid), name, people, by: by || '' });
    if (extra) send1(extra.kind, extra.text);
    else if (!before) send1('new', `New lead! ${name} just landed on ${b.name}`);
    else {
      if (before.group !== after.group) { const g = (b.groups || []).find(x => x.id === after.group); if (g) send1('moved', `${name} moved to ${g.name}`); }
      const nb = (before.updates || []).length, na = (after.updates || []).length;
      if (na > nb) { const u = after.updates[na - 1] || {}; send1('note', `New note on ${name}${u.byName ? ' from ' + String(u.byName).split(' ')[0] : ''}`); }
      for (const c of b.columns || []) {
        if (c.type !== 'date') continue; const x = ((before.values || {})[c.id]) || '', y = ((after.values || {})[c.id]) || '';
        if (!y || y <= x) continue;
        if (/last date texted/i.test(c.title)) send1('text', `New text activity with ${name}`);
        else if (/last date contacted/i.test(c.title)) send1('call', `New call logged with ${name}`);
      }
    }
    for (const ev of out.slice(0, 3)) broadcast({ op: 'buzz', col: `boards/${bid}/items`, id: String(iid), ev });
  } catch (e) { /* a heads-up must never break a save */ }
}

// ---------- in-app notifications (inside Solver.ca only; nothing is emailed or texted) ----------
const nq = {
  insert: db.prepare('INSERT INTO notifications (id, user_id, at, kind, text, board, item) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  list: db.prepare('SELECT id, at, kind, text, board, item, read FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT 60'),
  unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0'),
  readOne: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?'),
  readAll: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?'),
  activeUsers: db.prepare('SELECT id, email, name, role FROM users WHERE disabled = 0'),
};
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// "Jan", "Jan Smith" or "jan@x.ca" -> that Solver.ca person. A first name alone only counts when it's unique.
function usersByNames(names) {
  const users = nq.activeUsers.all(), out = new Map();
  for (const raw of names) {
    const n = norm(raw).replace(/^@/, ''); if (!n) continue;
    let hit = users.filter(u => norm(u.name) === n || norm(u.email) === n);
    if (!hit.length) { const first = n.split(' ')[0]; const f = users.filter(u => norm(u.name).split(' ')[0] === first); if (f.length === 1 && (!n.includes(' ') || !norm(f[0].name).includes(' '))) hit = f; }
    hit.forEach(u => out.set(u.id, u));
  }
  return [...out.values()];
}
// Creates notifications for these people (only those who can see the board) and pushes them live.
function notifyUsers(users, { kind, text, board, item }, exceptId) {
  const b = board ? boardInfo(board) : null; let n = 0;
  for (const u of users) {
    if (u.id === exceptId || (b && !canSee(u, b.access))) continue;
    const row = { id: newId('n_'), at: now(), kind, text: String(text).slice(0, 400), board: board || null, item: item || null, read: 0 };
    nq.insert.run(row.id, u.id, row.at, row.kind, row.text, row.board, row.item);
    broadcast({ op: 'notify', user: u.id, n: row }); n++;
  }
  return n;
}
const notifyNames = (names, n, exceptId) => notifyUsers(usersByNames(names), n, exceptId);
// "{item.Name} needs {item.text42__1}" -> filled in from the item, like Monday's notify messages.
function fillTemplate(text, b, item) {
  return String(text || '').replace(/\{(?:item|pulse)\.([^}]+)\}/g, (m, key) => {
    if (/^name$/i.test(key)) return item.name || '';
    const c = ((b && b.columns) || []).find(x => x.id === key || x.title === key); if (!c) return '';
    const v = (item.values || {})[c.id]; if (v == null) return '';
    if (c.type === 'status') return ((c.labels || []).find(l => l.id === String(v)) || {}).label || '';
    if (Array.isArray(v)) return v.map(x => x && x.name ? x.name : String(x)).join(', ');
    return String(v);
  });
}
const snippet = t => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > 90 ? s.slice(0, 88) + '…' : s; };
// Mentions: "@Jan" or "@Jan Smith" anywhere in an update.
function mentionedUsers(text) {
  const users = nq.activeUsers.all(), out = new Map();
  for (const m of String(text || '').matchAll(/@([\p{L}][\p{L}'’.-]*)(?:\s+([\p{L}][\p{L}'’.-]*))?/gu)) {
    const two = m[2] ? norm(m[1] + ' ' + m[2]) : null, one = norm(m[1]);
    let hit = two ? users.filter(u => norm(u.name) === two) : [];
    if (!hit.length) hit = users.filter(u => norm(u.name) === one);
    if (!hit.length) { const f = users.filter(u => norm(u.name).split(' ')[0] === one); if (f.length === 1) hit = f; }
    hit.forEach(u => out.set(u.id, u));
  }
  return [...out.values()];
}
const people = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
// Called after any item write by a person, API key or lead link (not bulk copies from Monday).
function itemNotifications(dp, before, after, actor) {
  const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(dp); if (!m || !after) return;
  const [, bid, iid] = m; const b = boardInfo(bid); if (!b) return;
  const who = (actor && actor.name) || 'Someone', where = `${after.name || 'an item'} · ${b.name}`;
  // newly assigned in a person column (new items only when they were made here, not moved or duplicated)
  const created = !before && (after.activity || []).some(a => /^Created/.test(String(a.text || '')));
  if (before || created) for (const c of b.columns.filter(c => c.type === 'person')) {
    const had = new Set(people(before && (before.values || {})[c.id]).map(norm));
    const added = people((after.values || {})[c.id]).filter(n => !had.has(norm(n)));
    if (added.length) notifyNames(added, { kind: 'assign', text: `${who} assigned you to ${where} (${c.title})`, board: bid, item: iid }, actor && actor.id);
  }
  // @mentions in new updates
  const seen = new Set(((before && before.updates) || []).map(u => u.at + '|' + u.text));
  for (const u of after.updates || []) {
    if (seen.has(u.at + '|' + u.text)) continue;
    const users = mentionedUsers(u.text); if (!users.length) continue;
    notifyUsers(users, { kind: 'mention', text: `${u.byName || who} mentioned you on ${where}: “${snippet(u.text)}”`, board: bid, item: iid }, actor && actor.id);
  }
}

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

const integ = require('./integrations.js')({ db, q, now, broadcast, HttpError, readBody, send, merge, notifyNames, itemNotifications, fillTemplate, buzz });
module.exports.integ = integ;

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  if (p.startsWith('/api/v1/')) return integ.handleV1(req, res, url);

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
  if (method !== 'GET' && req.headers['x-solver'] !== '1') throw new HttpError(403, 'Request refused.');

  if (p === '/api/logout' && method === 'POST') { q.deleteSession.run(user.token); return send(res, 200, { ok: true }, { 'Set-Cookie': 'ks_session=; Path=/; Max-Age=0' }); }
  if (p === '/api/me') return send(res, 200, publicUser(user));

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    clients.set(res, { id: user.id, email: user.email, role: user.role, name: user.name });
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
      refreshClients(target.id);
      return send(res, 200, { ok: true });
    }
  }

  // ---- integrations admin ----
  if (p.startsWith('/api/admin/keys') || p.startsWith('/api/admin/hooks')) { const r = await integ.handleAdmin(req, res, url, user); if (r !== false) return; }

  // ---- copy from Monday (admin only; reads Monday, never writes to it) ----
  if (p === '/api/admin/monday-sync') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can copy from Monday.');
    if (method === 'GET') return send(res, 200, { ...syncState, configured: !!process.env.MONDAY_API_TOKEN, workspaces: mondayWorkspaces(), pull: { ...pullState, enabled: livePullOn() } });
    if (method === 'POST') {
      if (syncState.running) throw new HttpError(409, 'A copy from Monday is already running.');
      if (!process.env.MONDAY_API_TOKEN) throw new HttpError(400, 'Add MONDAY_API_TOKEN to the server settings first.');
      startMondaySync(user);
      return send(res, 202, syncState);
    }
  }

  // ---- live pull from Monday: run one now (admin only; reads Monday only) ----
  if (p === '/api/admin/monday-pull' && method === 'POST') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can pull from Monday.');
    if (!process.env.MONDAY_API_TOKEN) throw new HttpError(400, 'Add MONDAY_API_TOKEN to the server settings first.');
    if (pullState.running || syncState.running) throw new HttpError(409, 'Monday is already being read. Try again in a minute.');
    await runMondayPull();
    return send(res, 200, pullState);
  }

  // ---- notifications ----
  if (p === '/api/notifications' && method === 'GET') return send(res, 200, { unread: nq.unread.get(user.id).n, items: nq.list.all(user.id).map(n => ({ ...n, read: !!n.read })) });
  if (p === '/api/notifications/read' && method === 'POST') {
    const b = await readBody(req);
    if (b.all) nq.readAll.run(user.id); else for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 200)) nq.readOne.run(user.id, String(id));
    return send(res, 200, { ok: true, unread: nq.unread.get(user.id).n });
  }
  // The page's automations ("notify someone") ask for in-app notifications for named people. Unknown names are skipped.
  if (p === '/api/notify' && method === 'POST') {
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    const b = await readBody(req);
    const bid = String(b.board || ''), iid = String(b.item || '');
    if (!bid || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    mustSee(user, bid);
    const names = (Array.isArray(b.to) ? b.to : String(b.to || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
    const text = String(b.text || '').trim(); if (!text) throw new HttpError(400, 'Say what the notification is about.');
    return send(res, 200, { ok: true, sent: notifyNames(names, { kind: b.kind === 'reminder' ? 'reminder' : 'automation', text, board: bid, item: iid || null }) });
  }

  // ---- files ----
  if (p === '/api/files' && method === 'POST') {
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    const bid = url.searchParams.get('board') || '', iid = url.searchParams.get('item') || '';
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    mustSee(user, bid);
    let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch (e) {}
    name = name.replace(/[\\/\r\n\0]/g, '_').trim().slice(0, 200) || 'file';
    const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().slice(0, 100);
    if (Number(req.headers['content-length'] || 0) > MAX_FILE) throw new HttpError(413, 'Files can be up to 25 MB.');
    const id = 'f_' + crypto.randomBytes(12).toString('base64url');
    const size = await saveUpload(req, path.join(FILES_DIR, id));
    db.prepare('INSERT INTO files (id, name, type, size, board, item, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, type, size, bid, iid || null, now(), user.id);
    return send(res, 201, { id, name, size, type, url: '/api/files/' + id });
  }
  const fm = /^\/api\/files\/(f_[A-Za-z0-9_-]{8,40})$/.exec(p);
  if (fm && method === 'GET') {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fm[1]);
    if (!f || !boardInfo(f.board) || !canSee(user, boardInfo(f.board).access)) throw new HttpError(404, 'That file doesn’t exist or isn’t shared with you.');
    const full = path.join(FILES_DIR, f.id); if (!fs.existsSync(full)) throw new HttpError(404, 'That file is missing on the server.');
    const SAFE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/;
    const inline = url.searchParams.get('inline') === '1' && SAFE.test(f.type || '');
    res.writeHead(200, { 'Content-Type': SAFE.test(f.type || '') ? f.type : 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}` });
    fs.createReadStream(full).pipe(res);
    return;
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
    let hit = summaryCache.get(ws);
    if (!hit || Date.now() - hit.at > 60000) { hit = { at: Date.now(), boards: buildSummary(ws) }; summaryCache.set(ws, hit); }
    return send(res, 200, summaryFor(ws, hit.boards.filter(x => canSee(user, x.access))));
  }

  // ---- documents ----
  if (p === '/api/col' && method === 'GET') {
    const col = url.searchParams.get('path') || '';
    if (!COLLECTION_RE.test(col)) throw new HttpError(400, 'Unknown collection.');
    const bid = boardOfPath(col); if (bid) mustSee(user, bid);
    let rows = q.docsInCol.all(col).map(r => ({ id: r.id, data: JSON.parse(r.data) }));
    if (col === 'boards') rows = rows.filter(r => canSee(user, r.data.access));
    return send(res, 200, rows);
  }
  if (p === '/api/doc') {
    const dp = url.searchParams.get('path') || '';
    if (!DOC_RE.test(dp)) throw new HttpError(400, 'Unknown document.');
    const { col, id } = splitDoc(dp);
    const bid = boardOfPath(dp); if (bid) mustSee(user, bid);
    if (method === 'GET') { const r = q.doc.get(dp); return send(res, 200, r ? { id, exists: true, data: JSON.parse(r.data) } : { id, exists: false }); }
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    if (dp.startsWith('meta/') && user.role !== 'admin') throw new HttpError(403, 'Only admins can change workspace settings.');
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      let data = body;
      const prev = q.doc.get(dp), before = prev ? JSON.parse(prev.data) : null;
      // Only admins decide who can see a board.
      if (/^boards\/[^/]+$/.test(dp) && user.role !== 'admin') {
        const was = before ? before.access : undefined;
        if (method === 'PATCH' && 'access' in body && JSON.stringify(body.access) !== JSON.stringify(was)) throw new HttpError(403, 'Only admins can change who sees a board.');
        delete body.access;
        if (method === 'PUT' && was !== undefined) data.access = was;
      }
      if (/^boards\/[^/]+$/.test(dp) && user.role === 'admin' && data.access) data.access = cleanAccess(data.access, method === 'PATCH' && before ? before.access : null);
      if (method === 'PATCH') {
        if (!prev) throw new HttpError(404, 'That record no longer exists.');
        data = merge(JSON.parse(prev.data), body);
      }
      const json = JSON.stringify(data);
      if (json.length > 1024 * 1024) throw new HttpError(413, 'That record is too large.');
      q.upsertDoc.run(dp, col, id, json, now(), user.id);
      { const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(dp); if (m) buzz(m[1], m[2], before, data, user.id); }
      if (col === 'boards') boardCache.delete(id);
      broadcast({ op: 'set', col, id, data });
      integ.itemChanged(dp, before, data, user.id);
      try { itemNotifications(dp, before, data, user); } catch (e) { console.error('notifications:', e.message); }
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      const prev = q.doc.get(dp);
      q.deleteDoc.run(dp);
      if (prev) integ.itemChanged(dp, JSON.parse(prev.data), null, user.id);
      if (/^boards\/[^/]+$/.test(dp)) { q.deleteCol.run(dp + '/items'); boardCache.delete(id); }
      broadcast({ op: 'delete', col, id });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- home summary ----------
// Per-board numbers are cached per workspace; each person's summary adds up only the boards they can see.
const summaryCache = new Map();
function buildSummary(ws) {
  const day = d => d.toISOString().slice(0, 10);
  const today = day(new Date()), weekAgo = Date.now() - 7 * 864e5, inWeek = day(new Date(Date.now() + 7 * 864e5));
  const sparkStart = new Date(Date.now() - 13 * 864e5); sparkStart.setUTCHours(0, 0, 0, 0);
  const boards = [];
  for (const r of q.docsInCol.all('boards')) {
    let b; try { b = JSON.parse(r.data); } catch (e) { continue; }
    const w = (b.workspace && b.workspace.id) || 'main'; if (w !== ws) continue;
    const followCols = (b.columns || []).filter(c => c.type === 'date' && /follow|next|callback|due/i.test(c.title)).map(c => c.id);
    const x = { id: r.id, name: b.name, folder: b.folder || '', access: b.access || null, count: 0, newWeek: 0, spark: Array(14).fill(0), overdue: 0, dueToday: 0, upcoming: 0 };
    for (const it of q.docsInCol.all(`boards/${r.id}/items`)) {
      let d; try { d = JSON.parse(it.data); } catch (e) { continue; }
      x.count++;
      const c = d.createdAt ? Date.parse(d.createdAt) : NaN;
      if (c >= weekAgo) x.newWeek++;
      if (c >= sparkStart.getTime()) { const k = Math.floor((c - sparkStart.getTime()) / 864e5); if (k >= 0 && k < 14) x.spark[k]++; }
      for (const fc of followCols) {
        const v = (d.values || {})[fc]; if (!v) continue;
        if (v < today) x.overdue++; else if (v === today) x.dueToday++; else if (v <= inWeek) x.upcoming++;
        break;
      }
    }
    boards.push(x);
  }
  return boards;
}
function summaryFor(ws, list) {
  const spark = Array(14).fill(0), followups = { overdue: 0, dueToday: 0, upcoming: 0 }; let total = 0, newWeek = 0;
  for (const x of list) { total += x.count; newWeek += x.newWeek; x.spark.forEach((v, k) => { spark[k] += v; }); followups.overdue += x.overdue; followups.dueToday += x.dueToday; followups.upcoming += x.upcoming; }
  const boards = list.map(x => ({ id: x.id, name: x.name, count: x.count, newWeek: x.newWeek, folder: x.folder })).sort((a, b) => b.count - a.count);
  return { ws, total, newWeek, spark, boards, followups };
}
function cleanAccess(a) {
  const members = [...new Set((Array.isArray(a.members) ? a.members : []).map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+$/.test(e)))].sort();
  return { private: !!a.private, members, ...(a.kind ? { kind: String(a.kind) } : {}) };
}
// Raw-body upload to disk, up to 25 MB.
function saveUpload(req, file) {
  return new Promise((resolve, reject) => {
    const tmp = file + '.part', out = fs.createWriteStream(tmp); let size = 0, failed = false;
    const fail = e => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); reject(e); };
    req.on('data', c => { size += c.length; if (size > MAX_FILE) { fail(new HttpError(413, 'Files can be up to 25 MB.')); req.destroy(); } });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (failed) return; if (!size) { fs.rm(tmp, { force: true }, () => {}); return reject(new HttpError(400, 'That file is empty.')); } fs.rename(tmp, file, e => e ? reject(e) : resolve(size)); });
    req.pipe(out);
  });
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
    // the live pull carries on from the moment this copy started
    savePull({ lastPullAt: syncState.startedAt });
  }).catch(e => {
    console.error('Monday sync failed:', e);
    Object.assign(syncState, { running: false, error: e.message, finishedAt: now() });
  }).finally(() => {
    const { running, ...keep } = syncState;
    q.upsertDoc.run('meta/monday-sync', 'meta', 'monday-sync', JSON.stringify(keep), now(), 'monday-sync');
    boardCache.clear(); summaryCache.clear();
    broadcast({ op: 'reload' });
  });
}

// ---------- live pull from Monday (every 5 minutes; reads Monday only) ----------
// MONDAY_LIVE_PULL=on|off. Defaults to on when MONDAY_API_TOKEN is set.
const livePullOn = () => !!process.env.MONDAY_API_TOKEN && String(process.env.MONDAY_LIVE_PULL || 'on').toLowerCase() !== 'off';
let pullState = { running: false, lastPullAt: null, lastRunAt: null, error: null, saved: 0, removed: 0, checked: 0 };
{ const r = q.doc.get('meta/monday-pull'); if (r) { try { Object.assign(pullState, JSON.parse(r.data), { running: false }); } catch (e) {} } }
function savePull(patch) {
  Object.assign(pullState, patch);
  const { running, ...keep } = pullState;
  q.upsertDoc.run('meta/monday-pull', 'meta', 'monday-pull', JSON.stringify(keep), now(), 'monday-sync');
}
async function runMondayPull() {
  if (pullState.running || syncState.running) return;
  pullState.running = true;
  try {
    const wss = new Set(mondayWorkspaces());
    const boards = [];
    for (const r of q.docsInCol.all('boards')) {
      let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
      if (!d.mondayId || d.source !== 'monday') continue;
      if (wss.size && !wss.has(String((d.workspace || {}).id))) continue;
      boards.push({ bid: r.id, mondayId: d.mondayId, columns: d.columns || [], subColumns: d.subColumns || [], groups: d.groups || [] });
    }
    const since = pullState.lastPullAt || syncState.startedAt || new Date(Date.now() - 864e5).toISOString();
    const itemPath = (bid, iid) => `boards/${bid}/items/${iid}`;
    const store = {
      getItem: (bid, iid) => { const r = q.doc.get(itemPath(bid, iid)); return r ? JSON.parse(r.data) : null; },
      saveItem: (bid, iid, doc) => { const prev = q.doc.get(itemPath(bid, iid)); q.upsertDoc.run(itemPath(bid, iid), `boards/${bid}/items`, String(iid), JSON.stringify(doc), now(), 'monday-sync'); broadcast({ op: 'set', col: `boards/${bid}/items`, id: String(iid), data: doc }); buzz(bid, iid, prev ? JSON.parse(prev.data) : null, doc, 'monday'); },
      removeItem: (bid, iid) => {
        const r = q.doc.get(itemPath(bid, iid)); if (!r) return false;
        let d = {}; try { d = JSON.parse(r.data); } catch (e) {}
        if (!d.mondayId) return false; // made in Solver.ca: never removed by a pull
        q.deleteDoc.run(itemPath(bid, iid)); broadcast({ op: 'delete', col: `boards/${bid}/items`, id: String(iid) }); return true;
      },
      saveGroups: (bid, groups) => {
        const r = q.doc.get('boards/' + bid); if (!r) return;
        const d = JSON.parse(r.data); d.groups = groups;
        q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(d), now(), 'monday-sync'); broadcast({ op: 'set', col: 'boards', id: bid, data: d });
      },
      newPos: bid => { const r = db.prepare("SELECT MIN(json_extract(data, '$.pos')) AS p FROM docs WHERE col = ?").get(`boards/${bid}/items`); return (Number(r && r.p) || 0) - 1; },
    };
    const r = await pullFromMonday({ token: process.env.MONDAY_API_TOKEN, boards, since, store });
    savePull({ lastPullAt: r.at, lastRunAt: now(), error: null, saved: r.saved, removed: r.removed, checked: r.checked, boards: r.boards });
    if (r.saved || r.removed) summaryCache.clear();
  } catch (e) {
    console.error('Monday live pull failed:', e.message);
    savePull({ lastRunAt: now(), error: e.message });
  } finally { pullState.running = false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/login') return serveStatic(req, res, 'login.html');
    if (url.pathname === '/developers') return serveStatic(req, res, 'developers.html');
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
  // First start with a Monday token: fill in each board's private/open access from Monday (read-only), once.
  if (process.env.MONDAY_API_TOKEN && q.docsInCol.all('boards').some(r => { try { return !JSON.parse(r.data).access; } catch (e) { return false; } })) {
    const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'scripts', 'monday-board-access.js')], { stdio: 'inherit', env: process.env });
    child.on('exit', code => console.log('Board access from Monday:', code === 0 ? 'done' : 'failed (' + code + ')'));
  }
  server.listen(PORT, () => console.log(`Solver.ca running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
  if (livePullOn()) {
    const every = 5 * 60 * 1000;
    setInterval(() => { runMondayPull(); }, every).unref();
    setTimeout(() => { runMondayPull(); }, 20000).unref();
    console.log('Live pull from Monday: on, every 5 minutes.');
  }
}
