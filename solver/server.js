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
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync, StatementSync } = require('node:sqlite');
// The search index (FTS5 with contentless_delete) writes "tombstone" rows whose row numbers start at 2^53. SQLite then
// reports that number as the connection's last inserted row id, and node:sqlite throws ERR_OUT_OF_RANGE from run()
// AFTER the statement has already done its work. Every later UPDATE/upsert then "failed" (saves, the Monday pull).
// The fix: such a run() returns the real change count and resets the last row id so the next statement is clean.
{ const orig = StatementSync.prototype.run; let fix = null;
  StatementSync.prototype.run = function (...a) {
    try { return orig.apply(this, a); }
    catch (e) {
      if (!e || e.code !== 'ERR_OUT_OF_RANGE' || !fix) throw e;
      const changes = fix.changes.get().c; orig.call(fix.reset);
      return { changes, lastInsertRowid: 0 };
    }
  };
  StatementSync.setRowidFix = d => { d.exec('CREATE TEMP TABLE IF NOT EXISTS rowid_reset (id INTEGER PRIMARY KEY)'); fix = { changes: d.prepare('SELECT changes() AS c'), reset: d.prepare('INSERT OR REPLACE INTO rowid_reset (id) VALUES (1)') }; };
}
const { syncFromMonday, pullFromMonday } = require('./monday.js');
const mondayMerge = require('./monday.js');
const uploadCols = new Map(); // board id -> its Monday columns, from the board record of an uploaded Monday copy
const sec = require('./security.js');
const sheets = require('./sheets.js');
const netguard = require('./netguard.js');

// A stray promise or exception is logged instead of passing unnoticed (or taking every open page down with it).
process.on('unhandledRejection', e => console.error('Unhandled promise rejection:', e && e.stack || e));
process.on('uncaughtException', e => console.error('Uncaught exception:', e && e.stack || e));

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
StatementSync.setRowidFix(db);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_size_limit = 33554432;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member','viewer','guest')),
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
  CREATE INDEX IF NOT EXISTS docs_id ON docs(id);
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
// Older databases only allowed admin/member/viewer: rebuild the users table once so 'guest' is allowed too.
{ const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (row && !row.sql.includes("'guest'")) {
    db.exec('PRAGMA foreign_keys = OFF'); db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE users_new (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','member','viewer','guest')),
        pw TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, home_board TEXT)`);
      db.exec('INSERT INTO users_new (id, email, name, role, pw, created_at, disabled, home_board) SELECT id, email, name, role, pw, created_at, disabled, home_board FROM users');
      db.exec('DROP TABLE users'); db.exec('ALTER TABLE users_new RENAME TO users'); db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  } }
// two-factor sign-in (TOTP) and how each session signed in
for (const sql of ['ALTER TABLE users ADD COLUMN totp_secret TEXT', 'ALTER TABLE users ADD COLUMN totp_pending TEXT', 'ALTER TABLE users ADD COLUMN totp_on INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT -1', 'ALTER TABLE users ADD COLUMN backup_codes TEXT', "ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'pw'"]) { try { db.exec(sql); } catch (e) { /* already there */ } }

// ---------- helpers ----------
const now = () => new Date().toISOString();
const TIME_ZONE = (() => { const z = process.env.KS_TIMEZONE || 'America/Toronto'; try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return z; } catch (e) { return 'America/Toronto'; } })();
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
// keys that would reach Object.prototype (prototype pollution): never copied from anything a person sends
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeJson = text => JSON.parse(text, (k, v) => BAD_KEYS.has(k) ? undefined : v);
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (BAD_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  users: db.prepare('SELECT id, email, name, role, created_at, disabled, home_board, totp_on FROM users ORDER BY name'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (id, email, name, role, pw, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  session: db.prepare('SELECT s.token, s.expires, s.method, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, expires, method) VALUES (?, ?, ?, ?)'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  docsInCol: db.prepare('SELECT id, data FROM docs WHERE col = ?'),
  doc: db.prepare('SELECT id, data FROM docs WHERE path = ?'),
  upsertDoc: db.prepare(`INSERT INTO docs (path, col, id, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
  deleteDoc: db.prepare('DELETE FROM docs WHERE path = ?'),
  deleteCol: db.prepare('DELETE FROM docs WHERE col = ?'),
};

const ROLES = ['admin', 'member', 'viewer', 'guest'];
function createUser({ email, name, role, password }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!name) throw new HttpError(400, 'Enter a name.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin, member, viewer or guest.');
  if (String(password || '').length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (q.userByEmail.get(email)) throw new HttpError(409, 'Someone already uses that email.');
  const id = newId('u_');
  q.insertUser.run(id, email, name, role, hashPassword(password), now());
  return { id, email, name, role };
}
module.exports = { createUser, db, q, merge, now };

// ---------- who can see which board ----------
// A board doc may carry access: { private: true|false, members: [emails] }. Admins see every board;
// members and viewers see open boards and the private boards that list their email.
// Guests (a lender, a lawyer) only ever see the boards that list their email, open or private.
function canSee(u, access) {
  if (u && u.role === 'guest') {
    const me = String(u.email || '').toLowerCase();
    return !!me && !!access && (access.members || []).some(e => String(e).toLowerCase() === me);
  }
  if (!access || !access.private) return true;
  if (!u) return false;
  if (u.role === 'admin') return true;
  const me = String(u.email || '').toLowerCase();
  return !!me && (access.members || []).some(e => String(e).toLowerCase() === me);
}
const boardCache = new Map(); // board id -> { t, v: { name, access, columns, perms, groups } | null }
function boardInfo(bid) {
  const hit = boardCache.get(bid); if (hit && Date.now() - hit.t < 10000) return hit.v;
  const r = q.doc.get('boards/' + bid); let v = null;
  if (r) { try { const d = JSON.parse(r.data); v = { name: d.name, access: d.access || null, columns: d.columns || [], perms: d.perms || null, groups: d.groups || [] }; } catch (e) {} }
  boardCache.set(bid, { t: Date.now(), v }); return v;
}
const boardOfPath = p => { const m = /^boards\/([^/]+)(\/items(\/[^/]+)?)?$/.exec(p || ''); return m ? m[1] : null; };
function mustSee(user, bid) { const b = boardInfo(bid); if (b && !canSee(user, b.access)) throw new HttpError(404, 'That board doesn’t exist or isn’t shared with you.'); return b; }

// ---------- fine-grained permissions, per board (admins set them in the Access window) ----------
// board.perms = { locks: { colId: [emails who may still edit] }, assignedOnly: [person col ids], guestEdit: [col ids] }
const permsOf = b => (b && b.perms) || {};
const lowerList = a => (Array.isArray(a) ? a : []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
// Columns this person may NOT change. Admins can change everything. Guests can only change guest-editable columns.
// API keys and lead links are `null` users: locked columns are closed to them too.
function lockedCols(user, b) {
  const out = new Set(); if (!b) return out;
  if (user && user.role === 'admin') return out;
  const locks = permsOf(b).locks || {}, me = String((user && user.email) || '').toLowerCase();
  for (const [cid, emails] of Object.entries(locks)) if (!me || !lowerList(emails).includes(me)) out.add(cid);
  if (user && user.role === 'guest') { const ge = new Set(permsOf(b).guestEdit || []); for (const c of b.columns || []) if (!ge.has(c.id)) out.add(c.id); }
  return out;
}
const colTitle = (b, cid) => ((b.columns || []).find(c => c.id === cid) || {}).title || cid;
const baseCol = k => String(k).replace(/__d?t$/, ''); // "date4__dt" (Monday's time part) belongs to "date4"
function changedCols(before, after) {
  const x = (before && before.values) || {}, y = (after && after.values) || {}, out = new Set();
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[k] ?? '') !== JSON.stringify(y[k] ?? '')) out.add(baseCol(k));
  return out;
}
function lockError(b, cols) {
  const names = [...cols].map(c => '“' + colTitle(b, c) + '”');
  const e = new HttpError(403, `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} locked on this board. Only admins${Object.keys(permsOf(b).locks || {}).length ? ' and the people the admin listed' : ''} can change ${names.length === 1 ? 'it' : 'them'}.`);
  e.code = 'locked'; return e;
}
// "Members see only items assigned to them": a person column holds names like "Jan Smith, Ana".
// Someone matches by full name or email (any case), or by first name alone when no one else on the team shares it.
let teamCache = { at: 0, users: [] };
const activeTeam = () => { if (Date.now() - teamCache.at > 5000) teamCache = { at: Date.now(), users: db.prepare('SELECT id, email, name, role FROM users WHERE disabled = 0').all() }; return teamCache.users; };
function personMatches(user, cell) {
  const full = norm(user.name), email = norm(user.email), first = full.split(' ')[0];
  const firstUnique = !!first && activeTeam().filter(u => norm(u.name).split(' ')[0] === first).length === 1;
  return String(cell || '').split(',').map(norm).filter(Boolean).some(n => n === full || n === email || (firstUnique && !n.includes(' ') && n === first));
}
function itemVisible(user, b, item) {
  if (!b || !item) return true;
  if (user && user.role === 'admin') return true;
  const cols = permsOf(b).assignedOnly || []; if (!cols.length) return true;
  if (!user) return false;
  return cols.some(cid => personMatches(user, (item.values || {})[cid]));
}
const restricted = (user, b) => !!b && !(user && user.role === 'admin') && (permsOf(b).assignedOnly || []).length > 0;
// Guests never see who else a board is shared with.
function boardForUser(user, data) {
  if (!data || !user || user.role !== 'guest') return data;
  const { access, perms, ...rest } = data;
  return { ...rest, access: { private: true, members: [String(user.email).toLowerCase()] }, perms: { guestEdit: (perms && perms.guestEdit) || [], locks: Object.fromEntries(Object.keys((perms && perms.locks) || {}).map(k => [k, []])) } };
}
function cleanPerms(p, b) {
  const ids = new Set(((b && b.columns) || []).map(c => c.id)), person = new Set(((b && b.columns) || []).filter(c => c.type === 'person').map(c => c.id));
  const locks = {};
  for (const [cid, emails] of Object.entries((p && p.locks) || {})) if (ids.has(cid)) locks[cid] = [...new Set(lowerList(emails).filter(e => /^[^@\s]+@[^@\s]+$/.test(e)))].sort();
  return { locks, assignedOnly: [...new Set(((p && p.assignedOnly) || []).filter(c => person.has(c)))], guestEdit: [...new Set(((p && p.guestEdit) || []).filter(c => ids.has(c)))] };
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- live updates (server-sent events) ----------
// Each open page is tracked with its signed-in person, so private boards' changes only reach people who can see them.
const clients = new Map(); // res -> { id, email, role, name }  (each open page and its signed-in person)
// A page that stopped reading (asleep, bad network) is dropped once 5 MB is waiting for it; it reconnects and reloads.
const SSE_MAX_BUFFER = 5 * 1024 * 1024;
function sseWrite(res, line) {
  if (res.writableLength > SSE_MAX_BUFFER || res.destroyed) { clients.delete(res); try { res.destroy(); } catch (e) {} return; }
  res.write(line);
}
function broadcast(evt) {
  // evt.prevAccess (not sent): the board's access before this change, so only people who just lost it are told it's gone
  const prevAccess = evt.prevAccess; if ('prevAccess' in evt) { evt = { ...evt }; delete evt.prevAccess; }
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  if (evt.op === 'notify' || evt.op === 'notifs-read') { for (const [res, u] of clients) if (u.id === evt.user) sseWrite(res, line); return; }
  if (evt.op === 'reload') { for (const res of clients.keys()) sseWrite(res, line); return; }
  const bid = evt.col === 'boards' ? evt.id : boardOfPath(evt.col);
  if (evt.col === 'boards') boardCache.delete(evt.id);
  if (!bid) { for (const [res, u] of clients) if (u.role !== 'guest') sseWrite(res, line); return; } // workspace settings: never to guests
  const isBoard = evt.col === 'boards';
  const access = isBoard && evt.op === 'set' ? (evt.data || {}).access : (boardInfo(bid) || {}).access;
  const gone = isBoard && evt.op === 'set' ? `data: ${JSON.stringify({ op: 'delete', col: 'boards', id: evt.id })}\n\n` : null;
  const info = isBoard ? null : boardInfo(bid);
  // an item-level event on a board where non-admins only see items assigned to them: check each person
  let itemData;
  const itemNow = () => { if (itemData === undefined) { itemData = evt.data || null; if (!itemData && evt.op !== 'delete') { const r = q.doc.get(`${evt.col}/${evt.id}`); itemData = r ? JSON.parse(r.data) : null; } } return itemData; };
  const hide = `data: ${JSON.stringify({ op: 'delete', col: evt.col, id: evt.id })}\n\n`;
  for (const [res, u] of clients) {
    if (!canSee(u, access)) { if (gone && (prevAccess !== undefined ? canSee(u, prevAccess) : u.role !== 'guest')) sseWrite(res, gone); continue; }
    if (isBoard && u.role === 'guest' && evt.op === 'set') { sseWrite(res, `data: ${JSON.stringify({ ...evt, data: boardForUser(u, evt.data) })}\n\n`); continue; }
    if (!isBoard && restricted(u, info) && evt.op !== 'delete' && !itemVisible(u, info, itemNow())) { if (evt.op === 'set') sseWrite(res, hide); continue; }
    sseWrite(res, line);
  }
}
function refreshClients(userId) {
  const row = q.userById.get(userId);
  for (const [res, u] of clients) if (u.id === userId) { if (!row || row.disabled) { clients.delete(res); res.end(); } else Object.assign(u, { email: row.email, role: row.role, name: row.name }); }
}
// a signed-out (or reset) session's open live-update streams are closed straight away
function closeStreams(match) { for (const [res, u] of [...clients]) if (match(u)) { clients.delete(res); try { res.end(); } catch (e) {} } }
setInterval(() => { for (const [res, u] of [...clients]) { if (u.token && !q.session.get(u.token)) { clients.delete(res); try { res.end(); } catch (e) {} continue; } sseWrite(res, ': ping\n\n'); } }, 25000).unref();

// A lead that was ever in a Junk/Unqualified group keeps a wasJunk mark when it's moved out (by hand or from Monday),
// so email.js never messages it, even when nothing in its activity says so.
function markWasJunk(bid, before, after) {
  try {
    if (!before || !after || typeof after !== 'object') return;
    if (before.wasJunk) { after.wasJunk = true; return; }
    if (!before.group || before.group === after.group) return;
    const r = q.doc.get('boards/' + bid); const g = r && (JSON.parse(r.data).groups || []).find(x => x.id === before.group);
    if (g && /junk|unqualified/i.test(String(g.name || ''))) after.wasJunk = true;
  } catch (e) { /* never breaks a save */ }
}
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
    if (b && item && restricted(u, b)) { const r = q.doc.get(`boards/${board}/items/${item}`); if (r && !itemVisible(u, b, JSON.parse(r.data))) continue; }
    const row = { id: newId('n_'), at: now(), kind, text: String(text).slice(0, 400), board: board || null, item: item || null, read: 0 };
    nq.insert.run(row.id, u.id, row.at, row.kind, row.text, row.board, row.item);
    broadcast({ op: 'notify', user: u.id, n: row }); n++;
    if (ext) ext.onNotify(u, row); // phone/desktop push and email alerts, for people who turned them on
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
    const tidy = s => String(s || '').replace(/['’]s$/i, '').replace(/[.'’-]+$/, ''); // "@Mariel." and "@Jerico’s lead" mean Mariel and Jerico
    const two = m[2] ? norm(tidy(m[1]) + ' ' + tidy(m[2])) : null, one = norm(tidy(m[1]));
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
  const text = typeof body === 'string';
  return sendData(res, status, text ? body : JSON.stringify(body), text ? 'text/plain; charset=utf-8' : 'application/json', headers);
}
// JSON that is already a string (stored documents are sent as stored, without parsing them again)
const sendJson = (res, status, json, headers) => sendData(res, status, json, 'application/json', headers);
// Gzip at most 3 at a time: a stampede of big answers queues instead of holding dozens of buffers at once.
let gzActive = 0; const gzQueue = [];
function gzipLimited(data) {
  return new Promise((resolve, reject) => {
    const run = () => { gzActive++; zlib.gzip(data, { level: 5 }, (err, gz) => { gzActive--; const nx = gzQueue.shift(); if (nx) nx(); if (err) reject(err); else resolve(gz); }); };
    if (gzActive < 3) run(); else gzQueue.push(run);
  });
}
// Bigger answers are gzipped for browsers that accept it (boards with thousands of items shrink ~8x).
function sendData(res, status, data, type, headers = {}) {
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers };
  const ae = String((res.req && res.req.headers['accept-encoding']) || '');
  if (data.length > 8192 && /\bgzip\b/i.test(ae) && !h['Content-Encoding']) {
    gzipLimited(data).then(gz => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length }); res.end(gz);
    }, () => { if (res.headersSent || res.destroyed) return; res.writeHead(status, h); res.end(data); });
    return;
  }
  res.writeHead(status, h); res.end(data);
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'That change is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = safeJson(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; resolve(v); }
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
  return { id: row.id, email: row.email, name: row.name, role: row.role, homeBoard: row.home_board || '', emailFrom: row.email_from || '', token, method: row.method || 'pw', totpOn: !!row.totp_on, needs2fa: needsTwoFactor(row, row.method) };
}
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, homeBoard: u.homeBoard ?? u.home_board ?? '', sends: !!(u.email_from || u.emailFrom) });

