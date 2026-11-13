// Solver.ca data safety and power features (server side):
//   full item history, undo, recycle bin (30 days), global search, board templates and duplicates,
//   public form pages, connected-board (relation) and mirror columns, time tracking.
// Wired into server.js with a small block; every write path (app, API, lead links, forms, Monday copy) goes
// through q.upsertDoc / q.deleteDoc, which this module wraps to record history, keep deletions and keep search current.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const BIN_DAYS = 30;
const ITEM_RE = /^boards\/([^/]+)\/items\/([^/]+)$/, BOARD_RE = /^boards\/([^/]+)$/;
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const SKIP_KEYS = new Set(['activity', 'pos', 'reminded', 'values', 'updates', 'subitems', 'name', 'group', 'createdAt', 'mondayId']);

module.exports = function features(ctx) {
  const { db, q, now, broadcast, HttpError, readBody, send, canSee, mustSee, boardInfo, boardCache, itemVisible, restricted, lockedCols, lockError,
    canWrite, integ, cleanAccess, workspaceAccess = () => null, clearSummary = () => {}, formulaText = () => '', itemNotifications = () => {}, publicDir, startIndex = true,
    clientIp = req => String(req.socket.remoteAddress || '') } = ctx;
  const als = new AsyncLocalStorage();
  const store = () => als.getStore() || {};
  const rid = p => p + crypto.randomBytes(9).toString('base64url');
  const J = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  const bad = (status, msg) => new HttpError(status, msg);
  const okId = x => ID_RE.test(String(x || ''));

  db.exec(`
    CREATE TABLE IF NOT EXISTS item_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, board TEXT NOT NULL, item TEXT, item_name TEXT,
      kind TEXT NOT NULL, col TEXT, before TEXT, after TEXT, by_id TEXT, by_name TEXT, source TEXT, undone INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS item_history_item ON item_history(board, item, id);
    CREATE INDEX IF NOT EXISTS item_history_board ON item_history(board, id);
    CREATE INDEX IF NOT EXISTS item_history_by ON item_history(by_id, id);
    CREATE INDEX IF NOT EXISTS item_history_at ON item_history(at);
    CREATE TABLE IF NOT EXISTS recycle_bin (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, board TEXT NOT NULL, board_name TEXT, item TEXT, grp TEXT, name TEXT, data TEXT NOT NULL,
      access TEXT, deleted_at TEXT NOT NULL, deleted_by TEXT, deleted_by_name TEXT, restored_at TEXT, restored_by TEXT
    );
    CREATE INDEX IF NOT EXISTS recycle_bin_at ON recycle_bin(deleted_at);
    CREATE TABLE IF NOT EXISTS board_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT, created_by_name TEXT
    );
    CREATE TABLE IF NOT EXISTS public_forms (
      id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, board TEXT NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, created_by TEXT, submissions INTEGER NOT NULL DEFAULT 0, last_at TEXT
    );
  `);
  try { db.exec('ALTER TABLE board_templates ADD COLUMN source_board TEXT'); } catch (e) { /* already there */ }
  // Search: two small contentless FTS5 indexes (they keep no copy of the text, only the index):
  //   search_tri   trigram over names and short fields (phones, emails, links, dropdowns, short text): substring matches
  //   search_words words (unicode61, prefixes of 2-3 letters) over long text and updates: word / word-start matches
  // search_items maps each index row to its item and keeps the name (for 2-letter searches and sorting).
  // The old index (search_fts + search_map, a full copy of every update, ~5x the data) is dropped once.
  let FTS = true;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts'").get()) {
    const t = Date.now();
    db.exec('DROP TABLE IF EXISTS search_fts'); db.exec('DROP TABLE IF EXISTS search_map');
    // giving the disk back (VACUUM) can take a while on a big database: it runs once the server is up, not before it listens
    setTimeout(() => {
      try { const free = db.prepare('PRAGMA freelist_count').get().freelist_count, pages = db.prepare('PRAGMA page_count').get().page_count;
        if (free > pages / 4) { const t2 = Date.now(); db.exec('VACUUM'); console.log(`Search index: replaced the old index and gave back ${Math.round(free * 4096 / 1048576)} MB of disk (${Date.now() - t2} ms; old index dropped in ${t2 - t} ms)`); } }
      catch (e) { console.error('search index vacuum:', e.message); }
    }, 20000).unref();
  }
  db.exec(`CREATE TABLE IF NOT EXISTS search_items (rowid INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, board TEXT NOT NULL, item TEXT NOT NULL, name TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS search_items_board ON search_items(board);`);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_tri USING fts5(name, fields, tokenize = 'trigram', content = '', contentless_delete = 1)`);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_words USING fts5(body, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3', content = '', contentless_delete = 1, detail = 'column')`);
  } catch (e) {
    FTS = false;
    db.exec('CREATE TABLE IF NOT EXISTS search_tri (rowid INTEGER PRIMARY KEY, name TEXT, fields TEXT); CREATE TABLE IF NOT EXISTS search_words (rowid INTEGER PRIMARY KEY, body TEXT)');
  }

  // history keeps each before/after value up to 16 KB in the row; a bigger before-value (a long note) shows its first
  // 2,000 characters there and is kept whole in item_history_big, so undo still puts all of it back
  const HIST_MAX = 16 * 1024;
  const histJson = v => { if (v === undefined) return null; const s = JSON.stringify(v); return s.length <= HIST_MAX ? s : JSON.stringify({ __truncated: s.slice(0, 2000) }); };
  db.exec('CREATE TABLE IF NOT EXISTS item_history_big (id INTEGER PRIMARY KEY, before TEXT NOT NULL)');
  const H = {
    insert: db.prepare('INSERT INTO item_history (at, board, item, item_name, kind, col, before, after, by_id, by_name, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM item_history WHERE id = ?'),
    markUndone: db.prepare('UPDATE item_history SET undone = 1 WHERE id = ?'),
    bigAdd: db.prepare('INSERT OR REPLACE INTO item_history_big (id, before) VALUES (?, ?)'),
    bigGet: db.prepare('SELECT before FROM item_history_big WHERE id = ?'),
  };
  const truncated = raw => String(raw || '').startsWith('{"__truncated"');
  // a history row's before-value, whole (from the side table when the row only kept the start of it); null: not kept
  const fullBefore = (id, raw) => { if (!truncated(raw)) return raw; const r = id ? H.bigGet.get(Number(id)) : null; return r ? r.before : null; };
  const userNames = new Map();
  function nameOfUser(id) {
    if (!userNames.has(id) || Date.now() - userNames.get(id).t > 60000) { const r = db.prepare('SELECT name FROM users WHERE id = ?').get(id); userNames.set(id, { t: Date.now(), n: r ? r.name : 'Someone' }); }
    return userNames.get(id).n;
  }
  // Who made a write, from the updated_by the write was saved with.
  function actor(by) {
    const st = store(), s = String(by || '');
    if (s === 'monday-sync') return { id: 'monday', name: 'From Monday', source: 'monday' };
    if (s.startsWith('u_')) return { id: s, name: nameOfUser(s), source: st.source || 'app' };
    if (s.startsWith('key:')) { const r = db.prepare('SELECT name FROM api_keys WHERE id = ?').get(s.slice(4)); return { id: s, name: `API key “${r ? r.name : '?'}”`, source: 'api' }; }
    if (s.startsWith('link:')) { const r = db.prepare('SELECT name FROM hooks WHERE id = ?').get(s.slice(5)); return { id: s, name: `Lead link “${r ? r.name : '?'}”`, source: 'link' }; }
    if (s.startsWith('form:')) { const r = db.prepare('SELECT data FROM public_forms WHERE id = ?').get(s.slice(5)); return { id: s, name: `Form “${r ? (J(r.data) || {}).title || 'Form' : '?'}”`, source: 'form' }; }
    if (s === 'reminder') return { id: s, name: 'Date reminder', source: 'automation' };
    if (s === 'import') return { id: s, name: 'Import', source: 'import' };
    return { id: s || 'system', name: s || 'Solver.ca', source: 'system' };
  }
  const baseKey = k => String(k).replace(/__d?t$/, '');
  const js = v => JSON.stringify(v ?? '');

  // ---------- history: diff one item write ----------
  function recordItem(bid, iid, before, after, by) {
    const a = actor(by), at = now(), st = store();
    if (st.quiet) return;
    const name = String((after || before || {}).name || '').slice(0, 200);
    const add = (kind, col, b4, af) => {
      const bj = histJson(b4), r = H.insert.run(at, bid, iid, name, kind, col, bj, histJson(af), a.id, a.name, a.source);
      if (truncated(bj)) H.bigAdd.run(Number(r.lastInsertRowid), JSON.stringify(b4));
    };
    if (!before && after) { add(st.source === 'restore' ? 'restored' : 'created', null); return; }
    if (before && !after) { add('deleted', null); return; }
    if (before.name !== after.name) add('change', '__name', before.name || '', after.name || '');
    if ((before.group || '') !== (after.group || '')) add('change', '__group', before.group || '', after.group || '');
    const x = before.values || {}, y = after.values || {}, bases = new Map();
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (js(x[k]) !== js(y[k])) { const bk = baseKey(k); if (!bases.has(bk)) bases.set(bk, []); }
    for (const bk of bases.keys()) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => baseKey(k) === bk);
      const b4 = {}, af = {}; keys.forEach(k => { b4[k] = x[k] ?? ''; af[k] = y[k] ?? ''; });
      add('change', bk, b4, af);
    }
    const seen = new Set((before.updates || []).map(u => (u && u.at) + '|' + (u && u.text)));
    for (const u of after.updates || []) if (u && !seen.has(u.at + '|' + u.text)) add('update', '__update', undefined, String(u.text || (u.files ? `${u.files.length} file(s)` : '')).slice(0, 500));
    // subitems: the ones removed are kept whole (with where they were), so undo can put them back
    const bs = Array.isArray(before.subitems) ? before.subitems : [], as = Array.isArray(after.subitems) ? after.subitems : [];
    if (js(bs) !== js(as)) {
      const ids = new Set(as.map(s => String(s && s.id)));
      const gone = bs.map((sub, index) => ({ index, sub })).filter(x => x.sub && typeof x.sub === 'object' && !ids.has(String(x.sub.id)));
      if (gone.length) add('change', '__subdel', gone, null);
      if (js(bs.filter(s => s && ids.has(String(s.id)))) !== js(as)) add('change', '__subitems', bs.length, as.length);
    }
  }
  function recordBoard(bid, before, after, by) {
    if (!before || !after || store().quiet) return;
    const a = actor(by), at = now();
    const add = (text) => H.insert.run(at, bid, null, null, 'board', '__board', null, JSON.stringify(text), a.id, a.name, a.source);
    if (before.name !== after.name) add(`Renamed the board from “${before.name}” to “${after.name}”`);
    const bc = new Map((before.columns || []).map(c => [c.id, c])), ac = new Map((after.columns || []).map(c => [c.id, c]));
    for (const [id, c] of ac) { if (!bc.has(id)) add(`Added column “${c.title}”`); else if (bc.get(id).title !== c.title) add(`Renamed column “${bc.get(id).title}” to “${c.title}”`); }
    for (const [id, c] of bc) if (!ac.has(id)) add(`Deleted column “${c.title}”`);
    const bg = new Map((before.groups || []).map(g => [g.id, g])), ag = new Map((after.groups || []).map(g => [g.id, g]));
    for (const [id, g] of ag) { if (!bg.has(id)) add(`Added group “${g.name}”`); else if (bg.get(id).name !== g.name) add(`Renamed group “${bg.get(id).name}” to “${g.name}”`); }
    for (const [id, g] of bg) if (!ag.has(id)) add(`Removed group “${g.name}”`);
  }

  // ---------- search index ----------
  const S = {
    get: db.prepare('SELECT rowid FROM search_items WHERE path = ?'),
    add: db.prepare('INSERT INTO search_items (path, board, item, name) VALUES (?, ?, ?, ?)'),
    rename: db.prepare('UPDATE search_items SET name = ? WHERE rowid = ?'),
    del: db.prepare('DELETE FROM search_items WHERE rowid = ?'),
    triAdd: db.prepare('INSERT INTO search_tri (rowid, name, fields) VALUES (?, ?, ?)'),
    triDel: db.prepare('DELETE FROM search_tri WHERE rowid = ?'),
    wordsAdd: db.prepare('INSERT INTO search_words (rowid, body) VALUES (?, ?)'),
    wordsDel: db.prepare('DELETE FROM search_words WHERE rowid = ?'),
    ofBoard: db.prepare('SELECT rowid FROM search_items WHERE board = ?'),
  };
  const TEXTY = new Set(['text', 'phone', 'email', 'link', 'dropdown']);
  const SHORT = 200; // text up to this long goes in the substring index; longer text only in the word index
  // The readable lines of an item that search looks through (also used to show where a match was found).
  function searchBody(cols, item) {
    const lines = [], v = item.values || {};
    for (const c of cols || []) {
      if (!TEXTY.has(c.type)) continue;
      const val = v[c.id]; if (val == null || val === '' || typeof val === 'object') continue;
      lines.push(`${c.title}: ${String(val).replace(/\s+/g, ' ').slice(0, 4000)}`);
      if (c.type === 'phone') { const d = String(val).replace(/\D/g, ''); if (d.length >= 3) lines.push(`\u0001${c.title}: ${d}`); }
    }
    for (const u of (item.updates || []).slice(-100)) { if (u && u.text) lines.push(`Update: ${String(u.text).replace(/\s+/g, ' ').slice(0, 2000)}`); for (const r of (u && u.replies) || []) if (r && r.text) lines.push(`Reply: ${String(r.text).replace(/\s+/g, ' ').slice(0, 1000)}`); }
    return lines;
  }
  // -> { fields: short values for the substring index, body: long text + updates for the word index }
  function searchParts(cols, item) {
    const fields = [], body = [];
    for (const l of searchBody(cols, item)) {
      if (l.startsWith('Update: ') || l.startsWith('Reply: ')) { body.push(l.slice(l.indexOf(' ') + 1)); continue; }
      const val = l.startsWith('\u0001') ? l.slice(l.indexOf(': ') + 2) : l.slice(l.indexOf(': ') + 2);
      if (val.length <= SHORT) fields.push(val); else { fields.push(val.slice(0, SHORT)); body.push(val); }
    }
    return { fields: fields.join('\n'), body: body.join('\n') };
  }
  function unindex(p) { const r = S.get.get(p); if (r) { S.triDel.run(r.rowid); S.wordsDel.run(r.rowid); S.del.run(r.rowid); } }
  function indexItem(bid, iid, item, cols) {
    const p = `boards/${bid}/items/${iid}`;
    if (!item) return unindex(p);
    const info = cols ? { columns: cols } : boardInfo(bid) || boardDoc(bid); if (!info) return;
    const name = String(item.name || '').slice(0, 500), parts = searchParts(info.columns, item);
    const r = S.get.get(p); let rowid;
    if (r) { rowid = r.rowid; S.triDel.run(rowid); S.wordsDel.run(rowid); S.rename.run(name, rowid); }
    else rowid = Number(S.add.run(p, bid, iid, name).lastInsertRowid);
    S.triAdd.run(rowid, name, parts.fields);
    if (parts.body) S.wordsAdd.run(rowid, parts.body);
  }
  function unindexBoard(bid) {
    for (const r of S.ofBoard.all(bid)) { S.triDel.run(r.rowid); S.wordsDel.run(r.rowid); }
    db.prepare('DELETE FROM search_items WHERE board = ?').run(bid);
  }
  // Indexes a board's items a few hundred at a time, each batch in one transaction, letting requests through in between.
  // Each item is read fresh when its batch runs, so a change made meanwhile is never overwritten with old data.
  const CHUNK = 250;
  function reindexBoard(bid, board, done) {
    const ids = db.prepare('SELECT id FROM docs WHERE col = ?').all(`boards/${bid}/items`).map(r => r.id), cols = board.columns || [];
    let k = 0, n = 0;
    const step = () => {
      try {
        db.exec('BEGIN');
        try {
          if (k === 0) unindexBoard(bid);
          for (const iid of ids.slice(k, k + CHUNK)) { const r = q.doc.get(`boards/${bid}/items/${iid}`); const d = r && J(r.data); if (d) { indexItem(bid, iid, d, cols); n++; } }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      } catch (e) { console.error('search index:', e.message); }
      k += CHUNK;
      if (k < ids.length) setImmediate(step); else if (done) done(n);
    };
    step();
  }
  // Builds the whole index board by board, in batches (first start: ~20k items in well under a minute, never blocking).
  function rebuildIndex(done) {
    const t = Date.now(); let n = 0;
    const boards = q.docsInCol.all('boards').map(r => r.id);
    try {
      if (FTS) { db.exec("INSERT INTO search_tri(search_tri) VALUES('delete-all')"); db.exec("INSERT INTO search_words(search_words) VALUES('delete-all')"); }
      else { db.exec('DELETE FROM search_tri'); db.exec('DELETE FROM search_words'); }
      db.exec('DELETE FROM search_items');
    } catch (e) { console.error('search index:', e.message); }
    const next = () => {
      const bid = boards.shift();
      if (!bid) { console.log(`Search index: ${n} items in ${Date.now() - t} ms${FTS ? '' : ' (no FTS5: plain search)'}`); if (done) done(n); return; }
      const b = boardDoc(bid); if (!b) return setImmediate(next);
      reindexBoard(bid, b, m => { n += m; setImmediate(next); });
    };
    next();
  }
  {
    const items = db.prepare("SELECT COUNT(*) AS n FROM docs WHERE col LIKE 'boards/%/items'").get().n, idx = db.prepare('SELECT COUNT(*) AS n FROM search_items').get().n;
    if (items !== idx && startIndex) setImmediate(() => rebuildIndex(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {} }));
  }
  const colSig = b => JSON.stringify((b.columns || []).map(c => [c.id, c.title, c.type]));

  // ---------- recycle bin: what a delete removes is kept for 30 days ----------
  const binAdd = db.prepare('INSERT INTO recycle_bin (id, kind, board, board_name, item, grp, name, data, access, deleted_at, deleted_by, deleted_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  function deleter() {
    const st = store();
    if (st.user) return { id: st.user.id, name: st.user.name };
    if (st.api) return { id: 'api', name: 'API key' };
    return { id: 'monday', name: 'From Monday' };
  }
  // A column taken off a board (its values stay on the items): kept with its place, its lock settings and the rules that
  // went with it, so the recycle bin can put it back.
  const refsCol = (r, cid) => !!r && typeof r === 'object' && (r.col === cid || r.targetCol === cid || (Array.isArray(r.conditions) && r.conditions.some(x => x && x.col === cid)) || (Array.isArray(r.actions) && r.actions.some(a => a && a.col === cid)));
  function keepColumns(bid, before, after) {
    const st = store(); if (!before || !after || st.quiet || st.source === 'restore') return;
    const now2 = new Set((after.columns || []).map(c => c && c.id)), rulesNow = new Set((after.automations || []).map(r => r && r.id));
    (before.columns || []).forEach((c, index) => {
      if (!c || !c.id || now2.has(c.id)) return;
      const rules = (before.automations || []).map((r, i) => [r, i]).filter(([r]) => r && !rulesNow.has(r.id) && refsCol(r, c.id));
      const pm = before.perms || {}, perms = { lock: (pm.locks || {})[c.id], guestEdit: (pm.guestEdit || []).includes(c.id), assignedOnly: (pm.assignedOnly || []).includes(c.id) };
      const who = deleter();
      binAdd.run(rid('t_'), 'column', bid, after.name || '', null, null, String(c.title || 'Column').slice(0, 200), JSON.stringify({ column: c, index, rules, perms }), JSON.stringify(after.access || null), now(), who.id, who.name);
    });
  }
  function keepItem(bid, iid, data) {
    const who = deleter(), info = boardInfo(bid) || {};
    binAdd.run(rid('t_'), 'item', bid, info.name || '', iid, data.group || null, String(data.name || 'Item').slice(0, 200), JSON.stringify(data), JSON.stringify(info.access || null), now(), who.id, who.name);
  }

  // ---------- wrap the two write statements every path uses ----------
  const rawUpsert = q.upsertDoc, rawDelete = q.deleteDoc;
  q.upsertDoc = {
    run(p, col, id, json, at, by) {
      const im = ITEM_RE.exec(p), bm = !im && BOARD_RE.exec(p);
      const prev = im || bm ? q.doc.get(p) : null;
      const res = rawUpsert.run(p, col, id, json, at, by);
      if (im || bm) {
        try {
          const before = prev ? J(prev.data) : null, after = J(json);
          if (im) { if (!prev || prev.data !== json) { recordItem(im[1], im[2], before, after, by); indexItem(im[1], im[2], after); } }
          else { recordBoard(bm[1], before, after, by); keepColumns(bm[1], before, after); if (before && after && colSig(before) !== colSig(after)) { boardCache.delete(bm[1]); setImmediate(() => { try { const cur = boardDoc(bm[1]); if (cur) reindexBoard(bm[1], cur); } catch (e) { console.error('search:', e.message); } }); } }
        } catch (e) { console.error('history:', e.message); }
      }
      return res;
    },
  };
  q.deleteDoc = {
    run(p) {
      const im = ITEM_RE.exec(p), bm = !im && BOARD_RE.exec(p);
      if (im || bm) {
        try {
          const r = q.doc.get(p), data = r ? J(r.data) : null;
          if (data && im && !store().noBin) {
            // moved to another board (same id saved there first): not a deletion
            const moved = db.prepare("SELECT path FROM docs WHERE id = ? AND path <> ? AND col LIKE 'boards/%/items' AND updated_at >= ?").get(im[2], p, new Date(Date.now() - 120e3).toISOString());
            if (moved) { const to = boardInfo(moved.path.split('/')[1]); H.insert.run(now(), im[1], im[2], String(data.name || ''), 'moved', null, null, JSON.stringify(to ? to.name : ''), deleter().id, deleter().name, 'app'); }
            else { keepItem(im[1], im[2], data); const who = deleter(); if (!store().quiet) H.insert.run(now(), im[1], im[2], String(data.name || '').slice(0, 200), 'deleted', null, null, null, who.id, who.name, store().user ? 'app' : store().api ? 'api' : 'monday'); }
          }
          if (data && bm) {
            const items = q.docsInCol.all(`boards/${bm[1]}/items`).map(x => [x.id, J(x.data)]).filter(x => x[1]);
            const who = deleter();
            binAdd.run(rid('t_'), 'board', bm[1], data.name || '', null, null, String(data.name || 'Board'), JSON.stringify({ board: data, items }), JSON.stringify(data.access || null), now(), who.id, who.name);
            H.insert.run(now(), bm[1], null, null, 'board', '__board', null, JSON.stringify(`Deleted the board (${items.length} items)`), who.id, who.name, 'app');
            unindexBoard(bm[1]);
          }
          if (im) unindex(p);
        } catch (e) { console.error('recycle bin:', e.message); }
      }
      return rawDelete.run(p);
    },
  };

  function purgeBin() {
    const cut = new Date(Date.now() - BIN_DAYS * 864e5).toISOString();
    const r = db.prepare('DELETE FROM recycle_bin WHERE deleted_at < ?').run(cut);
    if (r.changes) console.log(`Recycle bin: ${r.changes} entries older than ${BIN_DAYS} days removed for good`);
    return r.changes;
  }
  // Daily: item history older than 180 days, notifications older than 90 days, and expired sign-ins are removed.
  const HISTORY_DAYS = 180, NOTIFY_DAYS = 90;
  // old history goes 5,000 rows at a time, letting requests through in between (a first purge can be millions of rows)
  const HIST_BATCH = 5000;
  async function purgeHistory(cut) {
    const del = db.prepare('DELETE FROM item_history WHERE id IN (SELECT id FROM item_history WHERE at < ? LIMIT ?)');
    let n = 0;
    for (;;) { const c = del.run(cut, HIST_BATCH).changes; n += c; if (c < HIST_BATCH) break; await new Promise(r => setImmediate(r)); }
    try { db.exec('DELETE FROM item_history_big WHERE id NOT IN (SELECT id FROM item_history)'); } catch (e) {}
    return n;
  }
  async function purgeOld() {
    const ago = d => new Date(Date.now() - d * 864e5).toISOString(), out = {};
    out.history = await purgeHistory(ago(HISTORY_DAYS));
    try { out.notifications = db.prepare('DELETE FROM notifications WHERE at < ?').run(ago(NOTIFY_DAYS)).changes; } catch (e) {}
    try { out.sessions = db.prepare('DELETE FROM sessions WHERE expires < ?').run(now()).changes; } catch (e) {}
    if (out.history || out.notifications || out.sessions) console.log(`Clean-up: ${out.history || 0} history rows (>${HISTORY_DAYS} days), ${out.notifications || 0} notifications (>${NOTIFY_DAYS} days), ${out.sessions || 0} expired sign-ins removed`);
    return out;
  }
  const daily = () => { try { purgeBin(); } catch (e) { console.error('purge:', e.message); } purgeOld().catch(e => console.error('purge:', e.message)); };
  setTimeout(daily, 15000).unref();
  setInterval(daily, 24 * 3600 * 1000).unref();

  // ---------- shared helpers ----------
  const boardDoc = bid => { const r = q.doc.get('boards/' + bid); return r ? J(r.data) : null; };
  const itemDoc = (bid, iid) => { const r = q.doc.get(`boards/${bid}/items/${iid}`); return r ? J(r.data) : null; };
  function saveItem(bid, iid, data, user, source) {
    const p = `boards/${bid}/items/${iid}`, before = itemDoc(bid, iid), st = store(), was = st.source;
    st.source = source || was;
    try { q.upsertDoc.run(p, `boards/${bid}/items`, iid, JSON.stringify(data), now(), user.id); } finally { st.source = was; }
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data });
    integ.itemChanged(p, before, data, user.id);
    try { itemNotifications(p, before, data, user); } catch (e) {}
    try { if (ctx.ext) ctx.ext.itemSaved(p, before, data, user); } catch (e) { console.error('undo/restore hooks:', e.message); } // write-back to Monday, sequences
  }
  function saveBoard(bid, data, by, prevAccess) {
    q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(data), now(), by);
    boardCache.delete(bid);
    broadcast({ op: 'set', col: 'boards', id: bid, data, prevAccess: prevAccess === undefined ? null : prevAccess });
    clearSummary();
  }
  const writer = user => { if (!canWrite(user)) throw bad(403, 'Your account can view boards but not change them.'); };
  const fmtNum = n => Number(n).toLocaleString('en-CA', { maximumFractionDigits: 2 });
  const fmtDur = ms => { const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
  const timeTotal = (v, at = Date.now()) => ((v && v.sessions) || []).reduce((s, x) => s + Math.max(0, (x.end ? Date.parse(x.end) : at) - Date.parse(x.start)), 0);
  function describeValue(b, colId, v) {
    if (colId === '__name') return String(v ?? '');
    if (colId === '__group') return (((b && b.groups) || []).find(g => g.id === v) || {}).name || (v ? 'a removed group' : '');
    const c = ((b && b.columns) || []).find(x => x.id === colId);
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) return '';
    if (!c) return typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v);
    switch (c.type) {
      case 'status': return (((c.labels || []).find(l => l.id === String(v))) || {}).label || String(v);
      case 'checkbox': return v ? 'Checked' : '';
      case 'number': { const n = Number(v); if (!Number.isFinite(n)) return String(v); return c.format === 'currency' ? '$' + fmtNum(n) : c.format === 'percent' ? fmtNum(n) + '%' : fmtNum(n); }
      case 'time_tracking': { const s = (v && v.sessions) || []; return s.length ? `${fmtDur(timeTotal(v))} (${s.length} session${s.length === 1 ? '' : 's'}${s.some(x => !x.end) ? ', running' : ''})` : ''; }
      case 'board_relation': { const n = Array.isArray(v) ? v.length : 0; return n ? `${n} linked item${n === 1 ? '' : 's'}` : ''; }
    }
    if (Array.isArray(v)) return v.map(f => f && f.name ? f.name : typeof f === 'object' ? '' : String(f)).filter(Boolean).join(', ');
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
    return String(v).length > 300 ? String(v).slice(0, 298) + '…' : String(v);
  }
  // the readable value of one history before/after map ({ key: value })
  const histVal = (b, col, raw) => { const v = J(raw);
    if (col === '__subdel') return Array.isArray(v) ? v.map(x => '“' + String((x && x.sub && x.sub.name) || 'Subitem').slice(0, 120) + '”').join(', ') : ''; if (v && typeof v === 'object' && v.__truncated !== undefined) return String(v.__truncated).slice(0, 300) + '…'; if (v && typeof v === 'object' && !Array.isArray(v) && col && !col.startsWith('__')) return describeValue(b, col, v[col]); return describeValue(b, col, v); };
  const colName = (b, col) => col === '__name' ? 'Name' : col === '__group' ? 'Group' : col === '__update' ? 'Update' : col === '__subitems' || col === '__subdel' ? 'Subitems' : col === '__board' ? 'Board' : ((((b && b.columns) || []).find(c => c.id === col) || {}).title || col || '');

  // ---------- history: read ----------
  function historyRows(user, { board, item, by, col, from, to, before, limit }) {
    const info = mustSee(user, board), b = boardDoc(board) || {};
    const where = ['board = ?'], args = [board];
    if (item) { where.push('item = ?'); args.push(item); }
    if (by) { where.push('by_id = ?'); args.push(by); }
    if (col) { where.push('col = ?'); args.push(col); }
    if (from) { where.push('at >= ?'); args.push(String(from)); }
    if (to) { where.push('at <= ?'); args.push(String(to).length === 10 ? to + 'T23:59:59.999Z' : String(to)); }
    if (before) { where.push('id < ?'); args.push(Number(before)); }
    const n = Math.min(200, Math.max(1, Number(limit) || 60));
    let rows, more, cursor = null;
    if (restricted(user, info)) {
      // page through in batches, dropping rows on items this person can't see, until a page of visible rows is found
      // (or 20,000 rows were looked at: then 'Load older changes' carries on from where the scan stopped)
      const vis = new Map(), ok = r => { if (!r.item) return true; if (!vis.has(r.item)) { const d = itemDoc(board, r.item); vis.set(r.item, !!d && itemVisible(user, info, d)); } return vis.get(r.item); };
      const stmt = db.prepare(`SELECT * FROM item_history WHERE ${where.join(' AND ')} AND id < ? ORDER BY id DESC LIMIT 500`);
      rows = []; let scanned = 0, last = Number.MAX_SAFE_INTEGER, full = true;
      while (rows.length <= n && full && scanned < 20000) {
        const batch = stmt.all(...args, last); full = batch.length === 500; scanned += batch.length;
        for (const r of batch) { last = r.id; if (ok(r)) { rows.push(r); if (rows.length > n) break; } }
      }
      more = rows.length > n || (full && scanned >= 20000);
      if (rows.length <= n && more) cursor = last;
    } else rows = db.prepare(`SELECT * FROM item_history WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${n + 1}`).all(...args);
    if (more === undefined) more = rows.length > n;
    rows = rows.slice(0, n);
    const big = new Set(db.prepare('SELECT id FROM item_history_big WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(rows.filter(r => truncated(r.before)).map(r => r.id))).map(r => r.id));
    return { more, next: more ? (cursor != null ? cursor : rows[rows.length - 1].id) : null, rows: rows.map(r => ({
      id: r.id, at: r.at, item: r.item, itemName: r.item_name, kind: r.kind, col: r.col, colName: colName(b, r.col), by: r.by_id, byName: r.by_name, source: r.source, undone: !!r.undone,
      before: r.kind === 'change' ? histVal(b, r.col, r.before) : null,
      after: r.kind === 'change' ? histVal(b, r.col, r.after) : r.after ? J(r.after) : null,
      canUndo: r.kind === 'change' && !r.undone && !['__subitems'].includes(r.col) && !!r.item && (!truncated(r.before) || big.has(r.id)),
    })) };
  }

  // ---------- undo: put cells back to what they were ----------
  // changes: [{ item, col, before }] (before = the history before-map); returns how many cells changed.
  function applyReverts(user, bid, list) {
    const info = mustSee(user, bid), locked = lockedCols(user, { ...info, id: bid });
    const byItem = new Map(); for (const x of list) { if (!byItem.has(x.item)) byItem.set(x.item, []); byItem.get(x.item).push(x); }
    let cells = 0; const skipped = [];
    for (const [iid, xs] of byItem) {
      const cur = itemDoc(bid, iid); if (!cur) { skipped.push('an item that was deleted'); continue; }
      if (!itemVisible(user, info, cur)) continue;
      const next = JSON.parse(JSON.stringify(cur)); next.values = next.values || {};
      for (const x of xs) {
        const raw = fullBefore(x.id, x.before);
        if (raw === null) { skipped.push('a value too large to undo'); continue; }
        const b4 = J(raw);
        if (x.col === '__name') { if (b4) next.name = b4; }
        else if (x.col === '__subdel') { // deleted subitems go back where they were (unless they're back already)
          const subs = Array.isArray(next.subitems) ? [...next.subitems] : [], have = new Set(subs.map(s => String(s && s.id)));
          let n = 0;
          for (const g of (Array.isArray(b4) ? b4 : []).filter(g => g && g.sub && typeof g.sub === 'object').sort((p, q2) => p.index - q2.index)) if (!have.has(String(g.sub.id))) { subs.splice(Math.min(Number(g.index) || 0, subs.length), 0, g.sub); n++; }
          if (!n) continue;
          next.subitems = subs;
        }
        else if (x.col === '__group') { if (b4 && (info.groups || []).some(g => g.id === b4)) next.group = b4; else { skipped.push('a group that no longer exists'); continue; } }
        else if (x.col.startsWith('__')) continue;
        else {
          if (locked.has(x.col)) { skipped.push('“' + colName(info, x.col) + '” (locked)'); continue; }
          for (const [k, v] of Object.entries(b4 || {})) { if (v === '' || v == null) delete next.values[k]; else next.values[k] = v; }
        }
        cells++;
      }
      if (JSON.stringify(next) === JSON.stringify(cur)) continue;
      next.activity = [{ at: now(), by: user.id, text: `Undid ${xs.length === 1 ? 'a change to ' + colName(info, xs[0].col) : xs.length + ' changes'}` }, ...(cur.activity || [])].slice(0, 40);
      saveItem(bid, iid, next, user, 'undo');
    }
    return { cells, skipped: [...new Set(skipped)] };
  }

  // ---------- recycle bin: list and restore ----------
  function binVisible(user, r) {
    if (user.role === 'admin') return true;
    if (!canWrite(user)) return false;
    // the board's access comes first, even for things this person deleted (they may have been taken off the board since)
    const live = boardInfo(r.board), access = live ? live.access : J(r.access);
    if (!canSee(user, access)) return false;
    if (r.deleted_by === user.id) return r.kind !== 'item' || !live || !restricted(user, live) || itemVisible(user, live, J(r.data));
    if (r.kind === 'board') return false; // a whole board: admins and the person who deleted it
    if (r.kind === 'item' && live && restricted(user, live)) return itemVisible(user, live, J(r.data));
    if ((r.kind === 'group' || r.kind === 'column') && live && restricted(user, live)) return false;
    return true;
  }
  function restoreEntry(user, r) {
    if (r.restored_at) throw bad(409, 'That was already restored.');
    if (!binVisible(user, r) || !canWrite(user)) throw bad(404, 'That isn’t in your recycle bin.');
    if (r.kind !== 'board') mustSee(user, r.board); // the board must still be shared with them
    const st = store(); st.source = 'restore';
    let out = {};
    if (r.kind === 'item') {
      const info = boardInfo(r.board); if (!info) throw bad(409, `Its board “${r.board_name}” was deleted. Restore the board first.`);
      if (q.doc.get(`boards/${r.board}/items/${r.item}`)) throw bad(409, 'An item with the same id is already on the board.');
      // it was moved to another board and is still there: putting the old copy back would make the same lead twice
      const elsewhere = db.prepare("SELECT path FROM docs WHERE id = ? AND path <> ? AND col LIKE 'boards/%/items'").get(r.item, `boards/${r.board}/items/${r.item}`);
      if (elsewhere) { const ob = boardInfo(elsewhere.path.split('/')[1]); throw bad(409, `This item is on “${ob ? ob.name : 'another board'}” now. Move it back from there instead.`); }
      const data = J(r.data);
      if (!(info.groups || []).some(g => g.id === data.group)) data.group = ((info.groups || [])[0] || {}).id || data.group;
      saveItem(r.board, r.item, data, user, 'restore'); out = { board: r.board, item: r.item };
    } else if (r.kind === 'group') {
      const b = boardDoc(r.board); if (!b) throw bad(409, `Its board “${r.board_name}” was deleted. Restore the board first.`);
      const { group, index, items } = J(r.data);
      if (!(b.groups || []).some(g => g.id === group.id)) { const groups = [...(b.groups || [])]; groups.splice(Math.min(index ?? groups.length, groups.length), 0, group); const prev = b.access || null; b.groups = groups; saveBoard(r.board, b, user.id, prev); }
      for (const [iid, data] of items) if (!q.doc.get(`boards/${r.board}/items/${iid}`)) saveItem(r.board, iid, data, user, 'restore');
      out = { board: r.board };
    } else if (r.kind === 'column') {
      const b = boardDoc(r.board); if (!b) throw bad(409, `Its board “${r.board_name}” was deleted. Restore the board first.`);
      const { column, index, rules, perms } = J(r.data) || {};
      if (!column || !column.id) throw bad(409, 'That column can’t be restored.');
      if ((b.columns || []).some(c => c && c.id === column.id)) throw bad(409, 'That column is already on the board.');
      const prev = b.access || null, cols = [...(b.columns || [])];
      cols.splice(Math.min(Number.isFinite(index) ? index : cols.length, cols.length), 0, column); b.columns = cols;
      // the automations that were removed with it come back too (unless one with the same id is there again)
      const autos = [...(b.automations || [])], have = new Set(autos.map(x => x && x.id));
      for (const [rule, i] of Array.isArray(rules) ? rules : []) if (rule && !have.has(rule.id)) autos.splice(Math.min(Number(i) || 0, autos.length), 0, rule);
      b.automations = autos;
      if (perms) {
        const pm = { ...(b.perms || {}) };
        if (perms.lock) pm.locks = { ...(pm.locks || {}), [column.id]: perms.lock };
        if (perms.assignedOnly) pm.assignedOnly = [...new Set([...(pm.assignedOnly || []), column.id])];
        if (perms.guestEdit && user.role === 'admin') pm.guestEdit = [...new Set([...(pm.guestEdit || []), column.id])];
        b.perms = pm;
      }
      saveBoard(r.board, b, user.id, prev); out = { board: r.board };
    } else if (r.kind === 'board') {
      if (q.doc.get('boards/' + r.board)) throw bad(409, 'A board with the same id already exists.');
      const { board, items } = J(r.data); boardCache.delete(r.board);
      db.exec('BEGIN');
      try {
        st.quiet = true;
        q.upsertDoc.run('boards/' + r.board, 'boards', r.board, JSON.stringify(board), now(), user.id);
        for (const [iid, data] of items) { q.upsertDoc.run(`boards/${r.board}/items/${iid}`, `boards/${r.board}/items`, iid, JSON.stringify(data), now(), user.id); }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; } finally { st.quiet = false; }
      H.insert.run(now(), r.board, null, null, 'board', '__board', null, JSON.stringify(`Restored the board from the recycle bin (${items.length} items)`), user.id, user.name, 'restore');
      boardCache.delete(r.board); clearSummary();
      broadcast({ op: 'set', col: 'boards', id: r.board, data: board, prevAccess: null });
      out = { board: r.board };
    }
    st.source = null;
    db.prepare('UPDATE recycle_bin SET restored_at = ?, restored_by = ? WHERE id = ?').run(now(), user.id, r.id);
    return out;
  }

  // ---------- search ----------
  function search(user, text, allOf) { // allOf: a board id whose matches are all listed (Show all), not just 8
    const qs = String(text || '').trim().slice(0, 100); if (qs.length < 2) return { q: qs, boards: [], total: 0 };
    const digits = qs.replace(/\D/g, ''), ql = qs.toLowerCase();
    const ids = new Set(), phrase = x => '"' + String(x).replace(/"/g, '""') + '"';
    const add = rows => { for (const r of rows) ids.add(r.rowid); };
    // words for the word index: each word (2+ letters) as a word start, all of them required
    const words = qs.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2).slice(0, 6);
    if (FTS) {
      if (qs.length >= 3) add(db.prepare('SELECT rowid FROM search_tri WHERE search_tri MATCH ? LIMIT 3000').all(phrase(qs)));
      else { const like = '%' + qs.replace(/[\\%_]/g, c => '\\' + c) + '%'; add(db.prepare("SELECT rowid FROM search_items WHERE name LIKE ? ESCAPE '\\' LIMIT 3000").all(like)); }
      if (words.length) try { add(db.prepare('SELECT rowid FROM search_words WHERE search_words MATCH ? LIMIT 3000').all(words.map(w => phrase(w) + '*').join(' AND '))); } catch (e) { /* odd input: the substring results stand */ }
      // several words ("Taylor Tester"): each one somewhere in the name or short fields (first and last name live apart)
      const toks = qs.split(/[^\p{L}\p{N}@.+-]+/u).filter(Boolean), long = toks.filter(w => w.length >= 3).slice(0, 6);
      if (toks.length >= 2 && long.length) try { add(db.prepare('SELECT rowid FROM search_tri WHERE search_tri MATCH ? LIMIT 3000').all(long.map(phrase).join(' AND '))); } catch (e) { /* odd input */ }
      // phone numbers typed with spaces or dashes: match the digits too
      if (digits.length >= 4 && digits !== qs) add(db.prepare('SELECT rowid FROM search_tri WHERE search_tri MATCH ? LIMIT 500').all(phrase(digits)));
    } else {
      const like = '%' + qs.replace(/[\\%_]/g, c => '\\' + c) + '%';
      add(db.prepare("SELECT rowid FROM search_tri WHERE name LIKE ? ESCAPE '\\' OR fields LIKE ? ESCAPE '\\' LIMIT 3000").all(like, like));
      add(db.prepare("SELECT rowid FROM search_words WHERE body LIKE ? ESCAPE '\\' LIMIT 3000").all(like));
    }
    const rows = ids.size ? db.prepare('SELECT rowid, board, item, name FROM search_items WHERE rowid IN (SELECT value FROM json_each(?))').all(JSON.stringify([...ids].slice(0, 6000))) : [];
    const byBoard = new Map(), infos = new Map(); let total = 0;
    for (const r of rows) {
      if (!infos.has(r.board)) infos.set(r.board, boardInfo(r.board));
      const info = infos.get(r.board); if (!info || !canSee(user, info.access)) continue;
      if (restricted(user, info)) { const d = itemDoc(r.board, r.item); if (!d || !itemVisible(user, info, d)) continue; }
      const nameHit = String(r.name || '').toLowerCase().includes(ql);
      if (!byBoard.has(r.board)) byBoard.set(r.board, { id: r.board, name: info.name, count: 0, items: [] });
      const g = byBoard.get(r.board); g.count++; total++;
      g.items.push({ id: r.item, name: r.name, where: '', snip: '', nameHit });
    }
    // where the match is: worked out from the item itself, only for the items shown
    const snippet = (bid, it) => {
      const d = itemDoc(bid, it.id), info = infos.get(bid); if (!d || !info) return;
      const lines = searchBody(info.columns, d);
      let k = lines.findIndex(l => l.toLowerCase().includes(ql));
      if (k < 0 && digits.length >= 3) k = lines.findIndex(l => l.replace(/\D/g, '').includes(digits));
      if (k < 0 && words.length) k = lines.findIndex(l => { const t = l.toLowerCase(); return words.every(w => t.includes(w.toLowerCase())); });
      if (k < 0) return;
      let line = lines[k]; if (line.startsWith('\u0001')) { const t = line.slice(1).split(':')[0]; line = lines.find(l => l.startsWith(t + ':')) || line.slice(1); }
      const i = line.indexOf(': '); it.where = line.slice(0, i); const val = line.slice(i + 2);
      const hit = Math.max(val.toLowerCase().indexOf(ql), words.length ? val.toLowerCase().indexOf(words[0].toLowerCase()) : -1);
      const at = Math.max(0, hit - 40); it.snip = (at ? '…' : '') + val.slice(at, at + 120) + (val.length > at + 120 ? '…' : '');
    };
    const boards = [...byBoard.values()].map(g => { g.items.sort((a, b) => (b.nameHit - a.nameHit) || String(a.name).localeCompare(String(b.name))); g.items = g.items.slice(0, allOf && allOf === g.id ? 200 : 8); return g; })
      .sort((a, b) => b.items.filter(x => x.nameHit).length - a.items.filter(x => x.nameHit).length || b.count - a.count).slice(0, 25);
    for (const g of boards) for (const it of g.items) if (!it.nameHit) snippet(g.id, it);
    // a second line for every result: its group, its status and a phone or email (the person can open the item, so
    // they can already see these)
    const about = (bid, it) => {
      const d = itemDoc(bid, it.id), info = infos.get(bid); if (!d || !info) return;
      const v = d.values || {}, cols = info.columns || [];
      if (d.group) it.group = String(d.group); const grp = (info.groups || []).find(x => x.id === d.group); if (grp && grp.name) it.groupName = String(grp.name).slice(0, 80);
      const sc = cols.find(c => c.type === 'status' && v[c.id] !== undefined && v[c.id] !== '');
      if (sc) { const l = (sc.labels || []).find(x => String(x.id) === String(v[sc.id])); if (l && l.label && l.label !== '(blank)') { it.status = String(l.label).slice(0, 60); if (l.color) it.statusColor = String(l.color).slice(0, 20); } }
      for (const type of ['phone', 'email']) { const c = cols.find(x => x.type === type && typeof v[x.id] === 'string' && v[x.id].trim()); if (c) { it.contact = v[c.id].trim().slice(0, 80); break; } }
    };
    for (const g of boards) for (const it of g.items) about(g.id, it);
    // boards whose names match
    const boardHits = q.docsInCol.all('boards').map(r => ({ id: r.id, d: J(r.data) })).filter(x => x.d && canSee(user, x.d.access) && String(x.d.name || '').toLowerCase().includes(ql)).slice(0, 8).map(x => ({ id: x.id, name: x.d.name }));
    return { q: qs, total, boards, boardHits };
  }

  // ---------- duplicate a board, templates ----------
  const STRUCT = ['columns', 'subColumns', 'groups', 'automations', 'views', 'form'];
  function structureOf(b) { const out = {}; for (const k of STRUCT) if (b[k] !== undefined) out[k] = JSON.parse(JSON.stringify(b[k])); (out.views || []).forEach(v => { if (v.source === 'monday') v.source = 'template'; }); return out; }
  function remapSelf(data, fromId, toId) { // relation columns that pointed at the board itself point at the copy
    for (const c of data.columns || []) if (c.type === 'board_relation' && Array.isArray(c.boards)) c.boards = c.boards.map(x => x === fromId ? toId : x);
  }
  function newBoard(user, { name, workspace, structure, access, perms, folder }) {
    const id = rid('b');
    const data = { name: String(name || 'New board').slice(0, 120), order: Date.now(), workspace: workspace || { id: 'main', name: 'Main workspace' }, ...(folder ? { folder } : {}),
      source: 'solver', columns: [], groups: [], automations: [], ...structure, createdAt: now(), createdBy: user.id };
    if (!data.groups.length) data.groups = [{ id: rid('g'), name: 'Group one', color: '#3a78c2' }];
    if (access) data.access = cleanAccess(access);
    if (perms) data.perms = perms;
    return { id, data };
  }

  // A template shows a board's setup (columns, labels, automations): only people who can see the board it came from
  // get it, plus whoever saved it and admins. Templates saved before this was recorded stay with their creator and admins.
  function templateVisible(user, t) {
    if (user.role === 'admin' || t.created_by === user.id) return true;
    if (!t.source_board) return false;
    const info = boardInfo(t.source_board);
    return !!info && canSee(user, info.access);
  }

  // ---------- public forms ----------
  const formRow = db.prepare('SELECT * FROM public_forms WHERE token = ?');
  function formFields(b, f) {
    const cols = b.columns || [];
    return (f.questions || []).map(qq => {
      if (qq.col === 'name') return { key: 'name', label: qq.q || 'Name', type: 'text', required: true, help: qq.desc || '' };
      const c = cols.find(x => x.id === qq.col); if (!c) return null;
      const field = { key: c.id, label: String(qq.q || c.title).slice(0, 200), type: c.type === 'text' && c.long ? 'long' : c.type, required: !!qq.required, help: String(qq.desc || '').slice(0, 400) };
      if (c.type === 'status') field.options = (c.labels || []).filter(l => !l.hidden && l.label && l.label !== '(blank)').map(l => ({ id: l.id, label: l.label }));
      if (c.type === 'dropdown') field.options = (c.options || []).map(o => ({ id: o, label: o }));
      if (c.type === 'number') field.format = c.format || '';
      return field;
    }).filter(Boolean);
  }
  const FORM_TYPES = new Set(['text', 'long', 'phone', 'email', 'number', 'date', 'status', 'dropdown', 'checkbox', 'link']);
  function cleanForm(b, body, old) {
    const cols = b.columns || [];
    const qs = (Array.isArray(body.questions) ? body.questions : old ? old.questions : []).slice(0, 60).map(x => ({ col: String(x.col || ''), q: String(x.q || '').trim().slice(0, 200), desc: String(x.desc || '').trim().slice(0, 400), required: !!x.required }))
      .filter(x => x.col === 'name' || cols.some(c => c.id === x.col && FORM_TYPES.has(c.type === 'text' && c.long ? 'long' : c.type) && !c.readonly));
    const seen = new Set(), questions = qs.filter(x => !seen.has(x.col) && seen.add(x.col));
    const group = (b.groups || []).some(g => g.id === body.group) ? body.group : old && (b.groups || []).some(g => g.id === old.group) ? old.group : ((b.groups || [])[0] || {}).id;
    return { title: String(body.title ?? (old && old.title) ?? b.name).trim().slice(0, 120) || 'Form', desc: String(body.desc ?? (old && old.desc) ?? '').slice(0, 1000), questions, group,
      thanks: String(body.thanks ?? (old && old.thanks) ?? 'Thanks! We got your answers.').slice(0, 500) };
  }
  const formHits = new Map(); // ip -> [times]; token -> [times]
  function limited(key, max, ms) { const t = Date.now(), list = (formHits.get(key) || []).filter(x => t - x < ms); if (list.length >= max) { formHits.set(key, list); return true; } list.push(t); formHits.set(key, list); return false; }
  setInterval(() => { const t = Date.now(); for (const [k, v] of formHits) if (!v.some(x => t - x < 3600e3)) formHits.delete(k); }, 600e3).unref();
  function formAnswers(b, f, raw) {
    const fields = formFields(b, f), values = {}, errors = []; let name = '';
    const answers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const k of Object.keys(answers)) if (!fields.some(x => x.key === k)) errors.push('Unknown question.');
    for (const fl of fields) {
      let v = answers[fl.key];
      if (Array.isArray(v)) v = v.map(String).join(', ');
      if (v === undefined || v === null) v = '';
      if (typeof v === 'object') { errors.push(`${fl.label}: not a valid answer.`); continue; }
      v = typeof v === 'boolean' ? v : String(v).trim();
      const max = fl.type === 'long' ? 5000 : 500;
      if (typeof v === 'string' && v.length > max) { errors.push(`${fl.label} is too long.`); continue; }
      if (v === '' || v === false) { if (fl.required) errors.push(`${fl.label} is required.`); continue; }
      if (fl.key === 'name') { name = v; continue; }
      if (fl.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { errors.push(`${fl.label}: enter a valid email.`); continue; }
      if (fl.type === 'phone' && (String(v).replace(/\D/g, '').length < 7 || /[^0-9+().\-\s ext]/i.test(v))) { errors.push(`${fl.label}: enter a valid phone number.`); continue; }
      if (fl.type === 'number' && !Number.isFinite(Number(String(v).replace(/[$,\s%]/g, '')))) { errors.push(`${fl.label}: enter a number.`); continue; }
      if (fl.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors.push(`${fl.label}: pick a date.`); continue; }
      if ((fl.type === 'status') && !fl.options.some(o => o.id === v)) { errors.push(`${fl.label}: pick one of the choices.`); continue; }
      if (fl.type === 'dropdown') { const parts = String(v).split(',').map(x => x.trim()).filter(Boolean); if (parts.some(p => !fl.options.some(o => o.id === p))) { errors.push(`${fl.label}: pick from the choices.`); continue; } }
      if (fl.type === 'checkbox') v = v === true || v === 'true' || v === 'on' || v === '1';
      if (fl.type === 'link' && !/^https?:\/\//i.test(v)) v = 'https://' + v;
      values[fl.key] = fl.type === 'number' ? String(v).replace(/[$,\s%]/g, '') : v;
    }
    return { values, name, errors: [...new Set(errors)] };
  }

  // ---------- links (connected boards) and mirrors, computed for each viewer ----------
  function links(user, bid) {
    const info = mustSee(user, bid), b = boardDoc(bid); if (!b) return { items: {} };
    const rel = (b.columns || []).filter(c => c.type === 'board_relation'), mir = (b.columns || []).filter(c => c.type === 'mirror' && c.relation);
    if (!rel.length) return { items: {} };
    const out = {}, tCache = new Map(), iCache = new Map();
    const target = tid => { if (!tCache.has(tid)) { const ti = boardInfo(tid); tCache.set(tid, ti && canSee(user, ti.access) ? { info: ti, doc: boardDoc(tid) } : null); } return tCache.get(tid); };
    const linked = (tid, iid) => { const k = tid + '/' + iid; if (!iCache.has(k)) { const t = target(tid); let v = null; if (t && okId(iid)) { const d = itemDoc(tid, iid); if (d && itemVisible(user, t.info, d)) v = d; } iCache.set(k, v); } return iCache.get(k); };
    for (const r of q.docsInCol.all(`boards/${bid}/items`)) {
      const d = J(r.data); if (!d) continue;
      if (restricted(user, info) && !itemVisible(user, info, d)) continue;
      const row = {};
      for (const c of rel) {
        const v = (d.values || {})[c.id]; if (!Array.isArray(v) || !v.length) continue;
        const ls = [], hidden = { n: 0 };
        for (const x of v.slice(0, 50)) { const tid = String((x && x.b) || ''), iid = String((x && x.i) || ''); const it = okId(tid) ? linked(tid, iid) : null; if (it) ls.push({ b: tid, i: iid, name: String(it.name || '') }); else hidden.n++; }
        row[c.id] = { links: ls, hidden: hidden.n };
      }
      for (const m of mir) {
        const rc = row[m.relation]; if (!rc) continue;
        const vals = rc.links.map(l => { const t = target(l.b), it = linked(l.b, l.i); if (!t || !it) return ''; const tc = ((t.doc && t.doc.columns) || []).find(x => x.id === m.mirror); if (!tc) return ''; return tc.type === 'formula' ? formulaText(t.doc, tc, it) : describeValue(t.doc, tc.id, (it.values || {})[tc.id]); }).filter(Boolean);
        row[m.id] = { text: vals.join(', ') };
      }
      if (Object.keys(row).length) out[r.id] = row;
    }
    return { items: out };
  }

  // ---------- export: readable cells for the new column types ----------
  function exportCell(b, c, item) {
    if (c.type === 'time_tracking') { const v = (item.values || {})[c.id]; return v && v.sessions && v.sessions.length ? Math.round(timeTotal(v) / 60000) / 60 : ''; }
    if (c.type === 'board_relation' || c.type === 'mirror') return ''; // depends on who looks; not exported
    return undefined;
  }

  // ---------- routes (signed in) ----------
  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method, sp = url.searchParams;
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
    if (p === '/api/x/search' && method === 'GET') return send(res, 200, search(user, sp.get('q'), sp.get('all') || ''));

    if (p === '/api/x/history' && method === 'GET') {
      const board = sp.get('board') || ''; if (!okId(board)) throw bad(400, 'Pick a board.');
      if (!boardInfo(board)) throw bad(404, 'No such board.');
      return send(res, 200, historyRows(user, { board, item: sp.get('item') || '', by: sp.get('by') || '', col: sp.get('col') || '', from: sp.get('from') || '', to: sp.get('to') || '', before: sp.get('before') || '', limit: sp.get('limit') }));
    }
    if (p === '/api/x/history/facets' && method === 'GET') {
      const board = sp.get('board') || ''; if (!okId(board) || !boardInfo(board)) throw bad(404, 'No such board.');
      const fInfo = mustSee(user, board), b = boardDoc(board) || {};
      let people;
      if (restricted(user, fInfo)) { // only people with changes on items this person can see
        const vis = new Map(), tot = new Map();
        for (const r of db.prepare('SELECT by_id AS id, MAX(by_name) AS name, item, COUNT(*) AS n FROM item_history WHERE board = ? GROUP BY by_id, item').all(board)) {
          if (r.item) { if (!vis.has(r.item)) { const d = itemDoc(board, r.item); vis.set(r.item, !!d && itemVisible(user, fInfo, d)); } if (!vis.get(r.item)) continue; }
          const t = tot.get(r.id) || { id: r.id, name: r.name, n: 0 }; t.n += r.n; tot.set(r.id, t);
        }
        people = [...tot.values()].sort((x, y) => y.n - x.n).slice(0, 100);
      } else people = db.prepare('SELECT by_id AS id, MAX(by_name) AS name, COUNT(*) AS n FROM item_history WHERE board = ? GROUP BY by_id ORDER BY n DESC LIMIT 100').all(board);
      const cols = db.prepare('SELECT col, COUNT(*) AS n FROM item_history WHERE board = ? AND col IS NOT NULL GROUP BY col ORDER BY n DESC LIMIT 200').all(board).map(r => ({ id: r.col, name: colName(b, r.col), n: r.n }));
      return send(res, 200, { people, cols });
    }
    if (p === '/api/x/history/revert' && method === 'POST') {
      writer(user);
      const r = H.byId.get(Number(body.id)); if (!r || r.kind !== 'change' || !r.item) throw bad(404, 'That change can’t be undone.');
      mustSee(user, r.board);
      const out = applyReverts(user, r.board, [{ id: r.id, item: r.item, col: r.col, before: r.before }]);
      if (out.cells) H.markUndone.run(r.id);
      return send(res, 200, out);
    }
    if (p === '/api/x/undo' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''); if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      mustSee(user, bid);
      // since: a time, or withinMs: "my changes in the last N ms" (measured on the server, so the browser's clock doesn't matter)
      const since = body.withinMs ? new Date(Date.now() - Math.min(3600e3, Number(body.withinMs) || 0)).toISOString() : String(body.since || ''); if (!since) throw bad(400, 'Say since when.');
      const items = Array.isArray(body.items) ? new Set(body.items.map(String)) : null, cols = Array.isArray(body.cols) ? new Set(body.cols.map(String)) : null;
      const rows = db.prepare("SELECT * FROM item_history WHERE board = ? AND by_id = ? AND at >= ? AND kind = 'change' AND undone = 0 ORDER BY id ASC").all(bid, user.id, since)
        .filter(r => r.item && (!items || items.has(r.item)) && (!cols || cols.has(r.col)) && !['__subitems'].includes(r.col));
      const first = new Map(); for (const r of rows) { const k = r.item + '|' + r.col; if (!first.has(k)) first.set(k, r); }
      const out = applyReverts(user, bid, [...first.values()].map(r => ({ id: r.id, item: r.item, col: r.col, before: r.before })));
      for (const r of rows) H.markUndone.run(r.id);
      return send(res, 200, out);
    }
    if (p === '/api/x/undo-last' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''); if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      mustSee(user, bid);
      const since = new Date(Date.now() - 3600e3).toISOString();
      const r = db.prepare("SELECT * FROM item_history WHERE board = ? AND by_id = ? AND at >= ? AND kind = 'change' AND undone = 0 AND source <> 'undo' AND col NOT IN ('__subitems') ORDER BY id DESC LIMIT 1").get(bid, user.id, since);
      // the last thing they did was deleting an item (or several in one go): put it back from the recycle bin rather than reverting an older edit
      const del = db.prepare("SELECT * FROM item_history WHERE board = ? AND by_id = ? AND at >= ? AND kind = 'deleted' AND undone = 0 AND item IS NOT NULL AND NOT EXISTS (SELECT 1 FROM docs WHERE docs.path = 'boards/' || item_history.board || '/items/' || item_history.item) ORDER BY id DESC LIMIT 1").get(bid, user.id, since);
      if (del && (!r || del.id > r.id)) {
        const dels = db.prepare("SELECT * FROM item_history WHERE board = ? AND by_id = ? AND at = ? AND kind = 'deleted' AND undone = 0 AND item IS NOT NULL AND NOT EXISTS (SELECT 1 FROM docs WHERE docs.path = 'boards/' || item_history.board || '/items/' || item_history.item)").all(bid, user.id, del.at);
        let cells = 0; const skipped = [];
        for (const x of dels) {
          H.markUndone.run(x.id);
          const e = db.prepare('SELECT * FROM recycle_bin WHERE kind = ? AND board = ? AND item = ? AND deleted_by = ? AND restored_at IS NULL AND deleted_at >= ? ORDER BY deleted_at DESC LIMIT 1').get('item', bid, x.item, user.id, since);
          if (!e) {
            // deleted with its whole group: the group comes back (once)
            const g = db.prepare('SELECT * FROM recycle_bin WHERE kind = ? AND board = ? AND deleted_by = ? AND restored_at IS NULL AND deleted_at >= ? ORDER BY deleted_at DESC LIMIT 1').get('group', bid, user.id, since);
            if (g && ((J(g.data) || {}).items || []).some(it => it && it[0] === x.item)) { try { restoreEntry(user, g); cells++; } catch (err) { skipped.push(err.message); } }
            else if (!cells) skipped.push(`“${x.item_name}” isn’t in the recycle bin any more`);
            continue;
          }
          try { restoreEntry(user, e); cells++; } catch (err) { skipped.push(err.message); }
        }
        return send(res, 200, { cells, skipped, what: dels.length > 1 ? `the delete of ${dels.length} items` : `the delete of “${del.item_name}”` });
      }
      if (!r) return send(res, 200, { cells: 0, none: true });
      // everything that same save changed (an automation may have set more cells), undone together
      const same = db.prepare("SELECT * FROM item_history WHERE board = ? AND item = ? AND at = ? AND by_id = ? AND kind = 'change' AND undone = 0").all(bid, r.item, r.at, user.id);
      const out = applyReverts(user, bid, same.map(x => ({ id: x.id, item: x.item, col: x.col, before: x.before })));
      same.forEach(x => H.markUndone.run(x.id));
      const b = boardInfo(bid);
      return send(res, 200, { ...out, what: `${colName(b, r.col)} on “${r.item_name}”` });
    }

    if (p === '/api/x/bin' && method === 'GET') {
      if (!canWrite(user)) return send(res, 200, { items: [] });
      const rows = db.prepare('SELECT id, kind, board, board_name, item, grp, name, access, data, deleted_at, deleted_by, deleted_by_name FROM recycle_bin WHERE restored_at IS NULL ORDER BY deleted_at DESC LIMIT 2000').all();
      const items = rows.filter(r => binVisible(user, r)).slice(0, 500).map(r => {
        const d = r.kind === 'item' ? null : J(r.data);
        return { id: r.id, kind: r.kind, board: r.board, boardName: r.board_name, item: r.item, name: r.name, at: r.deleted_at, by: r.deleted_by_name, mine: r.deleted_by === user.id,
          count: r.kind === 'board' ? (d.items || []).length : r.kind === 'group' ? (d.items || []).length : undefined, boardGone: !boardInfo(r.board), expires: new Date(Date.parse(r.deleted_at) + BIN_DAYS * 864e5).toISOString() };
      });
      return send(res, 200, { items, days: BIN_DAYS });
    }
    if (p === '/api/x/bin/restore' && method === 'POST') {
      writer(user);
      if (body.id) { const r = db.prepare('SELECT * FROM recycle_bin WHERE id = ?').get(String(body.id)); if (!r) throw bad(404, 'That isn’t in the recycle bin any more.'); return send(res, 200, restoreEntry(user, r)); }
      // "Undo" right after a delete: this person's latest entries for these items
      const paths = (Array.isArray(body.paths) ? body.paths : []).slice(0, 2000).map(String), done = [];
      const since = new Date(Date.now() - 3600e3).toISOString();
      for (const pth of paths) {
        const m = ITEM_RE.exec(pth); if (!m) continue;
        const r = db.prepare('SELECT * FROM recycle_bin WHERE kind = ? AND board = ? AND item = ? AND deleted_by = ? AND restored_at IS NULL AND deleted_at >= ? ORDER BY deleted_at DESC LIMIT 1').get('item', m[1], m[2], user.id, since);
        if (r) { try { restoreEntry(user, r); done.push(pth); } catch (e) { /* already back, or its board is gone */ } }
      }
      return send(res, 200, { restored: done.length });
    }
    if (p === '/api/x/bin/forget' && method === 'POST') {
      if (user.role !== 'admin') throw bad(403, 'Only admins can empty the recycle bin.');
      const r = db.prepare('DELETE FROM recycle_bin WHERE id = ? AND restored_at IS NULL').run(String(body.id || ''));
      return send(res, 200, { removed: r.changes });
    }

    if (p === '/api/x/group/delete' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''), gid = String(body.group || '');
      if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      const info = mustSee(user, bid);
      if (restricted(user, info)) throw bad(403, 'You only see some items on this board, so you can’t delete a whole group.');
      const b = boardDoc(bid), index = (b.groups || []).findIndex(g => g.id === gid); if (index < 0) throw bad(404, 'That group is already gone.');
      const group = b.groups[index], items = q.docsInCol.all(`boards/${bid}/items`).map(r => [r.id, J(r.data)]).filter(x => x[1] && x[1].group === gid);
      const st = store(); st.noBin = true; const binId = rid('t_');
      try {
        db.exec('BEGIN');
        binAdd.run(binId, 'group', bid, b.name || '', null, gid, String(group.name || 'Group'), JSON.stringify({ group, index, items }), JSON.stringify(b.access || null), now(), user.id, user.name);
        for (const [iid, d] of items) { recordItem(bid, iid, d, null, user.id); q.deleteDoc.run(`boards/${bid}/items/${iid}`); }
        const prev = b.access || null; b.groups = b.groups.filter(g => g.id !== gid);
        q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(b), now(), user.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; } finally { st.noBin = false; }
      boardCache.delete(bid); clearSummary();
      for (const [iid, d] of items) { broadcast({ op: 'delete', col: `boards/${bid}/items`, id: iid }); integ.itemChanged(`boards/${bid}/items/${iid}`, d, null, user.id); }
      broadcast({ op: 'set', col: 'boards', id: bid, data: b, prevAccess: b.access || null });
      return send(res, 200, { ok: true, items: items.length, bin: binId });
    }

    // An automation moves an item to another board. The page works out the moved item (its values mapped to the new
    // board's columns, the new board's rules applied); the server saves it there and takes it off the old board in one go:
    // the old copy, with every value (also those the new board has no column for), goes to the recycle bin and the old
    // board's history, and the item's docs and uploaded files go along to the new board.
    if (p === '/api/x/item/move' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''), iid = String(body.item || ''), tid = String(body.to || '');
      if (!okId(bid) || !okId(iid) || !okId(tid) || !boardInfo(bid) || !boardInfo(tid)) throw bad(404, 'No such board.');
      if (bid === tid) throw bad(400, 'That item is already on this board.');
      const info = mustSee(user, bid), tinfo = mustSee(user, tid), tb = boardDoc(tid) || {};
      const src = itemDoc(bid, iid); if (!src || !itemVisible(user, info, src)) throw bad(404, 'That item isn’t on the board any more.');
      if (itemDoc(tid, iid)) throw bad(409, 'An item with the same id is already on that board.');
      const d = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : null; if (!d) throw bad(400, 'Send the moved item.');
      const BADK = new Set(['__proto__', 'constructor', 'prototype']), values = {}, stripped = [];
      for (const [k, v] of Object.entries(d.values && typeof d.values === 'object' && !Array.isArray(d.values) ? d.values : {})) if (!BADK.has(k)) values[k] = v;
      const locked = lockedCols(user, { ...tinfo, id: tid });
      for (const k of Object.keys(values)) if (locked.has(baseKey(k)) && values[k] !== '' && values[k] != null) { delete values[k]; if (!stripped.includes(baseKey(k))) stripped.push(baseKey(k)); }
      // comments, subitems and the rest come from what's stored now, not from the page's copy
      const next = { ...src, name: String(d.name || src.name || 'Item').slice(0, 500), values, pos: Number.isFinite(Number(d.pos)) ? Number(d.pos) : Date.now(),
        group: (tb.groups || []).some(g => g.id === d.group) ? d.group : ((tb.groups || [])[0] || {}).id,
        activity: Array.isArray(d.activity) ? d.activity.filter(x => x && typeof x === 'object').slice(0, 40).map(x => ({ at: String(x.at || now()), by: x.by === 'automation' ? 'automation' : user.id, text: String(x.text || '').slice(0, 300) })) : (src.activity || []) };
      delete next.id; delete next.reminded;
      // a Monday item moved here isn't Monday's copy any more: the Monday copy and pull leave it alone (see movedAway)
      if (src.mondayId != null && src.mondayId !== '') { next.movedFromMondayId = String(src.mondayId); delete next.mondayId; }
      const dst = `boards/${tid}/items/${iid}`, from = `boards/${bid}/items/${iid}`, st = store(), was = st.source, binId = rid('t_');
      db.exec('BEGIN');
      try {
        st.source = 'move';
        q.upsertDoc.run(dst, `boards/${tid}/items`, iid, JSON.stringify(next), now(), user.id);
        binAdd.run(binId, 'item', bid, info.name || '', iid, src.group || null, `${String(src.name || 'Item').slice(0, 150)} (moved to “${String(tinfo.name || '').slice(0, 40)}”)`, JSON.stringify(src), JSON.stringify(info.access || null), now(), user.id, user.name);
        { const bj = histJson(src), r = H.insert.run(now(), bid, iid, String(src.name || '').slice(0, 200), 'moved', '__item', bj, JSON.stringify(tinfo.name || ''), user.id, user.name, 'app'); if (truncated(bj)) H.bigAdd.run(Number(r.lastInsertRowid), JSON.stringify(src)); }
        st.noBin = true; q.deleteDoc.run(from);
        // docs written in the item: a doc column of the same id, else of the same name, on the new board (else the same id, kept)
        try {
          const scols = info.columns || [], tcols = (tb.columns || []).filter(c => c.type === 'doc' || c.source === 'doc' || c.source === 'direct_doc');
          for (const row of db.prepare('SELECT DISTINCT col FROM item_docs WHERE board = ? AND item = ? UNION SELECT DISTINCT col FROM item_doc_versions WHERE board = ? AND item = ?').all(bid, iid, bid, iid)) {
            const sc = scols.find(c => c.id === row.col), tc = tcols.find(c => c.id === row.col) || (sc && tcols.find(c => String(c.title).toLowerCase() === String(sc.title).toLowerCase()));
            const to = row.col === '_notes' ? '_notes' : tc ? tc.id : row.col;
            db.prepare('UPDATE OR IGNORE item_docs SET board = ?, col = ? WHERE board = ? AND item = ? AND col = ?').run(tid, to, bid, iid, row.col);
            db.prepare('UPDATE item_doc_versions SET board = ?, col = ? WHERE board = ? AND item = ? AND col = ?').run(tid, to, bid, iid, row.col);
          }
        } catch (e) { if (!/no such table/.test(e.message)) throw e; }
        db.prepare('UPDATE files SET board = ? WHERE board = ? AND item = ?').run(tid, bid, iid);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } finally { st.noBin = false; st.source = was; }
      clearSummary();
      broadcast({ op: 'delete', col: `boards/${bid}/items`, id: iid });
      broadcast({ op: 'set', col: `boards/${tid}/items`, id: iid, data: next });
      integ.itemChanged(from, src, null, user.id); integ.itemChanged(dst, null, next, user.id);
      return send(res, 200, { ok: true, id: iid, data: next, stripped, bin: binId });
    }

    if (p === '/api/x/board/duplicate' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''); if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      const info = mustSee(user, bid), b = boardDoc(bid);
      const withItems = !!body.withItems;
      if (withItems && restricted(user, info)) throw bad(403, 'You only see some items on this board, so it can only be copied without items.');
      // same visibility as the original, except guests: a guest is never added to a board by someone copying one
      const guests = new Set(db.prepare("SELECT email FROM users WHERE role = 'guest'").all().map(r => String(r.email).toLowerCase()));
      const access = b.access ? { ...b.access, members: (b.access.members || []).filter(e => !guests.has(String(e).toLowerCase())) } : null;
      const nb = newBoard(user, { name: String(body.name || '').trim() || `${b.name} (copy)`, workspace: b.workspace, folder: b.folder, structure: structureOf(b), access, perms: b.perms || null });
      remapSelf(nb.data, bid, nb.id);
      let n = 0;
      db.exec('BEGIN');
      try {
        q.upsertDoc.run('boards/' + nb.id, 'boards', nb.id, JSON.stringify(nb.data), now(), user.id);
        // in the order the board shows them (by pos, then as listed), and numbered so the copy keeps that order
        if (withItems) for (const [i, d] of q.docsInCol.all(`boards/${bid}/items`).map(r => J(r.data)).filter(Boolean).sort((a, c) => (Number(a.pos) || 0) - (Number(c.pos) || 0)).entries()) {
          const { mondayId, reminded, ...rest } = d;
          rest.pos = i + 1;
          const iid = rid('i'); rest.activity = [{ at: now(), by: user.id, text: `Copied from “${b.name}”` }]; rest.createdAt = now();
          for (const c of nb.data.columns || []) if (c.type === 'time_tracking' && rest.values && rest.values[c.id]) rest.values[c.id] = { sessions: (rest.values[c.id].sessions || []).filter(s => s.end) };
          q.upsertDoc.run(`boards/${nb.id}/items/${iid}`, `boards/${nb.id}/items`, iid, JSON.stringify(rest), now(), user.id); n++;
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      boardCache.delete(nb.id); clearSummary();
      broadcast({ op: 'set', col: 'boards', id: nb.id, data: nb.data, prevAccess: null });
      return send(res, 201, { id: nb.id, name: nb.data.name, items: n });
    }
    if (p === '/api/x/templates' && method === 'GET') {
      if (!canWrite(user)) return send(res, 200, []);
      return send(res, 200, db.prepare('SELECT id, name, data, created_at, created_by, created_by_name, source_board FROM board_templates ORDER BY name').all().filter(t => templateVisible(user, t)).map(t => { const d = J(t.data) || {}; return { id: t.id, name: t.name, at: t.created_at, by: t.created_by_name, mine: t.created_by === user.id, columns: (d.columns || []).length, groups: (d.groups || []).length, automations: (d.automations || []).length, views: (d.views || []).length }; }));
    }
    if (p === '/api/x/templates' && method === 'POST') {
      writer(user);
      const bid = String(body.board || ''); if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      mustSee(user, bid); const b = boardDoc(bid);
      const name = String(body.name || b.name).trim().slice(0, 120) || b.name;
      const id = rid('tp_');
      db.prepare('INSERT INTO board_templates (id, name, data, created_at, created_by, created_by_name, source_board) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, JSON.stringify(structureOf(b)), now(), user.id, user.name, bid);
      return send(res, 201, { id, name });
    }
    if (p === '/api/x/templates/use' && method === 'POST') {
      writer(user);
      const t = db.prepare('SELECT * FROM board_templates WHERE id = ?').get(String(body.id || '')); if (!t || !templateVisible(user, t)) throw bad(404, 'That template no longer exists.');
      const ws = body.workspace && typeof body.workspace === 'object' ? { id: String(body.workspace.id || 'main').slice(0, 60), name: String(body.workspace.name || 'Main workspace').slice(0, 120) } : undefined;
      const nb = newBoard(user, { name: String(body.name || '').trim() || t.name, workspace: ws, structure: J(t.data) || {}, access: workspaceAccess(user, ws) });
      for (const c of nb.data.columns || []) if (c.type === 'board_relation' && (c.boards || []).some(x => !boardInfo(x))) c.boards = c.boards.filter(x => boardInfo(x));
      saveBoard(nb.id, nb.data, user.id, null);
      return send(res, 201, { id: nb.id, name: nb.data.name });
    }
    const tm = /^\/api\/x\/templates\/(tp_[A-Za-z0-9_-]+)$/.exec(p);
    if (tm && method === 'DELETE') {
      const t = db.prepare('SELECT * FROM board_templates WHERE id = ?').get(tm[1]); if (!t) throw bad(404, 'That template no longer exists.');
      if (user.role !== 'admin' && t.created_by !== user.id) throw bad(403, 'Only admins and the person who saved it can delete a template.');
      db.prepare('DELETE FROM board_templates WHERE id = ?').run(tm[1]);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/x/forms' && method === 'GET') {
      const bid = sp.get('board') || ''; if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      mustSee(user, bid); if (user.role !== 'admin') throw bad(403, 'Only admins manage forms.');
      return send(res, 200, db.prepare('SELECT * FROM public_forms WHERE board = ? ORDER BY created_at').all(bid).map(f => ({ id: f.id, token: f.token, active: !!f.active, submissions: f.submissions, lastAt: f.last_at, ...J(f.data) })));
    }
    if (p === '/api/x/forms' && method === 'POST') {
      if (user.role !== 'admin') throw bad(403, 'Only admins create forms.');
      const bid = String(body.board || ''); if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      const b = boardDoc(bid);
      let base = body;
      if (body.fromMonday && b.form) base = { title: b.form.title, questions: [{ col: 'name', q: 'Your name', required: true }, ...(b.form.questions || [])], ...body };
      const data = cleanForm(b, base, null);
      if (!data.questions.some(x => x.col === 'name')) data.questions.unshift({ col: 'name', q: 'Your name', desc: '', required: true });
      const id = rid('fm_'), token = crypto.randomBytes(18).toString('base64url');
      db.prepare('INSERT INTO public_forms (id, token, board, data, active, created_at, created_by) VALUES (?, ?, ?, ?, 1, ?, ?)').run(id, token, bid, JSON.stringify(data), now(), user.id);
      return send(res, 201, { id, token, active: true, ...data });
    }
    const fm = /^\/api\/x\/forms\/(fm_[A-Za-z0-9_-]+)$/.exec(p);
    if (fm) {
      if (user.role !== 'admin') throw bad(403, 'Only admins manage forms.');
      const f = db.prepare('SELECT * FROM public_forms WHERE id = ?').get(fm[1]); if (!f) throw bad(404, 'That form no longer exists.');
      if (method === 'DELETE') { db.prepare('DELETE FROM public_forms WHERE id = ?').run(f.id); return send(res, 200, { ok: true }); }
      if (method === 'PATCH') {
        const b = boardDoc(f.board); if (!b) throw bad(404, 'The form’s board was deleted.');
        const data = cleanForm(b, body, J(f.data));
        if (!data.questions.some(x => x.col === 'name')) data.questions.unshift({ col: 'name', q: 'Your name', desc: '', required: true });
        db.prepare('UPDATE public_forms SET data = ?, active = ? WHERE id = ?').run(JSON.stringify(data), typeof body.active === 'boolean' ? (body.active ? 1 : 0) : f.active, f.id);
        return send(res, 200, { id: f.id, token: f.token, active: typeof body.active === 'boolean' ? body.active : !!f.active, ...data });
      }
    }

    if (p === '/api/x/time' && method === 'POST') {
      const bid = String(body.board || ''), iid = String(body.item || ''), cid = String(body.col || '');
      if (!okId(bid) || !okId(iid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      const info = mustSee(user, bid);
      const col = (info.columns || []).find(c => c.id === cid && c.type === 'time_tracking'); if (!col) throw bad(404, 'No such time tracking column.');
      const cur = itemDoc(bid, iid); if (!cur || !itemVisible(user, info, cur)) throw bad(404, 'No such item.');
      const guestOk = user.role === 'guest' && ((info.perms || {}).guestEdit || []).includes(cid);
      if (!canWrite(user) && !guestOk) throw bad(403, 'Your account can view boards but not change them.');
      if (lockedCols(user, { ...info, id: bid }).has(cid)) throw lockError(info, new Set([cid]));
      const v = JSON.parse(JSON.stringify((cur.values || {})[cid] || {})); v.sessions = Array.isArray(v.sessions) ? v.sessions : [];
      const mine = v.sessions.find(s => s.by === user.id && !s.end), t = now();
      const act = body.action;
      if (act === 'start') { if (mine) throw bad(409, 'Your timer is already running.'); v.sessions.push({ id: rid('s'), by: user.id, name: user.name, start: t, end: null }); }
      else if (act === 'stop') { if (!mine) throw bad(409, 'Your timer isn’t running.'); mine.end = t; }
      else if (act === 'edit' || act === 'delete') {
        const s = v.sessions.find(x => x.id === String(body.session || '')); if (!s) throw bad(404, 'That session is gone.');
        if (s.by !== user.id && user.role !== 'admin') throw bad(403, 'You can change only your own sessions.');
        if (act === 'delete') v.sessions = v.sessions.filter(x => x !== s);
        else {
          const st = Date.parse(body.start), en = body.end ? Date.parse(body.end) : null;
          if (!Number.isFinite(st) || (body.end && !Number.isFinite(en))) throw bad(400, 'Enter a start and end time.');
          if (en !== null && en < st) throw bad(400, 'The end is before the start.');
          if (st > Date.now() + 60e3 || (en && en > Date.now() + 60e3)) throw bad(400, 'Times can’t be in the future.');
          if (en === null && s.end) throw bad(400, 'Enter an end time.');
          s.start = new Date(st).toISOString(); if (en !== null) s.end = new Date(en).toISOString();
        }
      } else if (act === 'add') {
        const st = Date.parse(body.start), en = Date.parse(body.end);
        if (!Number.isFinite(st) || !Number.isFinite(en) || en < st || en > Date.now() + 60e3) throw bad(400, 'Enter a start and an end in the past.');
        v.sessions.push({ id: rid('s'), by: user.id, name: user.name, start: new Date(st).toISOString(), end: new Date(en).toISOString() });
      } else throw bad(400, 'Say start, stop, add, edit or delete.');
      v.sessions = v.sessions.slice(-500);
      const next = { ...cur, values: { ...(cur.values || {}), [cid]: v.sessions.length ? v : '' } };
      saveItem(bid, iid, next, user, 'app');
      return send(res, 200, { value: next.values[cid], total: timeTotal(v) });
    }

    if (p === '/api/x/links' && method === 'GET') {
      const bid = sp.get('board') || ''; if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      return send(res, 200, links(user, bid));
    }
    if (p === '/api/x/link-search' && method === 'GET') {
      const bid = sp.get('board') || ''; if (!okId(bid) || !boardInfo(bid)) throw bad(404, 'No such board.');
      const info = mustSee(user, bid), qs = String(sp.get('q') || '').trim().toLowerCase();
      const out = [];
      for (const r of q.docsInCol.all(`boards/${bid}/items`)) {
        const d = J(r.data); if (!d || (qs && !String(d.name || '').toLowerCase().includes(qs))) continue;
        if (restricted(user, info) && !itemVisible(user, info, d)) continue;
        out.push({ id: r.id, name: d.name, group: (((info.groups || []).find(g => g.id === d.group)) || {}).name || '' });
        if (out.length >= 40) break;
      }
      return send(res, 200, out);
    }
    throw bad(404, 'Not found.');
  }

  // ---------- public routes (no sign-in): form pages ----------
  const isPublic = url => /^\/f\/[A-Za-z0-9_-]{16,64}$/.test(url.pathname) || url.pathname.startsWith('/api/public/');
  async function handlePublic(req, res, url) {
    const p = url.pathname, method = req.method;
    const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    if (p.startsWith('/f/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const html = fs.readFileSync(path.join(publicDir, 'form.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...sec, 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(html);
    }
    const m = /^\/api\/public\/form\/([A-Za-z0-9_-]{16,64})$/.exec(p);
    if (!m) throw bad(404, 'Not found.');
    const f = formRow.get(m[1]);
    const off = () => bad(404, 'This form is closed or doesn’t exist.');
    if (!f || !f.active) throw off();
    const b = boardDoc(f.board); if (!b) throw off();
    const data = J(f.data) || {};
    // t = the server's clock when the page loaded; the page sends it back, so the "too fast" check never depends on the visitor's clock
    if (method === 'GET') return send(res, 200, { title: data.title, desc: data.desc, fields: formFields(b, data), t: Date.now() }, sec);
    if (method !== 'POST') throw bad(405, 'Send the answers with POST.');
    const ip = clientIp(req);
    if (limited('ip:' + ip, 10, 10 * 60e3) || limited('ipall:' + ip, 40, 3600e3) || limited('tok:' + f.token, 200, 3600e3)) throw bad(429, 'Too many answers from here. Try again a little later.');
    if (Number(req.headers['content-length'] || 0) > 32 * 1024) throw bad(413, 'That’s too much text for this form.');
    const raw = await readBody(req, 32 * 1024);
    // honeypot: a hidden field people never fill in; bots do. Pretend it worked.
    if (raw.website || raw.url || raw.homepage) return send(res, 200, { ok: true, thanks: data.thanks }, sec);
    const age = Date.now() - Number(raw.t);
    if (!Number.isFinite(age) || !Number(raw.t) || age < 1500) return send(res, 200, { ok: true, thanks: data.thanks }, sec); // never loaded the form, or filled in faster than a person can
    if (age > 7 * 864e5) throw bad(400, 'This page has been open too long. Reload it and send your answers again.');
    const a = formAnswers(b, data, raw.answers);
    if (a.errors.length) throw bad(400, a.errors.slice(0, 5).join(' '));
    const actorF = { id: 'form:' + f.id, name: `form “${data.title}”` };
    const group = (b.groups || []).some(g => g.id === data.group) ? data.group : undefined;
    const out = integ.createItem({ id: f.board, ...b }, { name: (a.name || `${data.title} answer`).slice(0, 200), group, values: a.values }, actorF);
    db.prepare('UPDATE public_forms SET submissions = submissions + 1, last_at = ? WHERE id = ?').run(now(), f.id);
    clearSummary();
    return send(res, 201, { ok: true, thanks: data.thanks, id: out.id }, sec);
  }

  return {
    run: (fn, url) => als.run({ api: !!(url && url.pathname.startsWith('/api/v1/')) }, fn),
    setUser: user => { const st = als.getStore(); if (st) st.user = user; },
    handle, isPublic, handlePublic, exportCell, purgeBin, purgeOld, rebuildIndex, search, describeValue,
  };
};
