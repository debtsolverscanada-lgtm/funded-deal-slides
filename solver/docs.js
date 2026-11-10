// Solver.ca docs: a rich-text document per item and Doc column (and the drawer's Doc tab).
// The browser edits with contenteditable; the server keeps only whitelisted HTML (no scripts, no on* attributes,
// no styles, links only to http(s)/mailto/tel), keeps the last 20 versions, and sends changes live to others.
'use strict';

// ---------- the sanitiser ----------
const ALLOWED = new Set(['p', 'br', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'blockquote', 'code', 'pre', 'hr', 'div', 'span']);
const VOID = new Set(['br', 'hr']);
// Dropped with everything inside them.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'noscript', 'textarea', 'select', 'title', 'head', 'xmp', 'noembed', 'noframes', 'plaintext', 'frameset', 'frame', 'applet']);
const ATTRS = { a: ['href'], ul: ['data-checklist'], li: ['data-checked'] };
const MAX_HTML = 200 * 1024;

const escText = s => String(s).replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' })[e.toLowerCase()] ?? m;
  });
}
function safeHref(v) {
  // decode entities, drop control characters and whitespace, then only allow these schemes (or relative/anchor links)
  const raw = decodeEntities(v).replace(/[\u0000- \u007f-\u009f]+/g, '');
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // javascript:, data:, vbscript:…
  if (/^(\/(?!\/)|#)/.test(raw)) return raw;
  return null;
}
function parseAttrs(s) {
  const out = []; const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g; let m;
  while ((m = re.exec(s))) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}
// Returns HTML that contains only the whitelisted tags and attributes, with every tag closed.
function sanitize(html) {
  html = String(html || '');
  if (html.length > MAX_HTML * 2) html = html.slice(0, MAX_HTML * 2);
  let out = '', i = 0; const stack = []; let dropping = null, dropDepth = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const text = lt < 0 ? html.slice(i) : html.slice(i, lt);
    if (text && !dropping) out += escText(text);
    if (lt < 0) break;
    i = lt;
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? html.length : e + 3; continue; }
    if (/^<[!?]/.test(html.slice(i, i + 2))) { const e = html.indexOf('>', i); i = e < 0 ? html.length : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(i, i + 4000));
    if (!m) { if (!dropping) out += '&lt;'; i++; continue; }
    i += m[0].length;
    const close = !!m[1], tag = m[2].toLowerCase(), rest = m[3] || '';
    if (dropping) { if (tag === dropping) { if (close) { if (--dropDepth <= 0) dropping = null; } else if (!/\/\s*$/.test(rest)) dropDepth++; } continue; }
    if (DROP_WITH_CONTENT.has(tag)) { if (!close && !/\/\s*$/.test(rest)) { dropping = tag; dropDepth = 1; } continue; }
    const t = tag === 'strong' ? 'b' : tag === 'em' ? 'i' : tag;
    if (!ALLOWED.has(tag)) continue; // unknown tags vanish, their text stays
    if (close) {
      const k = stack.lastIndexOf(t); if (k < 0) continue;
      while (stack.length > k) out += `</${stack.pop()}>`;
      continue;
    }
    let attrs = '';
    for (const [name, val] of parseAttrs(rest)) {
      if (!(ATTRS[t] || []).includes(name)) continue; // on*, style, class, id, src… are all dropped
      if (name === 'href') { const h = safeHref(val); if (h) attrs += ` href="${escAttr(h)}" target="_blank" rel="noopener noreferrer nofollow"`; }
      else if (name === 'data-checklist') attrs += ' data-checklist="1"';
      else if (name === 'data-checked') attrs += ` data-checked="${val === 'true' || val === '1' ? 'true' : 'false'}"`;
    }
    if (VOID.has(t)) { out += `<${t}>`; continue; }
    if (stack.length > 60) continue;
    out += `<${t}${attrs}>`; stack.push(t);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out.length > MAX_HTML ? null : out;
}
const plainText = html => decodeEntities(String(html || '').replace(/<(br|\/p|\/li|\/h[1-3]|\/div|\/blockquote)>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
// Older copies of Monday doc columns hold a link or text. Shown in the editor as a starting point.
function legacyHtml(v) {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) v = v.map(x => (x && (x.url || x.name)) || '').filter(Boolean).join('\n');
  const s = String(v);
  return s.split(/\n+/).map(line => {
    const m = /^(.*?)\s*[-|]?\s*(https?:\/\/\S+)\s*$/.exec(line.trim());
    if (m) return `<p>${m[1] ? escText(m[1]) + ' ' : ''}<a href="${escAttr(m[2])}" target="_blank" rel="noopener noreferrer nofollow">${escText(m[2])}</a></p>`;
    return `<p>${escText(line)}</p>`;
  }).join('');
}

module.exports = function docs({ db, q, now, broadcast, HttpError, readBody, send, boardInfo, mustSee, itemVisible, canWrite, lockedCols, lockError }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_docs (
      board TEXT NOT NULL, item TEXT NOT NULL, col TEXT NOT NULL, html TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, updated_by TEXT, by_name TEXT, PRIMARY KEY (board, item, col)
    );
    CREATE TABLE IF NOT EXISTS item_doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, item TEXT NOT NULL, col TEXT NOT NULL,
      html TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT, by_name TEXT
    );
    CREATE INDEX IF NOT EXISTS item_doc_versions_doc ON item_doc_versions(board, item, col, id);
  `);
  const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const get = db.prepare('SELECT * FROM item_docs WHERE board = ? AND item = ? AND col = ?');
  const put = db.prepare(`INSERT INTO item_docs (board, item, col, html, rev, updated_at, updated_by, by_name) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(board, item, col) DO UPDATE SET html = excluded.html, rev = item_docs.rev + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by, by_name = excluded.by_name`);
  const lastVersion = db.prepare('SELECT * FROM item_doc_versions WHERE board = ? AND item = ? AND col = ? ORDER BY id DESC LIMIT 1');
  const addVersion = db.prepare('INSERT INTO item_doc_versions (board, item, col, html, at, by_id, by_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updVersion = db.prepare('UPDATE item_doc_versions SET html = ?, at = ? WHERE id = ?');
  const trimVersions = db.prepare('DELETE FROM item_doc_versions WHERE board = ? AND item = ? AND col = ? AND id NOT IN (SELECT id FROM item_doc_versions WHERE board = ? AND item = ? AND col = ? ORDER BY id DESC LIMIT 20)');

  // Which docs exist on a board: a Doc column, a Monday doc column (copied as text), or the item's own notes doc.
  const docCol = (b, col) => col === '_notes' ? { id: '_notes', title: 'Notes', type: 'doc' } : (b.columns || []).find(c => c.id === col && (c.type === 'doc' || c.source === 'doc' || c.source === 'direct_doc'));
  function target(user, url, body) {
    const bid = String((body && body.board) || url.searchParams.get('board') || ''), iid = String((body && body.item) || url.searchParams.get('item') || ''), col = String((body && body.col) || url.searchParams.get('col') || '');
    if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid);
    const r = ID.test(iid) && q.doc.get(`boards/${bid}/items/${iid}`); if (!r) throw new HttpError(404, 'No such item.');
    const item = JSON.parse(r.data); if (!itemVisible(user, info, item)) throw new HttpError(404, 'No such item.');
    const b = JSON.parse(q.doc.get('boards/' + bid).data);
    const c = docCol(b, col); if (!c) throw new HttpError(404, 'No such doc.');
    return { bid, iid, col, info, item, b, c };
  }
  function mayWrite(user, t) {
    if (user.role === 'guest') { if (!((t.b.perms || {}).guestEdit || []).includes(t.col)) throw new HttpError(403, 'Guests can only change the columns the admin opened to guests.'); }
    else if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    if (t.col !== '_notes' && lockedCols(user, { ...t.info, columns: t.b.columns, perms: t.b.perms }).has(t.col)) throw lockError(t.b, new Set([t.col]));
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/itemdoc')) return false;
    if (p === '/api/itemdoc' && method === 'GET') {
      const t = target(user, url);
      const row = get.get(t.bid, t.iid, t.col);
      if (row) return send(res, 200, { html: row.html, rev: row.rev, updatedAt: row.updated_at, byName: row.by_name || '', legacy: false });
      const legacy = t.col === '_notes' ? '' : legacyHtml((t.item.values || {})[t.col]);
      return send(res, 200, { html: legacy ? sanitize(legacy) : '', rev: 0, updatedAt: null, byName: '', legacy: !!legacy });
    }
    if (p === '/api/itemdoc' && method === 'PUT') {
      const body = await readBody(req, 600 * 1024);
      const t = target(user, url, body); mayWrite(user, t);
      const html = sanitize(body.html);
      if (html === null) throw new HttpError(413, 'That doc is too long (200 KB of text at most).');
      const cur = get.get(t.bid, t.iid, t.col);
      // someone else saved since this page loaded: say so instead of silently overwriting their work
      if (cur && body.rev != null && Number(body.rev) !== cur.rev && cur.updated_by !== user.id && !body.force) {
        const e = new HttpError(409, `${cur.by_name || 'Someone'} changed this doc a moment ago.`); e.code = 'conflict'; throw e;
      }
      if (cur && cur.html === html) return send(res, 200, { ok: true, rev: cur.rev, html, same: true });
      const at = now();
      put.run(t.bid, t.iid, t.col, html, at, user.id, user.name || '');
      // version history: one version per person per 2 minutes of editing, the last 20 kept
      const last = lastVersion.get(t.bid, t.iid, t.col);
      if (last && last.by_id === user.id && Date.now() - Date.parse(last.at) < 2 * 60 * 1000 && !body.restore) updVersion.run(html, at, last.id);
      else addVersion.run(t.bid, t.iid, t.col, html, at, user.id, user.name || '');
      trimVersions.run(t.bid, t.iid, t.col, t.bid, t.iid, t.col);
      const row = get.get(t.bid, t.iid, t.col);
      broadcast({ op: 'doc', col: `boards/${t.bid}/items`, id: t.iid, docCol: t.col, rev: row.rev, html, by: user.id, byName: user.name || '', at });
      // a short preview in the table cell (Doc columns only; Monday copies keep their own text)
      if (t.c.type === 'doc' && t.col !== '_notes') {
        const prev = plainText(html).replace(/\s+/g, ' ').slice(0, 140);
        if ((t.item.values || {})[t.col] !== prev) {
          const r2 = q.doc.get(`boards/${t.bid}/items/${t.iid}`); const it = JSON.parse(r2.data); it.values = { ...(it.values || {}), [t.col]: prev };
          q.upsertDoc.run(`boards/${t.bid}/items/${t.iid}`, `boards/${t.bid}/items`, t.iid, JSON.stringify(it), at, user.id);
          broadcast({ op: 'set', col: `boards/${t.bid}/items`, id: t.iid, data: it });
        }
      }
      return send(res, 200, { ok: true, rev: row.rev, html });
    }
    if (p === '/api/itemdoc/versions' && method === 'GET') {
      const t = target(user, url);
      const rows = db.prepare('SELECT id, at, by_name, length(html) AS size FROM item_doc_versions WHERE board = ? AND item = ? AND col = ? ORDER BY id DESC LIMIT 20').all(t.bid, t.iid, t.col);
      return send(res, 200, rows.map(r => ({ id: r.id, at: r.at, byName: r.by_name || '', size: r.size })));
    }
    if (p === '/api/itemdoc/version' && method === 'GET') {
      const t = target(user, url); const id = Number(url.searchParams.get('id'));
      const v = db.prepare('SELECT * FROM item_doc_versions WHERE id = ? AND board = ? AND item = ? AND col = ?').get(id, t.bid, t.iid, t.col);
      if (!v) throw new HttpError(404, 'That version is gone.');
      return send(res, 200, { id: v.id, at: v.at, byName: v.by_name || '', html: v.html });
    }
    return false;
  }
  return { handle, sanitize };
};
module.exports.sanitize = sanitize;
module.exports.plainText = plainText;
module.exports.legacyHtml = legacyHtml;
