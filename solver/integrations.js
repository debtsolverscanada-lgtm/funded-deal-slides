// Solver.ca integrations: a REST API with keys, outgoing webhooks, and incoming lead links.
// Solver.ca itself never texts, emails or calls anyone. Webhooks only tell YOUR tools what changed.
'use strict';
const crypto = require('node:crypto');
const netguard = require('./netguard.js');

module.exports = function integrations({ db, q, now, broadcast, HttpError, readBody, send, merge, notifyNames = () => 0, itemNotifications = () => {}, fillTemplate = t => t, buzz = () => {}, lockedCols = () => new Set(), lockError = null, hooks = {}, clientIp = req => String(req.socket.remoteAddress || '') }) {
  // hooks (filled in by ext.js): ruleRan(board, rule, itemId, itemName, result, via), onEvent(event, hits)
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL CHECK (scope IN ('read','write')), created_at TEXT NOT NULL, created_by TEXT,
      last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('out','in')), name TEXT NOT NULL,
      url TEXT, secret TEXT, token TEXT UNIQUE, events TEXT, board TEXT, grp TEXT, dedupe TEXT,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_at TEXT, last_status TEXT, last_error TEXT
    );
  `);
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const rid = p => p + crypto.randomBytes(9).toString('base64url');
  const hits = new Map(); // key -> [times]
  function limited(key, max, ms) { const t = Date.now(), list = (hits.get(key) || []).filter(x => t - x < ms); if (list.length >= max) { hits.set(key, list); return true; } list.push(t); hits.set(key, list); return false; }
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < 3600e3)) hits.delete(k); }, 600e3).unref();
  const EVENTS = ['item.created', 'item.updated', 'item.moved', 'item.status_changed', 'item.deleted', 'update.created', 'reminder.due', 'button.pressed', 'automation.webhook'];

  // ---------- helpers: boards and readable fields ----------
  const boardDoc = id => { const r = q.doc.get('boards/' + id); return r ? JSON.parse(r.data) : null; };
  const findBoard = ref => {
    if (!ref) return null;
    const b = boardDoc(ref); if (b) return { id: ref, ...b };
    for (const r of q.docsInCol.all('boards')) { const d = JSON.parse(r.data); if (String(d.mondayId) === String(ref) || d.name.toLowerCase() === String(ref).toLowerCase()) return { id: r.id, ...d }; }
    return null;
  };
  function readable(b, item) {
    const fields = {};
    for (const c of b.columns || []) {
      const v = (item.values || {})[c.id];
      if (v === undefined || v === null || v === '') continue;
      fields[c.title] = c.type === 'status' ? (((c.labels || []).find(l => l.id === String(v)) || {}).label ?? v) : v;
    }
    return fields;
  }
  function itemOut(b, id, item) {
    const g = (b.groups || []).find(x => x.id === item.group);
    return { id, board: { id: b.id, name: b.name }, name: item.name, group: g ? { id: g.id, name: g.name } : { id: item.group, name: null },
      fields: readable(b, item), values: item.values || {}, created_at: item.createdAt || null, updates: (item.updates || []).length };
  }
  function boardOut(id, b) {
    return { id, name: b.name, workspace: b.workspace || null, folder: b.folder || '', groups: (b.groups || []).map(g => ({ id: g.id, name: g.name })),
      columns: (b.columns || []).map(c => ({ id: c.id, title: c.title, type: c.type, ...(c.labels ? { labels: c.labels.filter(l => !l.hidden).map(l => ({ id: l.id, label: l.label })) } : {}), ...(c.options ? { options: c.options } : {}) })) };
  }
  // "2026-11-20", "11/20/2026", "20/11/2026", "Nov 20, 2026" -> "2026-11-20" (a calendar date, never shifted by a
  // time zone). Only a value with a time AND a zone ("…T03:00:00Z") is an instant, shown as the company's local day.
  const ymdOk = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  const ymdStr = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  function parseDay(raw) {
    const s = String(raw).trim();
    // midnight UTC exactly ("2026-11-20T00:00:00Z", ".000Z"): what spreadsheets and JSON send for a plain date, so the calendar date
    { const mz = /^(\d{4})-(\d{2})-(\d{2})T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/i.exec(s); if (mz) { const [y, mo, d] = [+mz[1], +mz[2], +mz[3]]; return ymdOk(y, mo, d) ? ymdStr(y, mo, d) : null; } }
    const instant = /\d[T\s]\d{1,2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    if (instant) { const d = new Date(s); return isNaN(d) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: process.env.KS_TIMEZONE || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(s);
    if (m) { const [y, mo, d] = [+m[1], +m[2], +m[3]]; return ymdOk(y, mo, d) ? ymdStr(y, mo, d) : null; }
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|\s)/.exec(s);
    if (m) {
      let [a, c, y] = [+m[1], +m[2], +m[3]]; if (y < 100) y += 2000;
      const [mo, d] = a > 12 ? [c, a] : [a, c]; // month first (North American), unless the first number can't be a month
      return ymdOk(y, mo, d) ? ymdStr(y, mo, d) : null;
    }
    const d = new Date(s); if (isNaN(d)) return null;
    return ymdStr(d.getFullYear(), d.getMonth() + 1, d.getDate()); // parsed as a local calendar date: read it back the same way
  }
  // "$1,200.50", "(300)" (accounting negative), "-300", "300-", "−300" -> numbers
  function parseNum(raw) {
    let s = String(raw).trim().replace(/[−‒–]/g, '-'); let neg = false;
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) && Number.isFinite(Number(s))) return Number(s); // plain numbers, including 1.5e6 and -2E-3
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-\s*$/.test(s) && !/^-/.test(s)) { neg = true; s = s.replace(/-\s*$/, ''); }
    s = s.replace(/[^0-9.\-]/g, '');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    const n = Number(s); return neg ? -Math.abs(n) : n;
  }
  const YES = new Set(['true', '1', 'yes', 'y', 'x', '✓', '✔', '☑', 'checked', 'on', 'done']);
  // Accepts values keyed by column id OR title; status by label name or id.
  // opts.lenient (spreadsheet import): an unknown status label leaves that cell empty and is reported in `warnings`, the row stays.
  function toValues(b, input, errors, opts = {}) {
    const out = {};
    for (const [k, raw] of Object.entries(input || {})) {
      const c = (b.columns || []).find(x => x.id === k) || (b.columns || []).find(x => x.title.toLowerCase() === String(k).toLowerCase());
      if (!c) { errors.push(`No column called “${k}”.`); continue; }
      if (['formula', 'button', 'item_id', 'created'].includes(c.type) || (c.readonly && c.source !== 'file')) { errors.push(`“${c.title}” is calculated and can’t be set.`); continue; }
      let v = raw;
      if (v === null || v === '') { out[c.id] = ''; continue; }
      if (c.type === 'status') {
        const l = (c.labels || []).find(x => x.id === String(v) || String(x.label).trim().toLowerCase() === String(v).trim().toLowerCase());
        if (!l) { const msg = `“${v}” isn’t a label in ${c.title}.`; if (opts.lenient && opts.warnings) { opts.warnings.push({ col: c.id, title: c.title, value: String(v), msg }); continue; } errors.push(msg); continue; }
        v = l.id;
      }
      else if (c.type === 'number') { v = typeof v === 'number' ? v : parseNum(v); if (!Number.isFinite(v)) { errors.push(`${c.title} needs a number.`); continue; } }
      else if (c.type === 'date') { const d = parseDay(v); if (!d) { errors.push(`${c.title} needs a date like 2026-11-20.`); continue; } v = d; }
      else if (c.type === 'checkbox') v = v === true || v === 1 || YES.has(String(v).trim().toLowerCase());
      else if (c.type === 'file' || c.source === 'file') { v = Array.isArray(v) ? v.filter(f => f && f.url).map(f => ({ name: String(f.name || f.url), url: String(f.url) })) : String(v); if (Array.isArray(v) && v.some(f => !netguard.urlOk(f.url))) { errors.push(`${c.title}: files must be https:// links.`); continue; } }
      else if (c.type === 'link' && netguard.badLink(null, { values: { l: String(v) } }, ['l'])) { errors.push(`${c.title} needs an https:// link.`); continue; }
      else if (Array.isArray(v)) v = v.join(', ');
      else v = String(v);
      out[c.id] = v;
    }
    return out;
  }
  const groupId = (b, g) => { if (!g) return (b.groups || [])[0] && b.groups[0].id; const x = (b.groups || []).find(y => y.id === g || y.name.toLowerCase() === String(g).toLowerCase()); return x && x.id; };

  // ---------- the board's own automations, for changes made through the API ----------
  // Same rules the app runs (status/date/assign/move-to-group), chained up to 4 deep like the app. Messaging and outside tools stay off.
  // A rule never writes a column the person, key, link or form that set it off can't change: that action is skipped and logged.
  // Monday "notify" actions become in-app notifications for the Solver.ca people they name. Notifications, webhooks and
  // the run log all go out from here, after the item saved.
  function sendNotes(b, iid, item, notes) {
    for (const n of notes) {
      if (n.ran) { if (hooks.ruleRan && iid) try { hooks.ruleRan(b.id, n.ran.rule, iid, item.name, n.ran.result, n.ran.via); } catch (e) {} continue; }
      // "Send to a connected tool": a signed automation.webhook event (opt-in per rule)
      if (n.webhook) {
        try {
          const throttled = !!(hooks.webhookThrottled && hooks.webhookThrottled(b.id, iid, n.rule));
          const sent = !throttled && hooks.sendWebhook ? hooks.sendWebhook(b.id, iid, n.rule, item, n.via || 'api') : 0;
          if (hooks.ruleRan) hooks.ruleRan(b.id, n.rule.id, iid, item.name, throttled ? 'Not sent again: this rule sent this item a few seconds ago (throttled)' : sent ? `Sent to ${sent === 1 ? 'a connected tool' : sent + ' connected tools'}` : 'No connected tool is listening', 'webhook');
        } catch (e) { console.error('automation webhook:', e.message); }
        continue;
      }
      const names = fillTemplate(n.to || '', b, item).split(',').map(x => x.trim()).filter(Boolean);
      const msg = fillTemplate(n.message || '', b, item).replace(/\s+/g, ' ').trim();
      try { notifyNames(names, { kind: n.kind || 'automation', text: `${item.name || 'Item'}: ${msg || String(n.title || 'Reminder').replace(/\s*→.*$/, '')}`.slice(0, 400), board: b.id, item: iid }); } catch (e) { console.error('notify:', e.message); }
    }
  }
  // Same condition rules as the app: status is / column empty / person is / group is, and a few more.
  const splitNames = v => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  function condOk(b, item, c) {
    if (c.col === '__group') { const gid = c.value === '__top__' ? (b.groups[0] || {}).id : c.value; return c.op === 'is_not' ? item.group !== gid : item.group === gid; }
    const v = (item.values || {})[c.col], empty = v === '' || v == null || v === false, list = Array.isArray(c.value) ? c.value.map(String) : [String(c.value ?? '')];
    switch (c.op) {
      case 'empty': return empty; case 'not_empty': return !empty;
      case 'is_not': case 'is_not_any': return !list.includes(String(v ?? ''));
      case 'contains': return String(v ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
      case 'has_person': { const ps = splitNames(v); return list.some(x => ps.includes(String(x).trim().toLowerCase())); }
      default: return list.includes(String(v ?? ''));
    }
  }
  // ev: { type: 'created'|'moved_group'|'value', col, value, group }. actor: the user, API key, lead link or form that made the change.
  // Side effects (notify, webhook, run log) go into `notes`; sendNotes sends them once the item is saved.
  function runRules(b, item, ev, actor, notes = [], iid = null, depth = 0) {
    const actorName = (actor && actor.name) || 'someone', locked = lockedCols(actor && actor.role ? actor : null, b), guest = !!actor && actor.role === 'guest';
    const rules = (b.automations || []).filter(r => r.on !== false && r.trigger && (
      (ev.type === 'created' && r.trigger === 'created' && (!r.group || r.group === ev.group)) ||
      (ev.type === 'moved_group' && r.trigger === 'moved_group' && (!r.group || r.group === ev.group || (r.group === '__top__' && (b.groups[0] || {}).id === ev.group))) ||
      (ev.type === 'value' && (r.trigger === 'status' || r.trigger === 'column') && r.col === ev.col && (r.value == null || r.value === '' || String(r.value) === String(ev.value))))
    ).filter(r => (r.conditions || []).every(c => condOk(b, item, c)));
    if (!rules.length) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.KS_TIMEZONE || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), log = [];
    const plus = (n) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + Number(n || 0))).toISOString().slice(0, 10); };
    const title = cid => ((b.columns || []).find(c => c.id === cid) || {}).title || cid;
    item.values = item.values || {};
    const beforeVals = { ...item.values }, beforeGroup = item.group;
    for (const r of rules) {
      const did = [], skipped = [], name = `“${r.title || 'Automation'}”`;
      const canSet = cid => { if (!locked.has(cid)) return true; skipped.push(`skipped: ${title(cid)} is locked for ${actorName}`); return false; };
      for (const a of r.actions || []) {
        if (a.type === 'set_status' || a.type === 'set_value') { if (canSet(a.col)) { item.values[a.col] = a.value; did.push('set ' + title(a.col)); } }
        else if (a.type === 'set_date') { if (canSet(a.col)) { item.values[a.col] = a.offset ? plus(a.offset) : today; did.push('set ' + title(a.col)); } }
        else if (a.type === 'clear') { if (canSet(a.col)) { item.values[a.col] = ''; did.push('cleared ' + title(a.col)); } }
        else if (a.type === 'assign') { if (canSet(a.col)) { item.values[a.col] = [...new Set([...String(item.values[a.col] || '').split(',').map(s => s.trim()).filter(Boolean), a.value])].join(', '); did.push('assigned ' + a.value); } }
        else if (a.type === 'move_group') {
          if (guest) { skipped.push(`skipped: moving it to a group (${actorName} is a guest)`); continue; }
          const g = a.group === '__top__' ? b.groups[0] : b.groups.find(x => x.id === a.group);
          if (g && item.group !== g.id) { item.group = g.id; did.push('moved it to ' + g.name); } // already there: nothing to say
        }
        else if (a.type === 'notify') { notes.push({ to: a.to, message: a.message, title: r.title }); did.push('notified ' + (a.to || 'someone')); }
        else if (a.type === 'webhook') { if (!notes.some(n => n.webhook && n.rule.id === r.id)) notes.push({ webhook: true, rule: r, via: guest ? 'guest' : undefined }); }
        else if (a.type === 'create_update') { item.updates = [...(item.updates || []), { at: now(), by: 'automation', byName: 'Automation', text: String(a.value || '') }]; did.push('posted an update'); }
        // moving, copying and duplicating need the app open: say so instead of skipping quietly
        else if (a.type === 'move_board' || a.type === 'copy_to_board' || a.type === 'duplicate') { const what = a.type === 'move_board' ? 'moving it to another board' : a.type === 'copy_to_board' ? 'copying it to another board' : 'duplicating it'; skipped.push(guest ? `skipped: ${what} (${actorName} is a guest)` : `skipped: ${what} only runs for changes made in the app, not through ${actorName}`); }
        else skipped.push(`skipped: ${a.label || String(a.type || 'this action').replace(/_/g, ' ')} isn’t run in Solver.ca`);
      }
      log.push({ at: now(), by: 'automation', text: `${name} ran (via ${actorName})` });
      skipped.forEach(s => log.push({ at: now(), by: 'automation', text: `${name} ${s}` }));
      // a rule that only sends to a connected tool gets its line in the run log from the send itself
      const hookOnly = !did.length && !skipped.length && (r.actions || []).some(a => a.type === 'webhook');
      const result = [did.length ? 'Ran: ' + did.join(', ') : skipped.length ? '' : 'Ran (nothing to change here)', ...skipped].filter(Boolean).join('; ');
      if (!hookOnly) notes.push({ ran: { rule: r.id, result, via: (guest ? 'guest' : 'api') + ' · ' + actorName } });
    }
    if (log.length) item.activity = [...log, ...(item.activity || [])].slice(0, 40);
    // changes the rules made set off further rules, like the app (4 deep at most)
    if (depth < 4) {
      for (const [cid, v] of Object.entries(item.values)) if (JSON.stringify(beforeVals[cid] ?? '') !== JSON.stringify(v ?? '')) runRules(b, item, { type: 'value', col: cid, value: v }, actor, notes, iid, depth + 1);
      if (item.group !== beforeGroup) runRules(b, item, { type: 'moved_group', group: item.group }, actor, notes, iid, depth + 1);
    }
  }

  // A guest's change saved through /api/doc: the board's rules run here, on the server (a guest's page doesn't run them,
  // and its notifications, webhooks and run log would be refused). Rules set only the columns the guest may change,
  // never move or copy the item, and sign their activity lines as the automation. Returns what sendNotes sends once saved.
  function guestRules(bid, before, after, user) {
    const d = boardDoc(bid); if (!d || !before) return null;
    const b = { id: bid, ...d }, notes = [], bv = before.values || {}, av = (after.values = after.values || {});
    const changed = (b.columns || []).filter(c => JSON.stringify(bv[c.id] ?? '') !== JSON.stringify(av[c.id] ?? ''));
    for (const c of changed) runRules(b, after, { type: 'value', col: c.id, value: av[c.id] }, user, notes);
    return notes.length ? { b, notes } : null;
  }

  // ---------- outgoing webhooks ----------
  const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|\[::1\]|172\.(1[6-9]|2\d|3[01])\.)/i;
  function safeUrl(u) { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && (process.env.KS_ALLOW_PRIVATE_WEBHOOKS === '1' || !PRIVATE.test(x.hostname)) ? x.toString() : null; } catch (e) { return null; } }
  const outHooks = () => db.prepare("SELECT * FROM hooks WHERE kind = 'out' AND active = 1").all();
  const setHookResult = db.prepare('UPDATE hooks SET last_at = ?, last_status = ?, last_error = ? WHERE id = ?');
  async function deliver(h, payload, attempt = 1) {
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', h.secret).update(body).digest('hex');
    try {
      // every address the name resolves to is checked when connecting; redirects are not followed
      const r = await netguard.safePost(h.url, { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Solver.ca-Webhooks/1', 'X-Solver-Event': payload.event, 'X-Solver-Signature': sig, 'X-Solver-Delivery': payload.delivery }, body, timeout: 10000 });
      setHookResult.run(now(), String(r.status), r.ok ? null : `Got ${r.status}`, h.id);
      if (!r.ok && r.status >= 500 && attempt < 3) setTimeout(() => deliver(h, payload, attempt + 1), 5000 * attempt);
      return r.status;
    } catch (e) {
      setHookResult.run(now(), 'failed', e.message, h.id);
      if (attempt < 3 && e.code !== 'EPRIVATE') setTimeout(() => deliver(h, payload, attempt + 1), 5000 * attempt);
      return 0;
    }
  }
  // opts.hook: only that webhook (an automation can pick one connected tool)
  function emit(event, boardId, itemId, b, item, extra = {}, opts = {}) {
    const hooks = outHooks().filter(h => { const ev = JSON.parse(h.events || '[]'); return (!ev.length || ev.includes(event)) && (!h.board || h.board === boardId) && (!opts.hook || h.id === opts.hook); });
    if (!hooks.length) return 0;
    const payload = { event, delivery: rid('d_'), at: now(), board: { id: boardId, name: b ? b.name : null }, item: item && b ? itemOut({ id: boardId, ...b }, itemId, item) : { id: itemId }, ...extra };
    hooks.forEach(h => deliver(h, payload));
    return hooks.length;
  }
  // A person pressed a button column (Build Application, Send to Scarlett...). Solver.ca never runs the
  // outside tool itself: it logs the press on the item and sends a signed button.pressed webhook to
  // whatever tool is listening (n8n, the agency server). Returns how many webhooks it was sent to.
  function pressButton(bid, iid, colId, user) {
    const b = boardDoc(bid); if (!b) throw new HttpError(404, 'No such board.');
    const col = (b.columns || []).find(c => c.id === colId && c.type === 'button'); if (!col) throw new HttpError(404, 'No such button.');
    const path = `boards/${bid}/items/${iid}`; const r = q.doc.get(path); if (!r) throw new HttpError(404, 'No such item.');
    const item = JSON.parse(r.data);
    item.activity = [{ at: now(), by: user.name || user.email, text: `Pressed “${col.title}”` }, ...(item.activity || [])].slice(0, 40);
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), now(), user.id);
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
    const sent = emit('button.pressed', bid, iid, b, item, { button: { column_id: col.id, title: col.title }, pressed_by: { name: user.name || null, email: user.email || null } });
    return { sent, button: col.title };
  }
  // Called after any item write (app or API). Skips bulk copies from Monday.
  function itemChanged(path, before, after, actor) {
    const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(path); if (!m) return;
    if (actor === 'monday-sync' || actor === 'import') return;
    const [, bid, iid] = m; const b = boardDoc(bid);
    if (!before && after) return emit('item.created', bid, iid, b, after);
    if (before && !after) return emit('item.deleted', bid, iid, b, before);
    if (!b) return;
    const changed = [];
    for (const c of b.columns || []) {
      const x = (before.values || {})[c.id], y = (after.values || {})[c.id];
      if (JSON.stringify(x ?? '') === JSON.stringify(y ?? '')) continue;
      const lab = v => c.type === 'status' ? (((c.labels || []).find(l => l.id === String(v)) || {}).label ?? v ?? '') : (v ?? '');
      changed.push({ column: c.title, column_id: c.id, from: lab(x), to: lab(y) });
      if (c.type === 'status') emit('item.status_changed', bid, iid, b, after, { change: { column: c.title, from: lab(x), to: lab(y) } });
    }
    if (before.group !== after.group) {
      const g = id => ((b.groups || []).find(x => x.id === id) || {}).name || id;
      emit('item.moved', bid, iid, b, after, { change: { from: g(before.group), to: g(after.group) } });
    }
    if (before.name !== after.name) changed.push({ column: 'Name', from: before.name, to: after.name });
    if (changed.length) emit('item.updated', bid, iid, b, after, { changes: changed });
    if ((after.updates || []).length > (before.updates || []).length) emit('update.created', bid, iid, b, after, { update: (after.updates || [])[(after.updates || []).length - 1] });
  }

  // ---------- writes shared by the API and incoming links ----------
  function saveItem(bid, iid, data, actor, opts = {}) {
    const path = `boards/${bid}/items/${iid}`;
    const old = q.doc.get(path); const before = old ? JSON.parse(old.data) : null;
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(data), now(), actor.id);
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data });
    itemChanged(path, before, data, actor.id);
    if (!opts.quiet) buzz(bid, iid, before, data, actor.id);
    if (!before && hooks.newItem) { try { hooks.newItem(bid, iid, data); } catch (e) { /* banner only */ } }
    if (hooks.itemSaved) { try { hooks.itemSaved(bid, iid, before, data); } catch (e) { /* sequences only */ } }
    try { itemNotifications(path, before, data, actor); } catch (e) { console.error('notifications:', e.message); }
  }
  // opts.quiet: no pet heads-up per item (used by spreadsheet imports, which can add thousands of rows)
  // Columns the writer may not set: API keys and lead links get the board's locks, people their own; forms (made by an admin) none.
  const lockedFor = (b, actor) => { const id = String((actor && actor.id) || ''); if (id.startsWith('form:')) return new Set(); return lockedCols(id.startsWith('key:') || id.startsWith('link:') || !actor || !actor.role ? null : actor, b); };
  function createItem(b, body, actor, opts = {}) {
    const errors = [], warnings = []; const values = toValues(b, { ...(body.values || {}), ...(body.fields || {}) }, errors, { lenient: !!opts.lenient, warnings });
    const locked = opts.locked || lockedFor(b, actor), stripped = [];
    for (const k of Object.keys(values)) if (locked.has(String(k).replace(/__d?t$/, ''))) { delete values[k]; stripped.push(k); }
    const name = String(body.name || '').trim(); if (!name) errors.push('Give the item a name.');
    const grp = groupId(b, body.group); if (!grp) errors.push(`No group called “${body.group}”.`);
    if (errors.length) throw new HttpError(400, errors.join(' '));
    const iid = rid('i'); const item = { name, group: grp, pos: Date.now(), values, updates: [], subitems: [], createdAt: now(),
      activity: [{ at: now(), by: actor.id, text: `Created by ${actor.name}` }] };
    // a cell the import couldn't fill is flagged on the item itself
    for (const w of warnings) item.activity.unshift({ at: now(), by: actor.id, text: `Import: ${w.title} left empty, “${w.value.slice(0, 80)}” isn’t one of its labels` });
    // and the value itself is kept whole, as a comment on the item, so nothing in the sheet is lost
    if (warnings.length) item.updates.push({ at: now(), by: '', byName: actor.name, text: ('Import: these values weren’t one of their column’s labels, so the cells were left empty:\n' + warnings.map(w => `${w.title}: ${w.value}`).join('\n')).slice(0, 20000) });    if (body.update) item.updates.push({ at: now(), by: '', byName: actor.name, text: String(body.update).slice(0, 4000) });
    const notes = [];
    runRules(b, item, { type: 'created', group: grp }, actor, notes, iid);
    saveItem(b.id, iid, item, actor, opts);
    sendNotes(b, iid, item, notes);
    return { id: iid, item, stripped, warnings };
  }

  // ---------- API keys ----------
  function keyUser(req) {
    const h = String(req.headers.authorization || ''); const m = /^Bearer\s+(ks_[A-Za-z0-9_-]+)$/.exec(h); if (!m) return null;
    const row = db.prepare('SELECT * FROM api_keys WHERE hash = ? AND revoked = 0').get(sha(m[1])); if (!row) return null;
    db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(now(), row.id);
    return { id: 'key:' + row.id, name: 'API key “' + row.name + '”', scope: row.scope };
  }

  // ---------- /api/v1 (API key) and /api/v1/in/<token> (incoming lead links) ----------
  async function handleV1(req, res, url) {
    const p = url.pathname, method = req.method;
    const inm = /^\/api\/v1\/in\/([A-Za-z0-9_-]{16,})$/.exec(p);
    if (inm) {
      if (method !== 'POST') throw new HttpError(405, 'Send a POST with the lead’s details.');
      const h = db.prepare("SELECT * FROM hooks WHERE kind = 'in' AND token = ? AND active = 1").get(inm[1]);
      if (!h) throw new HttpError(404, 'This lead link is off or doesn’t exist.');
      const b = findBoard(h.board); if (!b) throw new HttpError(404, 'The board for this lead link no longer exists.');
      const ip = clientIp(req);
      if (limited('link:' + h.id, 60, 60e3) || limited('linkh:' + h.id, 1000, 3600e3) || limited('linkip:' + ip, 30, 60e3)) throw new HttpError(429, 'Too many leads sent to this link. Try again in a minute.');
      if (Number(req.headers['content-length'] || 0) > 64 * 1024) throw new HttpError(413, 'That lead is too large.');
      const raw = await readBody(req, 64 * 1024);
      // Flat forms: name/first_name/last_name + any field named like a column title.
      const name = raw.name || [raw.first_name || raw.firstName, raw.last_name || raw.lastName].filter(Boolean).join(' ') || raw.email || raw.phone || 'New lead';
      const fields = {}; const skip = new Set(['name', 'first_name', 'firstName', 'last_name', 'lastName', 'group', 'values', 'fields', 'update', 'note']);
      for (const [k, v] of Object.entries(raw)) if (!skip.has(k) && (typeof v !== 'object' || v === null)) fields[k] = v;
      Object.assign(fields, raw.fields || {}, raw.values || {});
      const known = {}, extra = [];
      for (const [k, v] of Object.entries(fields)) {
        const c = (b.columns || []).find(x => x.id === k || x.title.toLowerCase() === k.toLowerCase() || x.title.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (c) known[c.id] = v; else extra.push(`${k}: ${v}`);
      }
      const actor = { id: 'link:' + h.id, name: 'lead link “' + h.name + '”' };
      if (h.dedupe) {
        const col = (b.columns || []).find(c => c.id === h.dedupe); const v = col && known[col.id];
        if (v) { const norm = s => String(s).replace(/\D/g, '').slice(-10) || String(s).toLowerCase();
          for (const r of q.docsInCol.all(`boards/${b.id}/items`)) { const d = JSON.parse(r.data); if (norm((d.values || {})[col.id] || '') === norm(v)) { setHookResult.run(now(), 'duplicate', null, h.id); return send(res, 200, { ok: true, duplicate: true, id: r.id }); } } }
      }
      // a group sent with the lead must exist; otherwise the link's own group (then the first group) is used, so no lead is lost
      const grpIn = raw.group && groupId(b, String(raw.group)) ? String(raw.group) : (h.grp && groupId(b, h.grp) ? h.grp : undefined);
      const out = createItem(b, { name: String(name).slice(0, 255), group: grpIn, values: known, update: [raw.update || raw.note, extra.length ? 'Other form answers:\n' + extra.join('\n') : ''].filter(Boolean).join('\n\n') }, actor);
      setHookResult.run(now(), 'created', null, h.id);
      return send(res, 201, { ok: true, id: out.id });
    }

    const user = keyUser(req);
    if (!user) throw new HttpError(401, 'Send your API key as: Authorization: Bearer ks_…');
    const needWrite = () => { if (user.scope !== 'write') throw new HttpError(403, 'This API key is read-only.'); };
    if (p === '/api/v1/me') return send(res, 200, { key: user.name, scope: user.scope });
    if (p === '/api/v1/events' && method === 'POST') {
      needWrite(); const body = await readBody(req);
      const KINDS = { client_texted: ['text', n => `${n} just texted you!`], client_called: ['call', n => `${n} just called!`], client_emailed: ['email', n => `${n} just emailed!`], documents_received: ['docs', n => `New documents from ${n}!`] };
      const k = KINDS[body.type]; if (!k) throw new HttpError(400, 'type must be one of: ' + Object.keys(KINDS).join(', '));
      let hits = [];
      if (body.board && body.item) hits = [{ bid: body.board, iid: String(body.item) }];
      else {
        const phone = String(body.phone || '').replace(/\D/g, '').slice(-10), email = String(body.email || '').toLowerCase();
        if (!phone && !email) throw new HttpError(400, 'Send phone, email, or board + item.');
        for (const br of q.docsInCol.all('boards')) { const bd = JSON.parse(br.data); const pc = (bd.columns || []).filter(c => c.type === 'phone').map(c => c.id), ec = (bd.columns || []).filter(c => c.type === 'email').map(c => c.id);
          for (const r of q.docsInCol.all(`boards/${br.id}/items`)) { const v = (JSON.parse(r.data).values || {}); if ((phone && pc.some(c => String(v[c] || '').replace(/\D/g, '').slice(-10) === phone)) || (email && ec.some(c => String(v[c] || '').toLowerCase() === email))) hits.push({ bid: br.id, iid: r.id }); } }
      }
      // something the rep sent themselves (direction: 'outbound') is only logged on the lead's timeline, never pinged
      const outbound = String(body.direction || '').toLowerCase() === 'outbound';
      if (!outbound) for (const h of hits.slice(0, 5)) { const r = q.doc.get(`boards/${h.bid}/items/${h.iid}`); if (!r) continue; const d = JSON.parse(r.data); buzz(h.bid, h.iid, null, d, user.id, { kind: k[0], text: k[1](String(d.name || 'A client').slice(0, 60)) }); }
      // kept for the item's "Calls & texts" timeline
      if (hooks.onEvent) try { hooks.onEvent(body, hits.slice(0, 5), user); } catch (e) { console.error('events:', e.message); }
      return send(res, 200, { ok: true, matched: hits.length });
    }
    if (p === '/api/v1/boards' && method === 'GET') return send(res, 200, q.docsInCol.all('boards').map(r => boardOut(r.id, JSON.parse(r.data))).sort((a, c) => a.name.localeCompare(c.name)));
    if (p === '/api/v1/search' && method === 'GET') {
      const qs = (url.searchParams.get('q') || '').toLowerCase(), phone = (url.searchParams.get('phone') || '').replace(/\D/g, '').slice(-10), email = (url.searchParams.get('email') || '').toLowerCase();
      if (!qs && !phone && !email) throw new HttpError(400, 'Add ?q=, ?phone= or ?email=');
      const hits = [];
      for (const br of q.docsInCol.all('boards')) {
        const b = { id: br.id, ...JSON.parse(br.data) };
        const phoneCols = b.columns.filter(c => c.type === 'phone').map(c => c.id), emailCols = b.columns.filter(c => c.type === 'email').map(c => c.id);
        for (const r of q.docsInCol.all(`boards/${b.id}/items`)) {
          const d = JSON.parse(r.data), v = d.values || {};
          const ok = (phone && phoneCols.some(c => String(v[c] || '').replace(/\D/g, '').slice(-10) === phone)) || (email && emailCols.some(c => String(v[c] || '').toLowerCase() === email)) || (qs && String(d.name || '').toLowerCase().includes(qs));
          if (ok) { hits.push(itemOut(b, r.id, d)); if (hits.length >= 50) return send(res, 200, hits); }
        }
      }
      return send(res, 200, hits);
    }
    const bm = /^\/api\/v1\/boards\/([^/]+)(?:\/items(?:\/([^/]+)(\/updates)?)?)?$/.exec(p);
    if (!bm) throw new HttpError(404, 'Unknown API address. See /developers.');
    const b = findBoard(decodeURIComponent(bm[1])); if (!b) throw new HttpError(404, 'No such board.');
    const [, , iid, upd] = bm;
    if (!p.includes('/items')) return send(res, 200, boardOut(b.id, b));
    if (!iid) {
      if (method === 'GET') {
        const g = url.searchParams.get('group'), since = url.searchParams.get('updated_since'), limit = Math.min(500, Number(url.searchParams.get('limit') || 100)), offset = Number(url.searchParams.get('offset') || 0);
        const gid = g ? groupId(b, g) : null;
        let rows = db.prepare('SELECT id, data, updated_at FROM docs WHERE col = ? ORDER BY updated_at DESC').all(`boards/${b.id}/items`);
        if (since) rows = rows.filter(r => r.updated_at > since);
        const items = rows.map(r => ({ r, d: JSON.parse(r.data) })).filter(x => !gid || x.d.group === gid);
        return send(res, 200, { total: items.length, items: items.slice(offset, offset + limit).map(x => ({ ...itemOut(b, x.r.id, x.d), updated_at: x.r.updated_at })) });
      }
      if (method === 'POST') { needWrite(); if (Number(req.headers['content-length'] || 0) > 256 * 1024) throw new HttpError(413, 'That item is too large (256 KB at most).'); const body = await readBody(req, 256 * 1024); const out = createItem(b, body, user); return send(res, 201, { ...itemOut(b, out.id, out.item), ...(out.stripped.length ? { skipped_locked: out.stripped } : {}) }); }
    }
    const path = `boards/${b.id}/items/${iid}`; const row = q.doc.get(path);
    if (!row) throw new HttpError(404, 'No such item on this board.');
    let item = JSON.parse(row.data);
    // a write reads the item again once the body is in: a change saved while the body was arriving is kept
    const fresh = () => { const r2 = q.doc.get(path); if (!r2) throw new HttpError(404, 'No such item on this board.'); item = JSON.parse(r2.data); };
    if (upd && method === 'POST') { needWrite(); const body = await readBody(req); if (!body.text) throw new HttpError(400, 'Send {"text": "…"}');
      fresh();
      item.updates = [...(item.updates || []), { at: now(), by: '', byName: body.author || user.name, text: String(body.text).slice(0, 20000) }];
      saveItem(b.id, iid, item, user); return send(res, 201, { ok: true }); }
    if (method === 'GET') return send(res, 200, { ...itemOut(b, iid, item), updates_list: item.updates || [], subitems: item.subitems || [] });
    if (method === 'PATCH') {
      needWrite(); const body = await readBody(req); const errors = [];
      fresh();
      const values = toValues(b, { ...(body.values || {}), ...(body.fields || {}) }, errors);
      let grp = item.group; if (body.group) { grp = groupId(b, body.group); if (!grp) errors.push(`No group called “${body.group}”.`); }
      if (errors.length) throw new HttpError(400, errors.join(' '));
      // columns an admin locked can't be changed through the API either
      const locked = lockedCols(null, b), bad = Object.keys(values).filter(k => locked.has(k) && JSON.stringify(values[k] ?? '') !== JSON.stringify((item.values || {})[k] ?? ''));
      if (bad.length) { if (lockError) throw lockError(b, new Set(bad)); throw new HttpError(403, 'That column is locked.'); }
      const next = { ...item, values: { ...(item.values || {}), ...values }, group: grp, ...(body.name ? { name: String(body.name) } : {}) };
      next.activity = [{ at: now(), by: user.id, text: `Changed by ${user.name}` }, ...(item.activity || [])].slice(0, 40);
      const notes = [];
      // only real changes set off rules (sending the value a column already has does nothing, like the app)
      for (const [cid, v] of Object.entries(values)) if (JSON.stringify(v ?? '') !== JSON.stringify((item.values || {})[cid] ?? '')) runRules(b, next, { type: 'value', col: cid, value: v }, user, notes, iid);
      if (grp !== item.group) runRules(b, next, { type: 'moved_group', group: grp }, user, notes, iid);
      saveItem(b.id, iid, next, user);
      sendNotes(b, iid, next, notes);
      return send(res, 200, itemOut(b, iid, next));
    }
    if (method === 'DELETE') { needWrite(); q.deleteDoc.run(path); broadcast({ op: 'delete', col: `boards/${b.id}/items`, id: iid }); itemChanged(path, item, null, user.id); return send(res, 200, { ok: true }); }
    throw new HttpError(405, 'Not allowed here.');
  }

  // ---------- admin screens (signed-in admins) ----------
  async function handleAdmin(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (user.role !== 'admin') throw new HttpError(403, 'Only admins can manage integrations.');
    if (p === '/api/admin/keys') {
      if (method === 'GET') return send(res, 200, db.prepare('SELECT id, name, prefix, scope, created_at, last_used, revoked FROM api_keys ORDER BY created_at DESC').all());
      if (method === 'POST') {
        const b = await readBody(req); const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Name the key after what will use it, like “n8n”.');
        const scope = b.scope === 'read' ? 'read' : 'write'; const key = 'ks_' + crypto.randomBytes(24).toString('base64url');
        db.prepare('INSERT INTO api_keys (id, name, prefix, hash, scope, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(rid('k_'), name, key.slice(0, 9), sha(key), scope, now(), user.id);
        return send(res, 201, { key, note: 'Copy this key now. It won’t be shown again.' });
      }
    }
    const km = /^\/api\/admin\/keys\/(k_[A-Za-z0-9_-]+)$/.exec(p);
    if (km && method === 'DELETE') { db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(km[1]); return send(res, 200, { ok: true }); }
    if (p === '/api/admin/hooks') {
      if (method === 'GET') return send(res, 200, db.prepare('SELECT id, kind, name, url, events, board, grp, token, dedupe, active, created_at, last_at, last_status, last_error FROM hooks ORDER BY created_at DESC').all().map(h => ({ ...h, events: JSON.parse(h.events || '[]') })));
      if (method === 'POST') {
        const b = await readBody(req); const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Give it a name.');
        if (b.kind === 'in') {
          const bd = findBoard(b.board); if (!bd) throw new HttpError(400, 'Pick the board new leads should go to.');
          if (b.group && !(bd.groups || []).some(g => g.id === b.group)) throw new HttpError(400, 'That group isn’t on the board.');
          const token = crypto.randomBytes(18).toString('base64url');
          db.prepare("INSERT INTO hooks (id, kind, name, token, board, grp, dedupe, created_at) VALUES (?, 'in', ?, ?, ?, ?, ?, ?)").run(rid('h_'), name, token, bd.id, b.group || null, b.dedupe || null, now());
          return send(res, 201, { ok: true });
        }
        const u = safeUrl(b.url); if (!u) throw new HttpError(400, 'Enter a public https:// address.');
        try { await netguard.checkUrl(u); } catch (e) { throw new HttpError(400, e.message + ' Enter a public https:// address.'); }
        const ev = (Array.isArray(b.events) ? b.events : []).filter(e => EVENTS.includes(e));
        // several webhooks to one tool (e.g. n8n) can share one signing secret, so the tool checks them all with one key
        const twin = b.sameSecretAs ? db.prepare("SELECT name, secret FROM hooks WHERE id = ? AND kind = 'out'").get(String(b.sameSecretAs)) : null;
        if (b.sameSecretAs && !twin) throw new HttpError(400, 'That webhook to share a secret with doesn’t exist.');
        const secret = twin ? twin.secret : crypto.randomBytes(24).toString('base64url');
        db.prepare("INSERT INTO hooks (id, kind, name, url, secret, events, board, created_at) VALUES (?, 'out', ?, ?, ?, ?, ?, ?)").run(rid('h_'), name, u, secret, JSON.stringify(ev), b.board || null, now());
        if (twin) return send(res, 201, { ok: true, sharedWith: twin.name, note: `Signed with the same secret as “${twin.name}”.` });
        return send(res, 201, { ok: true, secret, note: 'Use this secret to check the X-Solver-Signature header. It won’t be shown again.' });
      }
    }
    const hm = /^\/api\/admin\/hooks\/(h_[A-Za-z0-9_-]+)(\/test)?$/.exec(p);
    if (hm) {
      const h = db.prepare('SELECT * FROM hooks WHERE id = ?').get(hm[1]); if (!h) throw new HttpError(404, 'Not found.');
      if (hm[2] && method === 'POST') {
        if (h.kind !== 'out') throw new HttpError(400, 'Only outgoing webhooks can be tested.');
        const status = await deliver(h, { event: 'test', delivery: rid('d_'), at: now(), message: 'This is a test from Solver.ca.' });
        return send(res, 200, { status });
      }
      if (method === 'PATCH') { const b = await readBody(req); if (typeof b.active === 'boolean') db.prepare('UPDATE hooks SET active = ? WHERE id = ?').run(b.active ? 1 : 0, h.id); return send(res, 200, { ok: true }); }
      if (method === 'DELETE') { db.prepare('DELETE FROM hooks WHERE id = ?').run(h.id); return send(res, 200, { ok: true }); }
    }
    return false;
  }

  // ---------- "when a date arrives" reminders (Monday's date triggers) ----------
  // Checks every 10 minutes. A due reminder is written to the item's activity and sent as a reminder.due webhook.
  const TZ = process.env.KS_TIMEZONE || 'America/Toronto';
  const partsIn = (d, tz = TZ) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
  const zoneOk = z => { try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return true; } catch (e) { return false; } };
  // "2 day(s) before the date, at 09:00 America/Edmonton": the time and "today" are read in the rule's own time zone
  // (the workspace's when the rule names none). Returns what is due right now, or null when it isn't that time yet.
  function ruleDue(r, at) {
    const w = String(r.when || ''), t = /at (\d{1,2}):(\d{2})\s*([A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+|UTC)?/.exec(w);
    const tz = t && t[3] && zoneOk(t[3]) ? t[3] : TZ, p = partsIn(at, tz);
    const today = `${p.year}-${p.month}-${p.day}`, hhmm = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
    if (hhmm < (t ? `${t[1].padStart(2, '0')}:${t[2]}` : '09:00')) return null;
    const off = /(\d+)\s*day/.exec(w); const n = off ? Number(off[1]) * (/before/.test(w) ? 1 : /after/.test(w) ? -1 : 0) : 0;
    return { r, today, target: addDays(today, n) }; // target: the item date that is due today
  }
  // at: the time to check for (tests pass a fixed clock)
  function checkReminders(at = new Date()) {
    for (const br of q.docsInCol.all('boards')) {
      const b = { id: br.id, ...JSON.parse(br.data) };
      const due = (b.automations || []).filter(r => r.on !== false && r.trigger === 'date_arrives' && r.col && (r.mondayActive !== false || b.source !== 'monday')).map(r => ruleDue(r, at)).filter(Boolean);
      if (!due.length) continue;
      const quoted = [...new Set(due.map(x => JSON.stringify(x.target)))];
      for (const ir of q.docsInCol.all(`boards/${b.id}/items`)) { // the board's items are read once for all its rules
        if (!quoted.some(s => ir.data.includes(s))) continue; // no due date anywhere in this item
        const d = JSON.parse(ir.data), fired = [];
        for (const x of due) {
          const r = x.r;
          if ((d.values || {})[r.col] !== x.target || (d.reminded && d.reminded[r.id] === x.today)) continue;
          if (!(r.conditions || []).every(c => condOk(b, d, c))) continue; // "only if status is …" and the rest, like the app
          d.reminded = { ...(d.reminded || {}), [r.id]: x.today };
          d.activity = [{ at: now(), by: 'automation', text: `Reminder: ${r.title || 'date arrived'}` }, ...(d.activity || [])].slice(0, 40);
          fired.push(x);
        }
        if (!fired.length) continue;
        q.upsertDoc.run(`boards/${b.id}/items/${ir.id}`, `boards/${b.id}/items`, ir.id, JSON.stringify(d), now(), 'reminder');
        broadcast({ op: 'set', col: `boards/${b.id}/items`, id: ir.id, data: d });
        for (const { r, target } of fired) {
          sendNotes(b, ir.id, d, [...(r.actions || []).filter(a => a.type === 'notify').map(a => ({ to: a.to, message: a.message, title: r.title || 'Reminder', kind: 'reminder' })), ...((r.actions || []).some(a => a.type === 'webhook') ? [{ webhook: true, rule: r, via: 'reminder' }] : [])]);
          if (hooks.ruleRan) try { hooks.ruleRan(b.id, r.id, ir.id, d.name, `Reminder for ${target}`, 'reminder'); } catch (e) {}
          emit('reminder.due', b.id, ir.id, b, d, { reminder: { rule: r.title, column: ((b.columns || []).find(c => c.id === r.col) || {}).title, date: target, notify: (r.actions || []).filter(a => a.type === 'notify').map(a => ({ to: a.to, message: a.message })) } });
        }
      }
    }
  }
  if (process.env.KS_REMINDERS !== 'off') { setInterval(() => { try { checkReminders(); } catch (e) { console.error('reminders:', e.message); } }, 10 * 60 * 1000).unref(); setTimeout(() => { try { checkReminders(); } catch (e) {} }, 30000).unref(); }

  return { handleV1, handleAdmin, itemChanged, EVENTS, checkReminders, createItem, pressButton, emit, safeUrl, guestRules, sendNotes, parseNum, parseDay };
};