// ---------- sign-in security settings (meta/security, admins only) ----------
let secCache = { at: 0, v: null };
function secSettings() {
  if (secCache.v && Date.now() - secCache.at < 3000) return secCache.v;
  let v = {}; try { const r = q.doc.get('meta/security'); if (r) v = JSON.parse(r.data) || {}; } catch (e) {}
  secCache = { at: Date.now(), v: { require2fa: !!v.require2fa, googleCounts2fa: !!v.googleCounts2fa } };
  return secCache.v;
}
// With "Require two-factor for everyone" on, a person without it must set it up before anything else works.
// A Google sign-in is exempt when the admin turned on "Google sign-in counts as two-factor".
function needsTwoFactor(row, method) {
  const st = secSettings();
  return st.require2fa && !row.totp_on && !(method === 'google' && st.googleCounts2fa);
}
function startSession(u, method) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.insertSession.run(token, u.id, expires, method || 'pw');
  return `ks_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`;
}
// Password (or Google) done, code still needed: a short-lived ticket, at most 5 tries.
const tickets = new Map(); // ticket -> { uid, method, exp, tries }
function newTicket(uid, method) {
  for (const [k, t] of tickets) if (t.exp < Date.now()) tickets.delete(k);
  const t = crypto.randomBytes(24).toString('base64url'); tickets.set(t, { uid, method, exp: Date.now() + 5 * 60 * 1000, tries: 0 }); return t;
}
// Wrong codes per person: 8 in 15 minutes locks code entry for 15 minutes.
const codeFails = new Map();
function codeLocked(uid) { const r = codeFails.get(uid); if (!r) return false; if (Date.now() - r.at > 15 * 60 * 1000) { codeFails.delete(uid); return false; } return r.n >= 8; }
function codeFailed(uid) { const r = codeFails.get(uid) || { n: 0, at: Date.now() }; r.n++; r.at = Date.now(); codeFails.set(uid, r); }
// Checks a 6-digit authenticator code, or one of the person's unused backup codes (which is then used up).
function checkSecondFactor(uid, code) {
  const u = q.userById.get(uid); if (!u || !u.totp_on || !u.totp_secret) return null;
  const k = sec.verifyTotp(u.totp_secret, code, u.totp_last);
  if (k !== null) { db.prepare('UPDATE users SET totp_last = ? WHERE id = ?').run(k, uid); return 'totp'; }
  if (sec.looksLikeBackup(code)) {
    const list = JSON.parse(u.backup_codes || '[]'), h = sec.hashBackup(uid, code), i = list.indexOf(h);
    if (i >= 0) { list.splice(i, 1); db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(list), uid); return 'backup'; }
  }
  return null;
}
function newBackupCodesFor(uid) { const codes = sec.newBackupCodes(10); db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(codes.map(c => sec.hashBackup(uid, c))), uid); return codes; }
function clearTwoFactor(uid) { db.prepare("UPDATE users SET totp_on = 0, totp_secret = NULL, totp_pending = NULL, totp_last = -1, backup_codes = NULL WHERE id = ?").run(uid); }
const googleStates = new Map(); // state -> { nonce, exp, redirectUri }
function googleRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/+$/, '')
    : `${String(req.headers['x-forwarded-proto'] || (SECURE_COOKIE ? 'https' : 'http')).split(',')[0].trim()}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  return base + '/api/auth/google/callback';
}
const canWrite = u => u && (u.role === 'admin' || u.role === 'member');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
function serveStatic(req, res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  // videos: byte ranges (Safari on iPhone won't play a video without them) and a day of caching
  if (path.extname(full) === '.mp4') {
    return fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      const head = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...head, 'Content-Length': st.size });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(full).pipe(res);
    });
  }
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const html = path.extname(full) === '.html';
    if (/\.(jpg|webp|png)$/.test(full) && full.includes(path.sep + 'media' + path.sep)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(full)], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }); return res.end(buf); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      ...(html ? { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } : {}) });
    res.end(buf);
  });
}

// The address a request came from. Behind a proxy (TRUST_PROXY=1, or on Render) every request arrives from the proxy,
// so the address the proxy recorded in X-Forwarded-For is used: the last entry, the one our own proxy added
// (TRUST_PROXY=2 when there are two proxies in a row). Earlier entries are sent by the browser and can be anything.
function clientIp(req) {
  const sock = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const tp = String(process.env.TRUST_PROXY || '').trim();
  const hops = tp ? (Number(tp) > 0 ? Math.min(5, Math.floor(Number(tp))) : /^(true|yes|on)$/i.test(tp) ? 1 : 0) : (process.env.RENDER ? 1 : 0);
  if (!hops) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ip = xff.length ? xff[Math.max(0, xff.length - hops)] : '';
  return net.isIP(ip.replace(/^::ffff:/, '')) ? ip.replace(/^::ffff:/, '') : sock;
}
// Sign-in throttle. Per address: 10 wrong tries in 15 minutes pause sign-in from there for 15 minutes.
// Per account: after 3 wrong tries each further try waits longer (1 s, 2 s, 4 s … at most 60 s), so guessing is slowed
// to a crawl but the account is never shut, and an address the person signed in from before skips that wait (someone
// hammering the account from elsewhere can't keep its owner out).
const loginFails = new Map(); // 'ip:…' or 'acct:…' -> { n, at }
const LOGIN_LIMIT = { ip: 10 };
function throttled(key) {
  const r = loginFails.get(key); if (!r) return false;
  if (Date.now() - r.at > 15 * 60 * 1000) { loginFails.delete(key); return false; }
  return r.n >= LOGIN_LIMIT[key.split(':')[0]];
}
// seconds this account still waits before its next try (0: go ahead)
function acctWait(key) {
  const r = loginFails.get(key); if (!r || r.n <= 3) return 0;
  const left = r.at + Math.min(60, 2 ** (r.n - 4)) * 1000 - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
db.exec('CREATE TABLE IF NOT EXISTS login_known (email TEXT NOT NULL, ip TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (email, ip))');
const knownAddr = { has: db.prepare('SELECT 1 AS k FROM login_known WHERE email = ? AND ip = ?'), add: db.prepare('INSERT INTO login_known (email, ip, at) VALUES (?, ?, ?) ON CONFLICT(email, ip) DO UPDATE SET at = excluded.at') };
function loginFailed(...keys) { for (const k of keys) { const r = loginFails.get(k) || { n: 0, at: Date.now() }; r.n++; r.at = Date.now(); loginFails.set(k, r); } }
setInterval(() => { const t = Date.now(); for (const [k, r] of loginFails) if (t - r.at > 15 * 60 * 1000) loginFails.delete(k); }, 10 * 60 * 1000).unref();
// An unknown email takes as long to refuse as a wrong password (no telling which emails have accounts).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const integHooks = {};
const integ = require('./integrations.js')({ db, q, now, broadcast, HttpError, readBody, send, merge, notifyNames, itemNotifications, fillTemplate, buzz, lockedCols, lockError, hooks: integHooks, clientIp });
// automations editor, AI columns, docs, push and email alerts, calls & texts (see ext.js)
const ext = require('./ext.js')({ db, q, now, broadcast, HttpError, readBody, send, merge, integ, integHooks, boardInfo, canSee, mustSee, itemVisible, lockedCols, lockError, canWrite });
module.exports.integ = integ;
// ---- history, undo, recycle bin, search, templates, public forms, connected columns, time tracking (features.js) ----
const features = require('./features.js')({ db, q, now, broadcast, HttpError, readBody, send, canSee, mustSee, boardInfo, boardCache, itemVisible, restricted, lockedCols, lockError,
  canWrite, integ, ext, cleanAccess, workspaceAccess, itemNotifications, publicDir: PUBLIC_DIR, clearSummary: () => summaryCache.clear(), startIndex: require.main === module, clientIp,
  formulaText: (b, c, item) => { const r = formulaResult(b, item, c); return r.error ? '' : KSFormula.format(r.value); } });
module.exports.features = features;
// ---- a board's items as sent to everyone who sees all of them: built and gzipped once, kept until the next write ----
// (30 people reconnecting at once used to build and gzip the same 20 MB answer 30 times over)
const colCache = new Map(); // col -> { json, gz: Promise<Buffer> | null, bytes }
const COL_CACHE_MAX = 96 * 1024 * 1024;
const colDirty = col => { if (col) colCache.delete(col); };
{ const up = q.upsertDoc, del = q.deleteDoc, dc = q.deleteCol;
  q.upsertDoc = { run(p, col, ...r) { colDirty(col); try { return up.run(p, col, ...r); } finally { colDirty(col); } } };
  q.deleteDoc = { run(p) { const col = String(p).slice(0, String(p).lastIndexOf('/')); colDirty(col); try { return del.run(p); } finally { colDirty(col); } } };
  q.deleteCol = { run(c) { colDirty(c); try { return dc.run(c); } finally { colDirty(c); } } }; }
function colEntry(col) {
  let e = colCache.get(col);
  if (e) { colCache.delete(col); colCache.set(col, e); return e; } // most recently used last
  const rows = q.docsInCol.all(col);
  e = { json: '[' + rows.map(r => '{"id":' + JSON.stringify(r.id) + ',"data":' + r.data + '}').join(',') + ']', gz: null };
  e.bytes = e.json.length * 2;
  colCache.set(col, e);
  let total = 0; for (const x of colCache.values()) total += x.bytes;
  for (const [k, x] of colCache) { if (total <= COL_CACHE_MAX || x === e) break; total -= x.bytes; colCache.delete(k); }
  return e;
}
function sendCol(res, col) {
  const e = colEntry(col), ae = String((res.req && res.req.headers['accept-encoding']) || '');
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (e.json.length <= 8192 || !/\bgzip\b/i.test(ae)) { res.writeHead(200, h); return res.end(e.json); }
  if (!e.gz) { e.gz = gzipLimited(e.json); e.gz.then(b => { e.bytes += b.length; }, () => { e.gz = null; }); }
  e.gz.then(gz => { if (res.headersSent || res.destroyed) return; res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length }); res.end(gz); },
    () => { if (res.headersSent || res.destroyed) return; res.writeHead(200, h); res.end(e.json); });
}
module.exports.setGuestBoards = (...a) => setGuestBoards(...a);

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  if (p.startsWith('/api/v1/')) return integ.handleV1(req, res, url);

  if (p === '/api/auth/config' && method === 'GET') return send(res, 200, { google: sec.googleOn() });
  if (p === '/api/login' && method === 'POST') {
    const ipKey = 'ip:' + clientIp(req);
    // failed sign-ins are logged with a masked email and the reason (never the password), so an admin can see why
    const maskEm = e => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 2)}***@${d}` : '(no email)'; };
    if (throttled(ipKey)) { console.log('Sign-in refused: too many tries from this address'); throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.'); }
    const { email, password } = await readBody(req, 16 * 1024);
    const em = String(email || '').trim().toLowerCase().slice(0, 320), acctKey = 'acct:' + em;
    const ip = clientIp(req), known = !!knownAddr.has.get(em, ip);
    { const w = known ? 0 : acctWait(acctKey); if (w) console.log(`Sign-in refused for ${maskEm(em)}: account paused ${w}s after wrong passwords`); if (w) throw new HttpError(429, `Too many wrong tries for this account. Wait ${w} second${w === 1 ? '' : 's'} and try again.`); }
    const u = q.userByEmail.get(em);
    const pwOk = checkPassword(String(password || ''), u ? u.pw : DUMMY_HASH);
    if (!u || u.disabled || !pwOk) {
      console.log(`Sign-in failed for ${maskEm(em)}: ${!u ? 'no account with that email' : u.disabled ? 'account is turned off' : 'wrong password'}`);
      loginFailed(ipKey, acctKey);
      throw new HttpError(401, 'That email and password don’t match.');
    }
    loginFails.delete(acctKey); // the address count stays: signing in to your own account mustn't reset guessing at others
    // two-factor on: the password alone doesn't sign in; the next step asks for a code
    if (u.totp_on) return send(res, 200, { twofa: true, ticket: newTicket(u.id, 'pw') });
    try { knownAddr.add.run(em, ip, now()); } catch (e) {} // a full sign-in: this address is now known for the account
    return send(res, 200, { ...publicUser(u), setup2fa: needsTwoFactor(u, 'pw') }, { 'Set-Cookie': startSession(u, 'pw') });
  }
  if (p === '/api/login/2fa' && method === 'POST') {
    const ipKey = 'ip:' + clientIp(req);
    if (throttled(ipKey)) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
    const { ticket, code } = await readBody(req);
    const t = tickets.get(String(ticket || ''));
    if (!t || t.exp < Date.now()) { tickets.delete(String(ticket || '')); throw new HttpError(401, 'That sign-in took too long. Start again.'); }
    if (codeLocked(t.uid)) throw new HttpError(429, 'Too many wrong codes. Wait 15 minutes and try again.');
    const kind = checkSecondFactor(t.uid, code);
    if (!kind) {
      t.tries++; codeFailed(t.uid);
      loginFailed(ipKey);
      if (t.tries >= 5) { tickets.delete(String(ticket)); throw new HttpError(401, 'Too many wrong codes. Start again.'); }
      throw new HttpError(401, 'That code didn’t work. Check your authenticator app and try again.');
    }
    tickets.delete(String(ticket)); codeFails.delete(t.uid);
    const u = q.userById.get(t.uid); if (!u || u.disabled) throw new HttpError(401, 'Sign in to continue.');
    const left = JSON.parse(u.backup_codes || '[]').length;
    try { knownAddr.add.run(String(u.email || '').toLowerCase(), clientIp(req), now()); } catch (e) {}
    return send(res, 200, { ...publicUser(u), usedBackup: kind === 'backup', backupLeft: left }, { 'Set-Cookie': startSession(u, t.method) });
  }
  // ---- Sign in with Google (only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set). Never creates accounts. ----
  if (p === '/api/auth/google/start' && method === 'GET') {
    if (!sec.googleOn()) throw new HttpError(404, 'Google sign-in is not set up.');
    for (const [k, v] of googleStates) if (v.exp < Date.now()) googleStates.delete(k);
    const state = crypto.randomBytes(24).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url'), redirectUri = googleRedirectUri(req);
    googleStates.set(state, { nonce, exp: Date.now() + 10 * 60 * 1000, redirectUri });
    res.writeHead(302, { Location: sec.googleAuthUrl({ redirectUri, state, nonce }), 'Cache-Control': 'no-store',
      'Set-Cookie': `ks_gstate=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600${SECURE_COOKIE ? '; Secure' : ''}` });
    return res.end();
  }
  if (p === '/api/auth/google/callback' && method === 'GET') {
    const back = (hash, cookie) => { const h = { Location: '/login#' + hash, 'Cache-Control': 'no-store' }; h['Set-Cookie'] = [`ks_gstate=; Path=/api/auth/google; Max-Age=0`, ...(cookie ? [cookie] : [])]; res.writeHead(302, h); res.end(); };
    const fail = msg => back('error=' + encodeURIComponent(msg));
    if (!sec.googleOn()) return fail('Google sign-in is not set up.');
    const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
    if (url.searchParams.get('error')) return fail('Google sign-in was cancelled.');
    const st = googleStates.get(state); googleStates.delete(state);
    if (!st || st.exp < Date.now() || !state || cookies(req).ks_gstate !== state) return fail('That Google sign-in expired or didn’t start here. Try again.');
    if (!code) return fail('Google didn’t send a sign-in code. Try again.');
    let claims;
    try { claims = await sec.verifyGoogleIdToken(await sec.googleExchange(code, st.redirectUri), { clientId: process.env.GOOGLE_CLIENT_ID, nonce: st.nonce }); }
    catch (e) { console.error('Google sign-in:', e.message); return fail(e.message || 'Google sign-in failed.'); }
    const email = String(claims.email).toLowerCase();
    if (!sec.domainAllowed(email)) return fail('That Google account’s domain isn’t allowed here.');
    const u = q.userByEmail.get(email);
    if (!u || u.disabled) return fail(`There’s no Solver.ca account for ${email}. Ask an admin to add you.`);
    if (u.totp_on && !secSettings().googleCounts2fa) return back('twofa=' + newTicket(u.id, 'google') + '&via=google');
    return back('ok=1', startSession(u, 'google'));
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  // simple CSRF guard: state-changing calls must come from our own page (JSON + same-origin header)
  if (method !== 'GET' && req.headers['x-solver'] !== '1') throw new HttpError(403, 'Request refused.');

  if (p === '/api/logout' && method === 'POST') { q.deleteSession.run(user.token); closeStreams(x => x.token === user.token); return send(res, 200, { ok: true }, { 'Set-Cookie': 'ks_session=; Path=/; Max-Age=0' }); }
  if (p === '/api/me') return send(res, 200, { ...publicUser(user), twofa: user.totpOn, mustSetup2fa: user.needs2fa, signedInWith: user.method, timeZone: TIME_ZONE });

  // ---- two-factor: set up, turn off, new backup codes ----
  if (p === '/api/2fa/status' && method === 'GET') {
    const row = q.userById.get(user.id), st = secSettings();
    return send(res, 200, { on: !!row.totp_on, backupLeft: JSON.parse(row.backup_codes || '[]').length, required: st.require2fa, googleCounts: st.googleCounts2fa, google: sec.googleOn() });
  }
  if (p === '/api/2fa/setup' && method === 'POST') {
    const row = q.userById.get(user.id);
    if (row.totp_on) throw new HttpError(400, 'Two-factor is already on. Turn it off first to move it to a new app.');
    // the same key until it's confirmed, so a second tab or a reload shows the code already scanned
    const secret = row.totp_pending || sec.newSecret();
    if (!row.totp_pending) db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, user.id);
    return send(res, 200, { secret, uri: sec.otpauthUri(secret, user.email) });
  }
  if (p === '/api/2fa/enable' && method === 'POST') {
    const { code } = await readBody(req), row = q.userById.get(user.id);
    if (row.totp_on) throw new HttpError(400, 'Two-factor is already on.');
    if (!row.totp_pending) throw new HttpError(400, 'Start the setup again.');
    if (codeLocked(user.id)) throw new HttpError(429, 'Too many wrong codes. Wait 15 minutes and try again.');
    const k = sec.verifyTotp(row.totp_pending, code, -1);
    if (k === null) { codeFailed(user.id); throw new HttpError(400, 'That code didn’t match. Check the time on your phone and enter the newest code.'); }
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_on = 1, totp_last = ? WHERE id = ?').run(k, user.id);
    console.log(`Two-factor turned on for ${user.email}`);
    return send(res, 200, { ok: true, backupCodes: newBackupCodesFor(user.id) });
  }
  if ((p === '/api/2fa/disable' || p === '/api/2fa/backup-codes') && method === 'POST') {
    const { code } = await readBody(req);
    if (codeLocked(user.id)) throw new HttpError(429, 'Too many wrong codes. Wait 15 minutes and try again.');
    const row = q.userById.get(user.id); if (!row.totp_on) throw new HttpError(400, 'Two-factor is off.');
    if (p === '/api/2fa/disable' && secSettings().require2fa) throw new HttpError(400, 'Your admin requires two-factor for everyone, so it can’t be turned off.');
    const kind = checkSecondFactor(user.id, code);
    if (!kind) { codeFailed(user.id); throw new HttpError(400, 'That code didn’t work.'); }
    if (p === '/api/2fa/disable') { clearTwoFactor(user.id); console.log(`Two-factor turned off by ${user.email}`); return send(res, 200, { ok: true }); }
    return send(res, 200, { ok: true, backupCodes: newBackupCodesFor(user.id) });
  }
  // With "Require two-factor" on, nothing else works until it's set up.
  if (user.needs2fa) { const e = new HttpError(403, 'Set up two-factor sign-in to continue.'); e.code = 'twofa_setup'; throw e; }
  features.setUser(user);
  if (p.startsWith('/api/x/')) return features.handle(req, res, url, user);
  if (p === '/api/admin/security') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can change sign-in settings.');
    if (method === 'GET') return send(res, 200, { ...secSettings(), google: sec.googleOn(), googleDomains: sec.allowedDomains() });
    if (method === 'PUT' || method === 'PATCH') {
      const b = await readBody(req), cur = secSettings();
      const v = { require2fa: typeof b.require2fa === 'boolean' ? b.require2fa : cur.require2fa, googleCounts2fa: typeof b.googleCounts2fa === 'boolean' ? b.googleCounts2fa : cur.googleCounts2fa };
      // don't let the admin lock themselves out: the setting would send them straight to setup with no way back
      if (v.require2fa && !q.userById.get(user.id).totp_on && !(user.method === 'google' && v.googleCounts2fa)) throw new HttpError(400, 'Set up two-factor for yourself first (your menu > Security), then turn this on.');
      q.upsertDoc.run('meta/security', 'meta', 'security', JSON.stringify(v), now(), user.id); secCache = { at: 0, v: null };
      console.log(`Sign-in settings changed by ${user.email}:`, JSON.stringify(v));
      return send(res, 200, v);
    }
  }

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    // pages reconnect after 3-10 s (spread out, so a server restart isn't met by every page at once)
    res.write(`retry: ${3000 + Math.floor(Math.random() * 7000)}\n: connected\n\n`);
    clients.set(res, { id: user.id, email: user.email, role: user.role, name: user.name, token: user.token });
    req.on('close', () => clients.delete(res));
    return;
  }

  if (await ext.handle(req, res, url, user)) return;

  // ---- people ----
  if (p === '/api/users' && method === 'GET') {
    // guests: names only (so update and history authors show), never emails or roles
    if (user.role === 'guest') return send(res, 200, q.users.all().map(u => u.id === user.id ? { id: u.id, name: u.name, role: u.role } : { id: u.id, name: u.name }));
    const efrom = user.role === 'admin' ? new Map(db.prepare('SELECT id, email_from FROM users').all().map(r => [r.id, r.email_from || ''])) : null;
    const list = q.users.all().map(u => user.role === 'admin' ? { ...u, email_from: efrom.get(u.id) || '' } : { id: u.id, name: u.name, role: u.role });
    return send(res, 200, list);
  }
  if (p === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can add people.');
    const b = await readBody(req);
    if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(String(b.email || '').trim().toLowerCase())) throw new HttpError(400, 'That isn’t an email address.');
    if (String(b.name || '').trim().length > 80) throw new HttpError(400, 'Keep the name to 80 characters or fewer.');
    const made = createUser(b);
    if (made.role === 'guest' && Array.isArray(b.boards)) setGuestBoards(made.email, b.boards, user.id);
    return send(res, 201, made);
  }
  const um = p.match(/^\/api\/users\/(u_[A-Za-z0-9_-]+)$/);
  if (um) {
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can change people.');
    const target = q.userById.get(um[1]); if (!target) throw new HttpError(404, 'That person no longer exists.');
    // Remove a person for good: their sign-in, sessions, alerts and board sharing go. What they wrote (updates, history)
    // stays, under their name.
    if (method === 'DELETE') {
      if (target.id === user.id) throw new HttpError(400, 'You can’t remove yourself.');
      if (target.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n <= 1) throw new HttpError(400, 'That’s the last admin. Make someone else an admin first.');
      setGuestBoards(target.email, [], user.id);
      for (const sql of ['DELETE FROM sessions WHERE user_id = ?', 'DELETE FROM notifications WHERE user_id = ?', 'DELETE FROM push_subs WHERE user_id = ?', 'DELETE FROM user_prefs WHERE user_id = ?']) { try { db.prepare(sql).run(target.id); } catch (e) { /* table not there */ } }
      try { db.prepare('DELETE FROM login_known WHERE email = ?').run(String(target.email).toLowerCase()); } catch (e) {}
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      teamCache.at = 0; console.log(`Person removed by an admin: ${target.id}`);
      return send(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.role && !ROLES.includes(b.role)) throw new HttpError(400, 'Role must be admin, member, viewer or guest.');
      if (target.id === user.id && b.role && b.role !== 'admin') throw new HttpError(400, 'You can’t remove your own admin role.');
      if (b.password && String(b.password).length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
      if (b.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, target.id);
      if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim(), target.id);
      // change the email someone signs in with (their sharing on boards moves with it)
      if (typeof b.email === 'string' && b.email.trim().toLowerCase() !== String(target.email).toLowerCase()) {
        const ne = b.email.trim().toLowerCase();
        if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(ne)) throw new HttpError(400, 'That isn’t an email address.');
        if (q.userByEmail.get(ne)) throw new HttpError(409, 'Someone already signs in with that email.');
        const was = String(target.email).toLowerCase();
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(ne, target.id);
        for (const r of q.docsInCol.all('boards')) { let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
          const m = ((d.access || {}).members || []); if (!m.some(e => String(e).toLowerCase() === was)) continue;
          d.access = { ...d.access, members: m.map(e => String(e).toLowerCase() === was ? ne : e) };
          q.upsertDoc.run('boards/' + r.id, 'boards', r.id, JSON.stringify(d), now(), user.id); boardCache.delete(r.id); }
        try { db.prepare('DELETE FROM login_known WHERE email = ?').run(was); } catch (e) {}
        summaryCache.clear(); teamCache.at = 0; console.log(`Sign-in email changed by an admin for ${target.id}`);
      }
      if (typeof b.emailFrom === 'string') {
        const ef = b.emailFrom.trim().toLowerCase();
        if (ef && !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(ef)) throw new HttpError(400, 'That isn’t an email address.');
        db.prepare('UPDATE users SET email_from = ? WHERE id = ?').run(ef || null, target.id);
      }
      if (typeof b.homeBoard === 'string') db.prepare('UPDATE users SET home_board = ? WHERE id = ?').run(b.homeBoard || null, target.id);
      if (b.password) { db.prepare('UPDATE users SET pw = ? WHERE id = ?').run(hashPassword(String(b.password)), target.id); q.deleteUserSessions.run(target.id); closeStreams(x => x.id === target.id); }
      if (typeof b.disabled === 'boolean') {
        if (target.id === user.id) throw new HttpError(400, 'You can’t turn off your own account.');
        db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, target.id);
        if (b.disabled) q.deleteUserSessions.run(target.id);
      }
      if (b.reset2fa === true) { clearTwoFactor(target.id); console.log(`Two-factor reset for ${target.email} by ${user.email}`); }
      if (Array.isArray(b.boards)) setGuestBoards(target.email, b.boards, user.id);
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
    const unread = nq.unread.get(user.id).n;
    // the person's other open sessions (their phone) clear the same badge
    broadcast({ op: 'notifs-read', user: user.id, all: !!b.all, ids: b.all ? [] : (Array.isArray(b.ids) ? b.ids : []).slice(0, 200).map(String), unread });
    return send(res, 200, { ok: true, unread });
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

  // ---- button columns: log the press and send the button.pressed webhook ----
  if (p === '/api/press' && method === 'POST') {
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not press buttons.');
    const b = await readBody(req); const bid = String(b.board || ''), iid = String(b.item || ''), col = String(b.col || '');
    const okId = x => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(x);
    if (!okId(bid) || !okId(iid) || !okId(col) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid);
    const ir = q.doc.get(`boards/${bid}/items/${iid}`); if (!ir || !itemVisible(user, info, JSON.parse(ir.data))) throw new HttpError(404, 'No such item.');
    return send(res, 200, { ok: true, ...integ.pressButton(bid, iid, col, user) });
  }

  // ---- files ----
  if (p === '/api/files' && method === 'POST') {
    // guests may attach files to their updates; viewers can't upload
    if (!canWrite(user) && user.role !== 'guest') throw new HttpError(403, 'Your account can view boards but not change them.');
    const bid = url.searchParams.get('board') || '', iid = url.searchParams.get('item') || '';
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    mustSee(user, bid);
    if (user.role === 'guest' && !iid) throw new HttpError(403, 'Guests can only attach files to an item.');
    if (iid) { const ir = /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(iid) && q.doc.get(`boards/${bid}/items/${iid}`); if (ir ? !itemVisible(user, boardInfo(bid), JSON.parse(ir.data)) : user.role === 'guest') throw new HttpError(404, 'No such item.'); }
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
    if (f.item && restricted(user, boardInfo(f.board))) { const ir = q.doc.get(`boards/${f.board}/items/${f.item}`); if (ir && !itemVisible(user, boardInfo(f.board), JSON.parse(ir.data))) throw new HttpError(404, 'That file doesn’t exist or isn’t shared with you.'); }
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
      // merged like a copy from Monday: what was added in Solver.ca stays, and Solver.ca's own boards are never touched
      for (const d of docs) {
        const { col, id } = splitDoc(d.path), prev = q.doc.get(d.path), old = prev ? JSON.parse(prev.data) : null;
        let data = d.data;
        // (a record that isn't a Monday copy, onto a board that isn't one, is written as sent)
        if (old && col === 'boards' && old.source !== 'monday') { if (data.source === 'monday') continue; }
        else if (old && col === 'boards') { data = mondayMerge.mergeBoardDoc(old, data); uploadCols.set(id, { columns: d.data.columns || [], subColumns: d.data.subColumns || [] }); }
        else if (old && /^boards\/[^/]+\/items$/.test(col)) {
          const bid = boardOfPath(col), b = q.doc.get('boards/' + bid), bd = b ? JSON.parse(b.data) : null;
          const solverBoard = bd && bd.source !== 'monday';
          if (solverBoard && data.mondayId) continue; // a Monday copy never lands on a Solver.ca board
          const known = uploadCols.get(bid);
          // the board's Monday columns; without them only the columns this record carries are replaced
          if (!solverBoard) data = { ...mondayMerge.mergeItemDoc(old, data, known ? known.columns : null, known ? known.subColumns : null), pos: old.pos != null ? old.pos : data.pos, activity: old.activity || data.activity };
        } else if (!old && col === 'boards') uploadCols.set(id, { columns: d.data.columns || [], subColumns: d.data.subColumns || [] });
        q.upsertDoc.run(d.path, col, id, JSON.stringify(data), now(), user.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (body.done) broadcast({ op: 'reload' });
    return send(res, 200, { ok: true, saved: docs.length });
  }

  // ---- home summary for one workspace ----
  if (p === '/api/summary' && method === 'GET') {
    const ws = url.searchParams.get('ws') || 'main';
    // a guest has no workspace picker: their home counts every board shared with them, whatever its workspace
    const wkey = user.role === 'guest' ? '*' : ws;
    let hit = summaryCache.get(wkey);
    if (!hit || Date.now() - hit.at > 60000) { hit = { at: Date.now(), boards: buildSummary(wkey) }; summaryCache.set(wkey, hit); }
    // boards where this person only sees items assigned to them are counted for them alone
    const mine = hit.boards.filter(x => canSee(user, x.access)).map(x => {
      const info = boardInfo(x.id); if (!restricted(user, info)) return x;
      const key = user.id + '|' + x.id, c = userSummary.get(key);
      if (c && Date.now() - c.at < 60000) return c.v;
      const r = q.doc.get('boards/' + x.id), v = r ? boardStats(x.id, JSON.parse(r.data), d => itemVisible(user, info, d)) : x;
      if (userSummary.size > 5000) userSummary.clear();
      userSummary.set(key, { at: Date.now(), v }); return v;
    });
    return send(res, 200, summaryFor(ws, mine));
  }

  // ---- export the board view (CSV or Excel) ----
  if (p === '/api/export' && (method === 'GET' || method === 'POST')) {
    const body = method === 'POST' ? await readBody(req) : {};
    const bid = String(body.board || url.searchParams.get('board') || ''), format = String(body.format || url.searchParams.get('format') || 'csv').toLowerCase();
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    mustSee(user, bid);
    if (!['csv', 'xlsx'].includes(format)) throw new HttpError(400, 'Pick csv or xlsx.');
    const r = q.doc.get('boards/' + bid), b = { id: bid, ...JSON.parse(r.data) }, info = boardInfo(bid);
    let items;
    if (Array.isArray(body.items)) items = body.items.slice(0, 50000).map(String).map(id => { const x = /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) && q.doc.get(`boards/${bid}/items/${id}`); return x ? { id, ...JSON.parse(x.data) } : null; }).filter(Boolean);
    else { const gpos = new Map((b.groups || []).map((g, i) => [g.id, i])); items = q.docsInCol.all(`boards/${bid}/items`).map(x => ({ id: x.id, ...JSON.parse(x.data) })).sort((a, c) => ((gpos.get(a.group) ?? 1e9) - (gpos.get(c.group) ?? 1e9)) || ((a.pos || 0) - (c.pos || 0))); }
    items = items.filter(it => itemVisible(user, info, it));
    const want = Array.isArray(body.columns) ? body.columns.map(String) : (url.searchParams.get('cols') ? url.searchParams.get('cols').split(',') : null);
    const cols = (want ? want.map(id => (b.columns || []).find(c => c.id === id)).filter(Boolean) : (b.columns || [])).filter(c => c.type !== 'button');
    const rows = [['Name', 'Group', ...cols.map(c => c.title)], ...items.map(it => [it.name || '', ((b.groups || []).find(g => g.id === it.group) || {}).name || '', ...cols.map(c => exportCell(b, c, it))])];
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), base = `${String(b.name || 'Board').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'Board'} ${day}`;
    const out = format === 'xlsx' ? sheets.toXlsx(rows, b.name || 'Board') : Buffer.from(sheets.toCsv(rows), 'utf8');
    res.writeHead(200, { 'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8',
      'Content-Length': out.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Row-Count': String(items.length),
      'Content-Disposition': `attachment; filename="${base.replace(/[^\x20-\x7e]/g, '_')}.${format}"; filename*=UTF-8''${encodeURIComponent(base)}.${format}` });
    return res.end(out);
  }

  // ---- import a CSV or .xlsx into a board (admins and members) ----
  if (p === '/api/import/preview' && method === 'POST') {
    if (!canWrite(user)) throw new HttpError(403, 'Only admins and members can import.');
    const bid = url.searchParams.get('board') || '';
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    mustSee(user, bid);
    let name = 'file'; try { name = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch (e) {}
    const buf = await readRaw(req, 10 * 1024 * 1024);
    let table;
    try { table = /\.xlsx$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b) ? sheets.parseXlsx(buf) : sheets.parseCsv(csvText(buf)); }
    catch (e) { throw new HttpError(400, e.message || 'That file couldn’t be read. Save it as CSV and try again.'); }
    if (table.length < 2) throw new HttpError(400, 'The file needs a header row and at least one row of data.');
    if (table.length > 5001) throw new HttpError(400, 'Import up to 5,000 rows at a time.');
    const b = JSON.parse(q.doc.get('boards/' + bid).data), locked = lockedCols(user, { ...b, id: bid });
    const headers = table[0].map(h => String(h || '').trim());
    const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const settable = (b.columns || []).filter(c => !['formula', 'button', 'item_id', 'created'].includes(c.type) && !(c.readonly && c.source !== 'file'));
    const used = new Set();
    const mapping = headers.map(h => {
      const k = key(h);
      if (!used.has('name') && ['name', 'item', 'itemname', 'lead', 'client', 'clientname', 'fullname'].includes(k)) { used.add('name'); return 'name'; }
      if (!used.has('group') && k === 'group') { used.add('group'); return 'group'; }
      const c = settable.find(x => !used.has(x.id) && !locked.has(x.id) && (key(x.title) === k || x.id === h)); if (c) { used.add(c.id); return c.id; }
      return '';
    });
    for (const [k, v] of importUploads) if (v.exp < Date.now()) importUploads.delete(k);
    const token = crypto.randomBytes(18).toString('base64url');
    importUploads.set(token, { uid: user.id, bid, rows: table.slice(1), headers, exp: Date.now() + 30 * 60 * 1000 });
    return send(res, 200, { token, name, headers, sample: table.slice(1, 6), rows: table.length - 1, mapping,
      columns: settable.map(c => ({ id: c.id, title: c.title, type: c.type, locked: locked.has(c.id) })), groups: (b.groups || []).map(g => ({ id: g.id, name: g.name })) });
  }
  if (p === '/api/import/commit' && method === 'POST') {
    if (!canWrite(user)) throw new HttpError(403, 'Only admins and members can import.');
    const body = await readBody(req), up = importUploads.get(String(body.token || ''));
    if (!up || up.uid !== user.id || up.exp < Date.now()) throw new HttpError(400, 'That upload expired. Choose the file again.');
    mustSee(user, up.bid);
    const r = q.doc.get('boards/' + up.bid); if (!r) throw new HttpError(404, 'No such board.');
    const b = { id: up.bid, ...JSON.parse(r.data) }, locked = lockedCols(user, b);
    const mapping = Array.isArray(body.mapping) ? body.mapping.map(x => String(x || '')) : [];
    const blocked = mapping.filter(m => m && locked.has(m)); if (blocked.length) throw lockError(b, new Set(blocked));
    if (!mapping.includes('name')) throw new HttpError(400, 'Pick the column that holds each item’s name.');
    const grp = body.group && (b.groups || []).some(g => g.id === body.group) ? body.group : ((b.groups || [])[0] || {}).id;
    if (!grp) throw new HttpError(400, 'Add a group to the board first.');
    importUploads.delete(String(body.token));
    const actor = { id: user.id, name: user.name, email: user.email, role: user.role };
    let created = 0; const errors = [];
    // 200 rows per transaction (one disk sync each instead of one per row), and other requests run between batches
    const addRow = (row, ri) => {
      const item = { name: '', group: grp, values: {} };
      mapping.forEach((m, ci) => {
        const v = String(row[ci] ?? '').trim(); if (!m || v === '') return;
        if (m === 'name') item.name = v;
        else if (m === 'group') { const g = (b.groups || []).find(x => x.name.toLowerCase() === v.toLowerCase() || x.id === v); if (g) item.group = g.id; }
        else { const c = (b.columns || []).find(x => x.id === m); if (!c) return; item.values[m] = c.type === 'date' && /^\d{4,5}(\.\d+)?$/.test(v) && Number(v) > 20000 && Number(v) < 80000 ? sheets.excelSerialToYmd(v) : v; }
      });
      try {
        const made = integ.createItem(b, item, actor, { quiet: true, lenient: true }); created++;
        // unknown status labels: the row is kept, that cell left empty and flagged on the item
        for (const w of made.warnings || []) if (errors.length < 25) errors.push(`Row ${ri + 2}: ${w.msg} Left empty.`);
      }
      catch (e) { if (errors.length < 25) errors.push(`Row ${ri + 2}: ${e.message}`); }
    };
    for (let k = 0; k < up.rows.length; k += 200) {
      db.exec('BEGIN');
      try { up.rows.slice(k, k + 200).forEach((row, j) => addRow(row, k + j)); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
      await new Promise(r => setImmediate(r));
    }
    summaryCache.clear();
    console.log(`Import by ${user.email} into ${b.name}: ${created} created, ${up.rows.length - created} skipped`);
    return send(res, 200, { created, skipped: up.rows.length - created, errors });
  }

  if (p === '/api/dashboards' || p.startsWith('/api/dashboards/')) return dashboardsApi(req, res, p, method, user);

  // ---- documents ----
  if (p === '/api/col' && method === 'GET') {
    const col = url.searchParams.get('path') || '';
    if (!COLLECTION_RE.test(col)) throw new HttpError(400, 'Unknown collection.');
    if (col === 'meta' && user.role === 'guest') throw new HttpError(403, 'Guests can’t open workspace settings.');
    const bid = boardOfPath(col), info = bid ? mustSee(user, bid) : null;
    if (col === 'boards') return send(res, 200, q.docsInCol.all(col).map(r => ({ id: r.id, data: JSON.parse(r.data) })).filter(r => canSee(user, r.data.access)).map(r => ({ id: r.id, data: boardForUser(user, r.data) })));
    if (!(bid && restricted(user, info))) return sendCol(res, col); // the same answer for everyone: built once (see colCache)
    let rows = q.docsInCol.all(col);
    if (bid && restricted(user, info)) rows = rows.filter(r => itemVisible(user, info, JSON.parse(r.data)));
    return sendJson(res, 200, '[' + rows.map(r => '{"id":' + JSON.stringify(r.id) + ',"data":' + r.data + '}').join(',') + ']');
  }
  if (p === '/api/doc') {
    const dp = url.searchParams.get('path') || '';
    if (!DOC_RE.test(dp)) throw new HttpError(400, 'Unknown document.');
    const { col, id } = splitDoc(dp);
    const bid = boardOfPath(dp), info = bid ? mustSee(user, bid) : null;
    const isItem = /^boards\/[^/]+\/items\/[^/]+$/.test(dp), isBoard = /^boards\/[^/]+$/.test(dp);
    if (dp.startsWith('meta/') && user.role === 'guest') throw new HttpError(403, 'Guests can’t open workspace settings.');
    const prev = q.doc.get(dp), before = prev ? JSON.parse(prev.data) : null;
    if (isItem && before && !itemVisible(user, info, before)) throw new HttpError(404, 'That item doesn’t exist or isn’t shared with you.');
    if (method === 'GET') return send(res, 200, before ? { id, exists: true, data: isBoard ? boardForUser(user, before) : before } : { id, exists: false });
    const guestEdit = user.role === 'guest' && isItem && method === 'PATCH';
    if (!canWrite(user) && !guestEdit) throw new HttpError(403, user.role === 'guest' ? 'Guests can post updates and fill in the columns the admin opened to guests.' : 'Your account can view boards but not change them.');
    if (dp.startsWith('meta/') && user.role !== 'admin') throw new HttpError(403, 'Only admins can change workspace settings.');
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      let data = body;
      if (isItem && body && typeof body.name === 'string' && body.name.length > 500) body.name = body.name.slice(0, 500); // item names are capped, like subitem names
      if (method === 'PUT') { delete body.$append; delete body.$remove; delete body.$set; } // list operations only work on PATCH
      // Only admins decide who can see a board and who can change which columns.
      if (isBoard && user.role !== 'admin') {
        // where a board comes from (the Monday copy switch, which Monday board, which workspace) is admin-only too
        for (const k of ['access', 'perms', 'source', 'mondayId', 'workspace']) {
          const was = before ? before[k] : undefined;
          if (k === 'workspace' && method === 'PUT' && !before && body.workspace && typeof body.workspace === 'object') { // a new board stays in the workspace it was made in
            data.workspace = { id: String(body.workspace.id || 'main').slice(0, 60), name: String(body.workspace.name || 'Main workspace').slice(0, 120) }; continue;
          }
          if (method === 'PATCH' && k in body && JSON.stringify(body[k]) !== JSON.stringify(was)) throw new HttpError(403, k === 'access' ? 'Only admins can change who sees a board.' : k === 'perms' ? 'Only admins can change a board’s permissions.' : 'Only admins can change where a board is copied from.');
          delete body[k];
          if (method === 'PUT' && was !== undefined) data[k] = was;
        }
        // a shared board's name is the admin's (or whoever made it) to change, like who sees it
        if (before && before.createdBy !== user.id && typeof body.name === 'string' && body.name !== before.name) {
          if (method === 'PATCH') throw new HttpError(403, 'Only an admin or the person who made this board can rename it.');
          data.name = before.name;
        }
      }
      if (isBoard && !before && method === 'PUT') data.createdBy = user.id; // who made it, so they can rename it
      else if (isBoard && method === 'PUT' && before) { if (before.createdBy) data.createdBy = before.createdBy; else delete data.createdBy; }
      else if (isBoard && method === 'PATCH') delete body.createdBy;
      if (isBoard && user.role === 'admin' && data.access) data.access = cleanAccess(data.access, method === 'PATCH' && before ? before.access : null);
      if (isBoard && method === 'PUT' && !before && !data.access) { const wa = workspaceAccess(user, data.workspace); if (wa) data.access = wa; }
      const newPerms = isBoard && user.role === 'admin' && body.perms && typeof body.perms === 'object' ? body.perms : null;
      if (method === 'PATCH') {
        if (!prev) throw new HttpError(404, 'That record no longer exists.');
        // { $append: { updates: [...], subitems: [...], activity: [...] } } adds to what's stored right now, so two
        // people posting at the same moment both keep their comment (the page never sends the whole list back)
        const add = isItem && body.$append && typeof body.$append === 'object' ? body.$append : null; delete body.$append;
        // new comments, replies and activity lines are always signed as the person sending them (no posting as someone else)
        if (add) {
          const stamp = x => (x && typeof x === 'object' ? { ...x, by: user.id, byName: user.name, at: now() } : x);
          // an update an automation posts ("post an update" rule) is signed "Automation"; guests' rules run on the server
          const autoPost = u => u && typeof u === 'object' && u.by === 'automation' && user.role !== 'guest';
          if (Array.isArray(add.updates)) add.updates = add.updates.map(u => autoPost(u) ? { at: now(), by: 'automation', byName: 'Automation', text: String(u.text || '').slice(0, 4000) }
            : ({ ...stamp(u), replies: Array.isArray(u && u.replies) ? u.replies.map(stamp) : u && u.replies }));
          // every new update gets an id, so the Monday write-back can stamp the Monday id on it (no duplicate on the next copy)
          if (Array.isArray(add.updates)) add.updates = add.updates.map(u => u && typeof u === 'object' && !u.id && !u.mid ? { ...u, id: newId('u') } : u);
          if (Array.isArray(add.activity)) add.activity = add.activity.map(a2 => a2 && a2.by === 'automation' && user.role !== 'guest' ? { ...a2, at: now() } : stamp(a2));
        }
        const rem = isItem && body.$remove && typeof body.$remove === 'object' ? body.$remove : null; delete body.$remove;
        // { $set: { subitems: [{ id, name?, values? }] } } changes just those subitems, matched by id, in what's stored now
        const put = isItem && body.$set && typeof body.$set === 'object' ? body.$set : null; delete body.$set;
        data = merge(JSON.parse(prev.data), body);
        if (add || rem || put) appendToItem(data, add || {}, rem || {}, put || {});
      }
      if (newPerms) data.perms = cleanPerms(newPerms, data); // replaced as a whole, so a lock can be removed
      if (isBoard && user.role !== 'admin' && Array.isArray(data.automations)) { checkRuleLocks(user, before, data.automations); checkRuleTargets(user, before, data.automations); }
      // locked columns can't be deleted, retyped or relabelled by someone they're locked for
      if (isBoard && user.role !== 'admin' && before && Array.isArray(data.columns)) {
        const locked = lockedCols(user, before);
        for (const c of before.columns || []) {
          if (!locked.has(c.id)) continue;
          const now2 = data.columns.find(x => x && x.id === c.id);
          if (!now2 || now2.type !== c.type || JSON.stringify(now2.labels || null) !== JSON.stringify(c.labels || null)) { const e = new HttpError(403, `“${c.title}” is locked for you, so only an admin can delete or change that column.`); e.code = 'locked'; throw e; }
        }
      }
      if (isBoard && (method === 'PUT' || 'automations' in body)) ext.checkBoard(data, before); // rules are checked on save
      let stripped = [], guestNotes = null;
      if (isItem && user.role !== 'guest' && user.role !== 'admin') guardUpdates(before, data, user);
      // a copy an automation makes ("Signed → copy to Clients"): one per lead, however often it's moved back in
      if (isItem && !before && data.copiedFrom && db.prepare("SELECT 1 FROM docs WHERE col = ? AND id != ? AND json_extract(data, '$.copiedFrom') = ?").get(col, id, String(data.copiedFrom)))
        return send(res, 200, { ok: true, already: true });
      if (isItem) {
        if (user.role === 'guest') { checkGuestEdit(before, data, user, info); guestNotes = integ.guestRules(bid, before, data, user); }
        const badUrl = netguard.badLink(before, data, ((info && info.columns) || []).filter(c => c.type === 'link').map(c => c.id));
        if (badUrl) throw new HttpError(400, 'Links must start with https:// (or be a file uploaded here).');
        const locked = lockedCols(user, info);
        if (locked.size) {
          if (before) { const bad = [...changedCols(before, data)].filter(c => locked.has(c)); if (bad.length) throw lockError(info, new Set(bad)); }
          else for (const k of Object.keys(data.values || {})) if (locked.has(baseCol(k)) && data.values[k] !== '' && data.values[k] != null) { delete data.values[k]; if (!stripped.includes(baseCol(k))) stripped.push(baseCol(k)); }
        }
      }
      if (isItem) { const m = /^boards\/([^/]+)\/items\//.exec(dp); if (m) markWasJunk(m[1], before, data); }
      const json = JSON.stringify(data);
      if (json.length > 1024 * 1024) throw new HttpError(413, 'That record is too large.');
      q.upsertDoc.run(dp, col, id, json, now(), user.id);
      { const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(dp); if (m) buzz(m[1], m[2], before, data, user.id); }
      if (col === 'boards') { boardCache.delete(id); summaryCache.clear(); }
      broadcast({ op: 'set', col, id, data, ...(isBoard ? { prevAccess: before ? before.access || null : null } : {}) });
      integ.itemChanged(dp, before, data, user.id);
      try { itemNotifications(dp, before, data, user); } catch (e) { console.error('notifications:', e.message); }
      if (isItem) ext.itemSaved(dp, before, data, user);
      if (isItem && !before && data.copiedFrom) { try { ext.newleads.noteItem(bid, id, data); } catch (e) {} } // NEW CLIENT banner
      if (guestNotes) integ.sendNotes(guestNotes.b, id, data, guestNotes.notes);
      return send(res, 200, stripped.length ? { ok: true, stripped: stripped.map(c => colTitle(info, c)) } : { ok: true });
    }
    if (method === 'DELETE') {
      // a whole board (and every item on it) goes only when an admin deletes it
      if (isBoard && user.role !== 'admin') throw new HttpError(403, 'Only admins can delete boards.');
      q.deleteDoc.run(dp);
      if (prev) integ.itemChanged(dp, before, null, user.id);
      if (isBoard) { q.deleteCol.run(dp + '/items'); boardCache.delete(id); summaryCache.clear(); }
      broadcast({ op: 'delete', col, id });
      return send(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

// ---------- home summary ----------
// Per-board numbers are cached per workspace; each person's summary adds up only the boards they can see.
const userSummary = new Map(); // 'userId|boardId' -> { at, v }: boards where someone sees only their own items
class SummaryCache extends Map { clear() { super.clear(); userSummary.clear(); } }
const summaryCache = new SummaryCache();
function boardStats(id, b, keep) {
  const day = d => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // the workspace's date, not UTC's (evenings would count today's follow-ups as overdue)
  const today = day(new Date()), weekAgo = Date.now() - 7 * 864e5, inWeek = day(new Date(Date.now() + 7 * 864e5));
  const sparkStart = new Date(Date.now() - 13 * 864e5); sparkStart.setUTCHours(0, 0, 0, 0);
  const followCols = (b.columns || []).filter(c => c.type === 'date' && /follow|next|callback|due/i.test(c.title)).map(c => c.id);
  const junkGroups = new Set((b.groups || []).filter(g => /junk|unqualif|signed|funded|closed|\blost\b|dead/i.test(g.name || '')).map(g => g.id)); // dead or already-won leads aren't follow-ups
  const x = { id, name: b.name, folder: b.folder || '', access: b.access || null, count: 0, newWeek: 0, spark: Array(14).fill(0), overdue: 0, dueToday: 0, upcoming: 0 };
  for (const it of q.docsInCol.all(`boards/${id}/items`)) {
    let d; try { d = JSON.parse(it.data); } catch (e) { continue; }
    if (keep && !keep(d)) continue;
    x.count++;
    const c = d.createdAt ? Date.parse(d.createdAt) : NaN;
    if (c >= weekAgo) x.newWeek++;
    if (c >= sparkStart.getTime()) { const k = Math.floor((c - sparkStart.getTime()) / 864e5); if (k >= 0 && k < 14) x.spark[k]++; }
    if (junkGroups.has(d.group)) continue; // Junk/Unqualified, Signed and other closed leads are never followed up
    for (const fc of followCols) {
      const v = (d.values || {})[fc]; if (!v) continue;
      if (v < today) x.overdue++; else if (v === today) x.dueToday++; else if (v <= inWeek) x.upcoming++;
      break;
    }
  }
  return x;
}
function buildSummary(ws) {
  const boards = [];
  for (const r of q.docsInCol.all('boards')) {
    let b; try { b = JSON.parse(r.data); } catch (e) { continue; }
    const w = (b.workspace && b.workspace.id) || 'main'; if (ws !== '*' && w !== ws) continue;
    boards.push(boardStats(r.id, b));
  }
  return boards;
}
function summaryFor(ws, list) {
  const spark = Array(14).fill(0), followups = { overdue: 0, dueToday: 0, upcoming: 0 }; let total = 0, newWeek = 0;
  for (const x of list) { total += x.count; newWeek += x.newWeek; x.spark.forEach((v, k) => { spark[k] += v; }); followups.overdue += x.overdue; followups.dueToday += x.dueToday; followups.upcoming += x.upcoming; }
  const boards = list.map(x => ({ id: x.id, name: x.name, count: x.count, newWeek: x.newWeek, folder: x.folder })).sort((a, b) => b.count - a.count);
  return { ws, total, newWeek, spark, boards, followups };
}
// Puts a guest's email on exactly these boards' access lists (and takes it off every other board).
// A guest only ever sees boards that list them; listing them doesn't open the board to anyone else.
function setGuestBoards(email, boardIds, by) {
  email = String(email || '').toLowerCase(); const want = new Set((boardIds || []).map(String));
  for (const r of q.docsInCol.all('boards')) {
    let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
    const members = lowerList((d.access || {}).members), has = members.includes(email), should = want.has(r.id);
    if (has === should) continue;
    const prevAccess = d.access || null;
    d.access = cleanAccess({ ...(d.access || { private: false }), members: should ? [...members, email] : members.filter(e => e !== email) });
    q.upsertDoc.run('boards/' + r.id, 'boards', r.id, JSON.stringify(d), now(), by || 'admin');
    boardCache.delete(r.id); broadcast({ op: 'set', col: 'boards', id: r.id, data: d, prevAccess });
  }
  summaryCache.clear();
}
function cleanAccess(a) {
  const members = [...new Set((Array.isArray(a.members) ? a.members : []).map(e => String(e || '').trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+$/.test(e)))].sort();
  return { private: !!a.private, members, ...(a.kind ? { kind: String(a.kind) } : {}) };
}
// A new board takes the visibility of the workspace it is made in: open if any board there (that its maker sees) is open,
// otherwise private to the people on those boards plus its maker (never a guest). A workspace with no boards stays open.
function workspaceAccess(user, ws) {
  const wid = String((ws && ws.id) || 'main'); let open = false, any = false; const members = new Set();
  for (const r of q.docsInCol.all('boards')) {
    let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
    if (String((d.workspace && d.workspace.id) || 'main') !== wid || !canSee(user, d.access)) continue;
    any = true; if (!d.access || !d.access.private) { open = true; break; }
    for (const e of d.access.members || []) members.add(String(e).toLowerCase());
  }
  if (!any || open) return null;
  const guests = new Set(db.prepare("SELECT email FROM users WHERE role = 'guest'").all().map(r => String(r.email).toLowerCase()));
  if (user.role !== 'admin' && user.email) members.add(String(user.email).toLowerCase());
  return cleanAccess({ private: true, members: [...members].filter(e => !guests.has(e)) });
}
// A member may not add (or change) an automation that sets a column locked for them: the rule would change it for them.
const RULE_SETTERS = new Set(['set_status', 'set_value', 'set_date', 'clear', 'assign']);
function checkRuleLocks(user, before, list) {
  const b = before || {}, locked = lockedCols(user, b); if (!locked.size) return;
  const old = new Map(((b.automations) || []).map(r => [r && r.id, JSON.stringify(r)]));
  // a rule that sets a locked column can't be removed by someone that column is locked for (switching it on/off is fine)
  const ids = new Set(list.map(r => r && r.id));
  for (const r of b.automations || []) {
    if (!r || ids.has(r.id)) continue;
    const hit = (Array.isArray(r.actions) ? r.actions : []).filter(a => a && RULE_SETTERS.has(a.type) && locked.has(String(a.col)));
    if (hit.length) { const e = new HttpError(403, `“${String(r.title || 'This automation').slice(0, 120)}” sets a column that is locked for you, so only an admin can delete it.`); e.code = 'locked'; throw e; }
  }
  for (const r of list) {
    if (!r || typeof r !== 'object' || old.get(r.id) === JSON.stringify(r)) continue;
    { const was = (b.automations || []).find(x => x && x.id === r.id); if (was && JSON.stringify({ ...was, on: r.on }) === JSON.stringify(r)) continue; } // only switched on/off
    const hit = (Array.isArray(r.actions) ? r.actions : []).filter(a => a && RULE_SETTERS.has(a.type) && r.trigger !== 'sub_status' && locked.has(String(a.col)));
    if (hit.length) { const e = new HttpError(403, `“${String(r.title || 'This automation').slice(0, 120)}” sets ${[...new Set(hit.map(a => '“' + colTitle(b, a.col) + '”'))].join(', ')}, which ${hit.length === 1 ? 'is' : 'are'} locked for you on this board. Only admins can add or change automations that set locked columns.`); e.code = 'locked'; throw e; }
  }
}
// Guests may post updates (as themselves) and change guest-editable columns. Nothing else on an item.
// members: an update is always signed by whoever posts it, and other people's updates (and replies) can't be
// rewritten or removed by sending back a whole list. Your own you can edit or delete.
function guardUpdates(before, data, user) {
  if (!Array.isArray(data.updates)) return;
  const js = v => JSON.stringify(v ?? null), mine = x => x && (x.by === user.id || x.by === 'automation');
  const fix = (oldList, newList) => {
    const old = new Map((oldList || []).filter(x => x && x.id).map(x => [x.id, x]));
    const out = [];
    for (const u of newList || []) {
      if (!u || typeof u !== 'object') continue;
      const was = u.id && old.get(u.id);
      if (!was) { out.push(u.by === 'automation' ? { ...u, byName: 'Automation' } : { ...u, by: user.id, byName: user.name }); continue; }
      if (mine(was)) { out.push({ ...u, by: was.by, byName: was.byName, replies: Array.isArray(u.replies) ? fix(was.replies, u.replies) : u.replies }); continue; }
      // someone else's: keep it exactly as it was, apart from new replies, likes and seen marks
      out.push({ ...u, text: was.text, by: was.by, byName: was.byName, at: was.at, ...(was.html !== undefined || u.html !== undefined ? { html: was.html } : {}), replies: fix(was.replies, Array.isArray(u.replies) ? u.replies : was.replies) });
    }
    // someone else's that went missing: put back where it was
    (oldList || []).forEach((x, i) => { if (x && x.id && !mine(x) && !out.some(o => o.id === x.id)) out.splice(Math.min(i, out.length), 0, x); });
    return out;
  };
  if (js(before && before.updates) === js(data.updates)) return;
  data.updates = fix(before ? before.updates : [], data.updates);
}
// members can't point a "copy to / move to board" rule at a board they can't see (only an admin sets those up)
function checkRuleTargets(user, before, list) {
  const old = new Set(((before && before.automations) || []).flatMap(r => (r && Array.isArray(r.actions) ? r.actions : []).filter(a => a && (a.type === 'copy_to_board' || a.type === 'move_board')).map(a => a.type + ':' + a.board)));
  for (const r of list) for (const a of (r && Array.isArray(r.actions) ? r.actions : [])) {
    if (!a || (a.type !== 'copy_to_board' && a.type !== 'move_board') || old.has(a.type + ':' + a.board)) continue;
    const t = boardInfo(String(a.board || ''));
    if (!t || !canSee(user, t.access)) throw new HttpError(403, 'Only an admin can set up an automation that sends items to a board you can’t see.');
  }
}
function checkGuestEdit(before, after, user, info) {
  if (!before) throw new HttpError(403, 'Guests can’t add items.');
  const no = msg => { const e = new HttpError(403, msg || 'Guests can post updates and fill in the columns the admin opened to guests, nothing else.'); e.code = 'locked'; return e; };
  const js = v => JSON.stringify(v ?? null);
  // values: board columns are checked against the locks below; any other key (not a column) only via a guest-editable column's own keys
  const colIds = new Set(((info && info.columns) || []).map(c => c.id)), ge = new Set(((info && info.perms) || {}).guestEdit || []);
  const bv = before.values || {}, av = (after.values && typeof after.values === 'object') ? after.values : {};
  for (const k of new Set([...Object.keys(bv), ...Object.keys(av)])) if (js(bv[k]) !== js(av[k]) && !colIds.has(baseCol(k)) && !ge.has(baseCol(k))) throw no();
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (js(before[k]) === js(after[k]) || k === 'values') continue; // values are checked against the board's guest-editable columns
    if (k === 'updates') {
      const a = (before.updates || []).map(js), n = Array.isArray(after.updates) ? after.updates : [];
      let kept = -1; // the older updates must stay as they were (the oldest may roll off past 100)
      for (let d = 0; d <= (n.length >= 100 ? a.length : 0); d++) { const keep = a.slice(d); if (keep.length <= n.length && keep.every((u, i) => u === js(n[i]))) { kept = keep.length; break; } }
      if (kept < 0) throw no('Guests can add updates but not change existing ones.');
      for (const u of n.slice(kept)) { if (!u || typeof u !== 'object') throw no(); u.by = user.id; u.byName = user.name; u.text = String(u.text || '').slice(0, 4000); delete u.replies; }
      continue;
    }
    // new activity lines: only the guest's own. Lines signed by an automation are written by the server when it runs the
    // board's rules for the guest's change (see guestRules), so any a guest's page sends are dropped, never stored.
    if (k === 'activity') {
      const old = new Set((before.activity || []).map(js)), list = Array.isArray(after.activity) ? after.activity : [];
      if (list.some(x => !old.has(js(x)) && !(x && (x.by === user.id || x.by === 'automation')))) throw no();
      after.activity = list.filter(x => old.has(js(x)) || (x && x.by === user.id)).map(x => (old.has(js(x)) ? x : { at: now(), by: user.id, text: String(x.text || '').slice(0, 300) }));
      continue;
    }
    throw no();
  }
}
// What a cell shows in an export: labels for statuses, numbers as numbers, dates as YYYY-MM-DD.
const KSFormula = require('./public/formula.js');
// formulas, TODAY() and date rules read the workspace's day (KS_TIMEZONE), on the server and in the page alike
KSFormula.setTimeZone(TIME_ZONE);
function fileNames(v) { if (Array.isArray(v)) return v.filter(f => f && f.url).map(f => f.name || f.url).join(', '); return String(v || ''); }
function refValue(b, item, id, depth) {
  if (id === 'name') return item.name || '';
  const c = KSFormula.findCol(b.columns, id); if (!c) throw new Error('Unknown column ' + id); // by column id, or by title; a missing one is an error, not 0
  id = c.id;
  const v = (item.values || {})[id];
  switch (c.type) {
    case 'formula': { const r = formulaResult(b, item, c, depth); return r.error || r.value === '' ? KSFormula.BLANK_REF : r.value; }
    case 'number': { if (v === '' || v == null) return KSFormula.EMPTY_NUMBER; const n = Number(v); return c.format === 'percent' ? n / 100 : n; }
    case 'status': return (((c.labels || []).find(l => l.id === String(v))) || {}).label || '';
    case 'checkbox': return !!v;
    // with a time: the local day people see (for DAYS etc.), and the exact instant for HOURS_DIFF
    case 'date': { const dt = (item.values || {})[id + '__dt']; return v ? KSFormula.dateRef(String(v).slice(0, 10), dt, TIME_ZONE) : ''; }
    case 'item_id': return String(item.mondayId || item.id);
    case 'created': return String(item.createdAt || '').slice(0, 10);
    default: return v == null ? '' : Array.isArray(v) ? fileNames(v) : v;
  }
}
function formulaResult(b, item, c, depth = 0) {
  try {
    const refs = [...String(c.formula || '').matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    const r = KSFormula.evaluate(c.formula, (id, d) => refValue(b, item, id, d), depth);
    const rc = refs.map(id => KSFormula.findCol(b.columns, id));
    if (!r.error && /^\s*IF\s*\(/i.test(c.formula) && refs.length && rc.every(x => x && x.type === 'number') && rc.every(x => { const v = (item.values || {})[x.id]; return v === '' || v == null; })) return { value: '' };
    return r;
  } catch (e) { return { error: e.message }; }
}
function exportCell(b, c, item) {
  const fx = features.exportCell(b, c, item); if (fx !== undefined) return fx;
  const v = (item.values || {})[c.id];
  switch (c.type) {
    case 'formula': { const r = formulaResult(b, item, c); if (r.error || r.value === '' || r.value == null) return ''; return typeof r.value === 'number' && Number.isFinite(r.value) ? Number(r.value.toPrecision(10)) : KSFormula.format(r.value); } // 311537.08333332936 -> 311537.0833
    case 'number': { if (v === '' || v == null) return ''; const n = Number(v); return Number.isFinite(n) ? n : String(v); }
    case 'status': return v == null || v === '' ? '' : (((c.labels || []).find(l => l.id === String(v))) || {}).label ?? '';
    case 'date': return v ? String(v).slice(0, 10) : '';
    case 'checkbox': return v ? 'Yes' : '';
    case 'item_id': return String(item.mondayId || item.id);
    case 'created': return String(item.createdAt || '').slice(0, 10);
    default: return v == null ? '' : Array.isArray(v) || c.type === 'file' || c.source === 'file' ? fileNames(v) : String(v);
  }
}
// Item lists changed one entry at a time on the server (PATCH { $append, $remove }), never replaced from a stale page.
// updates/subitems: added at the end; activity: added at the top (newest first, 40 kept); $remove.subitems: ids.
function appendToItem(data, add, rem, put = {}) {
  const objs = a => (Array.isArray(a) ? a.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : []);
  if (add.updates !== undefined) data.updates = [...(Array.isArray(data.updates) ? data.updates : []), ...objs(add.updates)];
  if (add.subitems !== undefined) {
    const have = new Set((Array.isArray(data.subitems) ? data.subitems : []).map(s => String(s && s.id)));
    data.subitems = [...(Array.isArray(data.subitems) ? data.subitems : []), ...objs(add.subitems).filter(s => s.id != null && !have.has(String(s.id)))];
  }
  if (rem.subitems !== undefined) { const gone = new Set((Array.isArray(rem.subitems) ? rem.subitems : []).map(String)); data.subitems = (Array.isArray(data.subitems) ? data.subitems : []).filter(s => !gone.has(String(s && s.id))); }
  if (put.subitems !== undefined) {
    const subs = Array.isArray(data.subitems) ? data.subitems : [];
    for (const x of objs(put.subitems)) {
      const k = subs.findIndex(s => s && String(s.id) === String(x.id)); if (k < 0) continue; // deleted meanwhile: nothing to change
      const next = { ...subs[k] };
      if (typeof x.name === 'string' && x.name.trim()) next.name = x.name.slice(0, 500);
      if (x.values && typeof x.values === 'object' && !Array.isArray(x.values)) { next.values = { ...(next.values || {}) }; for (const [ck, cv] of Object.entries(x.values)) if (!BAD_KEYS.has(ck)) next.values[ck] = cv; }
      subs[k] = next;
    }
    data.subitems = subs;
  }
  if (add.activity !== undefined) data.activity = [...objs(add.activity), ...(Array.isArray(data.activity) ? data.activity : [])].slice(0, 40);
}
const importUploads = new Map(); // token -> { uid, bid, rows, headers, exp }
// A CSV's text: UTF-8 (with or without BOM, or UTF-16 with BOM); a file that isn't valid UTF-8 is what Excel on Windows saves
// ("CSV (Comma delimited)"), so it is read as Windows-1252 and José stays José.
function csvText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); }
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    // too large: answer 413 right away but keep reading (and dropping) the rest, so the browser gets the message instead
    // of a reset connection; a sender that keeps going far past the limit is cut off
    req.on('data', c => { size += c.length; if (over) { if (size > limit * 4) req.destroy(); return; } if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, 'That file is too large (10 MB at most).')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
// A Monday item someone moved to another board in Solver.ca keeps its Monday id as movedFromMondayId (and drops mondayId),
// so neither the full copy nor the live pull removes it there, or copies it back onto its old board.
const movedStmt = db.prepare("SELECT 1 AS k FROM docs WHERE col LIKE 'boards/%/items' AND json_extract(data, '$.movedFromMondayId') = ? LIMIT 1");
const movedAway = id => { try { return !!movedStmt.get(String(id)); } catch (e) { return false; } };
let syncState = { running: false, msg: '', boards: 0, items: 0, startedAt: null, finishedAt: null, error: null };
const lastSync = q.doc.get('meta/monday-sync');
if (lastSync) { try { Object.assign(syncState, JSON.parse(lastSync.data), { running: false }); } catch (e) {} }
function startMondaySync(user) {
  syncState = { running: true, msg: 'Starting', boards: 0, items: 0, startedAt: now(), finishedAt: null, error: null, by: user.name };
  // monday.js merges what's stored with Monday's copy (Solver.ca columns, comments, subitems, perms, access edits,
  // automations and views stay) and skips boards that weren't copied from Monday.
  const load = dp => { const r = q.doc.get(dp); if (!r) return null; try { return JSON.parse(r.data); } catch (e) { return null; } };
  const save = (dp, col, id, data) => { q.upsertDoc.run(dp, col, id, JSON.stringify(data), now(), 'monday-sync'); };
  const removeStale = (bid, seen) => {
    const b = load('boards/' + bid); if (!b || b.source !== 'monday') return;
    for (const r of q.docsInCol.all(`boards/${bid}/items`)) {
      if (seen.has(r.id)) continue;
      let d = {}; try { d = JSON.parse(r.data); } catch (e) {}
      if (d.mondayId) q.deleteDoc.run(`boards/${bid}/items/${r.id}`);
    }
  };
  syncFromMonday({
    token: process.env.MONDAY_API_TOKEN, workspaceIds: mondayWorkspaces(), save, load, removeStale, movedAway,
    onProgress: ({ msg, boards, items }) => Object.assign(syncState, { msg, boards, items }),
  }).then(r => {
    Object.assign(syncState, { running: false, msg: 'Done', boards: r.boards, items: r.items, finishedAt: now() });
    // the live pull carries on from the moment this copy started
    savePull({ lastPullAt: syncState.startedAt, needsFullCopy: false, error: null });
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
      saveItem: (bid, iid, doc) => { const prev = q.doc.get(itemPath(bid, iid)); if (prev) markWasJunk(bid, JSON.parse(prev.data), doc); q.upsertDoc.run(itemPath(bid, iid), `boards/${bid}/items`, String(iid), JSON.stringify(doc), now(), 'monday-sync'); broadcast({ op: 'set', col: `boards/${bid}/items`, id: String(iid), data: doc }); buzz(bid, iid, prev ? JSON.parse(prev.data) : null, doc, 'monday'); if (!prev) ext.newleads.noteItem(bid, iid, doc); ext.sequences.onItem(bid, iid, prev ? JSON.parse(prev.data) : null, doc); },
      removeItem: (bid, iid) => {
        const r = q.doc.get(itemPath(bid, iid)); if (!r) return false;
        let d = {}; try { d = JSON.parse(r.data); } catch (e) {}
        if (!d.mondayId) return false; // made in Solver.ca: never removed by a pull
        q.deleteDoc.run(itemPath(bid, iid)); broadcast({ op: 'delete', col: `boards/${bid}/items`, id: String(iid) }); return true;
      },
      // Monday's groups, columns and labels (already merged with the ones added here); the rest of the board stays
      saveBoardParts: (bid, parts) => {
        const r = q.doc.get('boards/' + bid); if (!r) return;
        const d = JSON.parse(r.data); if (d.source !== 'monday') return;
        Object.assign(d, parts);
        q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(d), now(), 'monday-sync'); boardCache.delete(bid); broadcast({ op: 'set', col: 'boards', id: bid, data: d });
      },
      movedAway,
      newPos: bid => { const r = db.prepare("SELECT MIN(json_extract(data, '$.pos')) AS p FROM docs WHERE col = ?").get(`boards/${bid}/items`); return (Number(r && r.p) || 0) - 1; },
    };
    const r = await pullFromMonday({ token: process.env.MONDAY_API_TOKEN, boards, since, store });
    // more than 7 days since the last pull: Monday's log doesn't reach back that far, so say a full copy is needed
    // (it stays flagged until a full copy finishes)
    const needsFullCopy = !!r.gap || !!pullState.needsFullCopy;
    savePull({ lastPullAt: r.at, lastRunAt: now(), error: needsFullCopy ? 'The last pull from Monday was more than 7 days ago, so some changes may be missing. Run a full copy from Monday to catch up.' : null,
      needsFullCopy, saved: r.saved, removed: r.removed, checked: r.checked, boards: r.boards });
    if (r.saved || r.removed) summaryCache.clear();
  } catch (e) {
    console.error('Monday live pull failed:', e.message);
    savePull({ lastRunAt: now(), error: e.message });
  } finally { pullState.running = false; }
}

// ================= dashboards (public/views.js) =================
// Stored as docs "dashboards/<id>": { name, owner, ownerName, shared, widgets: [...] }.
// Each person sees their own dashboards and the shared ones. Only the owner (or an admin) changes or deletes one.
// A dashboard holds no item data: widgets load items through /api/col, which only returns boards the viewer can see.
function dashboardsApi(req, res, p, method, user) {
  if (user.role === 'guest') throw new HttpError(403, 'Guests can’t use dashboards.');
  const read = r => ({ id: r.id, ...JSON.parse(r.data) });
  const mineOrShared = d => d.owner === user.id || !!d.shared;
  if (p === '/api/dashboards' && method === 'GET') return send(res, 200, q.docsInCol.all('dashboards').map(read).filter(mineOrShared).sort((a, b) => String(a.name).localeCompare(String(b.name))));
  const m = /^\/api\/dashboards\/([A-Za-z0-9_-]{4,40})$/.exec(p); if (!m) throw new HttpError(404, 'Not found.');
  const dp = 'dashboards/' + m[1], row = q.doc.get(dp), cur = row ? read(row) : null;
  if (cur && !mineOrShared(cur)) throw new HttpError(404, 'That dashboard doesn’t exist or isn’t shared with you.');
  if (method === 'GET') { if (!cur) throw new HttpError(404, 'That dashboard doesn’t exist.'); return send(res, 200, cur); }
  if (cur && cur.owner !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the person who made this dashboard can change it.');
  if (method === 'DELETE') { q.deleteDoc.run(dp); return send(res, 200, { ok: true }); }
  if (method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
  return readBody(req).then(body => {
    const clip = (s, n) => String(s ?? '').slice(0, n);
    const widgets = (Array.isArray(body.widgets) ? body.widgets : []).slice(0, 40).map(w => JSON.parse(JSON.stringify(w || {})));
    const data = { name: clip(body.name, 120).trim() || 'Dashboard', owner: cur ? cur.owner : user.id, ownerName: cur ? cur.ownerName : user.name, shared: !!body.shared, widgets, updatedAt: now() };
    const json = JSON.stringify(data); if (json.length > 256 * 1024) throw new HttpError(413, 'That dashboard is too large.');
    q.upsertDoc.run(dp, 'dashboards', m[1], json, now(), user.id);
    return send(res, 200, { id: m[1], ...data });
  });
}
// ================= end dashboards =================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (features.isPublic(url)) return await features.run(() => features.handlePublic(req, res, url), url);
    if (url.pathname.startsWith('/api/')) return await features.run(() => api(req, res, url), url);
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (url.pathname === '/login') {
      // already signed in (and not owing two-factor setup): go to the app, not a second sign-in
      const u = currentUser(req);
      if (u && !u.needs2fa && !url.searchParams.has('setup')) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return serveStatic(req, res, 'login.html');
    }
    if (url.pathname === '/developers') return serveStatic(req, res, 'developers.html');
    if (url.pathname === '/' ) {
      const u = currentUser(req);
      if (!u) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      if (u.needs2fa) { res.writeHead(302, { Location: '/login?setup=1' }); return res.end(); }
      return serveStatic(req, res, 'index.html');
    }
    return serveStatic(req, res, url.pathname.replace(/^\/+/, ''));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message, ...(e.code && status !== 500 ? { code: e.code } : {}) });
  }
});

module.exports.server = server;

if (require.main === module) {
  // ADMIN_EMAIL + ADMIN_PASSWORD always give a working admin sign-in: created if missing, password reset if it exists.
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    try {
      const existing = q.userByEmail.get(email);
      if (existing) {
        if (String(password).length < 8) throw new Error('ADMIN_PASSWORD needs at least 8 characters.');
        // resets the password and admin role; two-factor stays as it is (see ADMIN_RESET_2FA below)
        db.prepare("UPDATE users SET pw = ?, role = 'admin', disabled = 0 WHERE id = ?").run(hashPassword(password), existing.id);
        console.log('Admin sign-in ready:', email + (existing.totp_on ? ' (two-factor stays on)' : ''));
      } else { createUser({ email, name: process.env.ADMIN_NAME || 'Admin', role: 'admin', password }); console.log('Created admin sign-in:', email); }
    } catch (e) { console.error('Could not set up the admin sign-in:', e.message); }
  }
  // Locked out of two-factor? ADMIN_RESET_2FA=1 clears ADMIN_EMAIL's two-factor on this start. Remove it again afterwards.
  if (/^(1|true|yes)$/i.test(String(process.env.ADMIN_RESET_2FA || ''))) {
    const u = email && q.userByEmail.get(email);
    if (!u) console.error('ADMIN_RESET_2FA is set, but ADMIN_EMAIL doesn’t match an account. Nothing was reset.');
    else if (u.role !== 'admin') console.error('ADMIN_RESET_2FA only resets an admin. Nothing was reset.');
    else { clearTwoFactor(u.id); console.warn(`ADMIN_RESET_2FA: two-factor sign-in was turned OFF for ${email}. Sign in, set it up again, and remove ADMIN_RESET_2FA from the server settings.`); }
  }
  if (!(email && password) && q.userCount.get().n === 0) {
    console.log('No accounts yet. Set ADMIN_EMAIL and ADMIN_PASSWORD, or run:  node scripts/create-user.js you@example.com "Your Name" admin "a-strong-password"');
  }
  // First start with a Monday token: fill in each board's private/open access from Monday (read-only), once.
  if (process.env.MONDAY_API_TOKEN && q.docsInCol.all('boards').some(r => { try { return !JSON.parse(r.data).access; } catch (e) { return false; } })) {
    const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'scripts', 'monday-board-access.js')], { stdio: 'inherit', env: process.env });
    child.on('exit', code => console.log('Board access from Monday:', code === 0 ? 'done' : 'failed (' + code + ')'));
  }
  server.listen(PORT, () => console.log(`Solver.ca running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
  // the write-ahead log is folded into the database and cut back to nothing every 10 minutes
  setInterval(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('checkpoint:', e.message); } }, 10 * 60 * 1000).unref();
  if (livePullOn()) {
    const mins = Math.max(1, Math.min(60, Number(process.env.MONDAY_PULL_MINUTES) || 5)), every = mins * 60 * 1000;
    setInterval(() => { runMondayPull(); }, every).unref();
    setTimeout(() => { runMondayPull(); }, 20000).unref();
    console.log(`Live pull from Monday: on, every ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
}
