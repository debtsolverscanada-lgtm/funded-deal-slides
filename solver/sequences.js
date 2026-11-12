// Email sequences (drips) and "when status changes, send an email" — the ones Monday runs today, rebuilt here.
//
//   A sequence: which boards, what puts a lead in it (a brand-new lead, or a status changing to a label, or a person
//   adding it by hand), and its steps (wait, then send this email). Emails go out through the same pipeline as every
//   other email (email.js): from the board's rep (or a fixed sender, e.g. Brandon on Clients), logged on the lead,
//   and never to Junk/Unqualified, opted-out, referred or "(copy)" leads.
//   A lead leaves a sequence when it replies (email or text), when it becomes blocked, when it's deleted, or when
//   someone presses Stop. Steps only send 8am–8pm in the lead's province (Mon–Sat).
//   Imported sequences start OFF: Monday is still sending its own copies, so each one is switched on here only after
//   its Monday twin is switched off. SEQUENCES=off stops all sending at once.
'use strict';
const crypto = require('node:crypto');

module.exports = function sequences({ db, q, now, HttpError, readBody, send, canSee, boardInfo }, mail) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sequences (id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT);
    CREATE TABLE IF NOT EXISTS seq_enroll (
      id TEXT PRIMARY KEY, seq TEXT NOT NULL, board TEXT NOT NULL, item TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
      next_at TEXT, status TEXT NOT NULL, reason TEXT, started_at TEXT NOT NULL, by TEXT, tries INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS seq_enroll_due ON seq_enroll(status, next_at);
    CREATE INDEX IF NOT EXISTS seq_enroll_item ON seq_enroll(board, item);
  `);
  const env = k => String(process.env[k] || '').trim();
  const off = () => env('SEQUENCES').toLowerCase() === 'off';
  const rid = p => p + crypto.randomBytes(8).toString('base64url');
  const isAdmin = u => u && u.role === 'admin';
  const getSeq = id => { const r = db.prepare('SELECT * FROM sequences WHERE id = ?').get(id); return r ? { id: r.id, active: !!r.active, ...JSON.parse(r.data), updatedAt: r.updated_at } : null; };
  const allSeqs = () => db.prepare('SELECT * FROM sequences ORDER BY rowid').all().map(r => ({ id: r.id, active: !!r.active, ...JSON.parse(r.data), updatedAt: r.updated_at }));
  const boardDoc = bid => { const r = q.doc.get('boards/' + bid); return r ? JSON.parse(r.data) : null; };
  const itemDoc = (bid, iid) => { const r = q.doc.get(`boards/${bid}/items/${iid}`); return r ? JSON.parse(r.data) : null; };
  const statusLabel = (b, colId, v) => { const c = (b.columns || []).find(x => x.id === colId); if (!c) return ''; const l = (c.labels || []).find(x => String(x.id) === String(v)); return String((l && l.label) ?? v ?? ''); };

  // ---------- cleaning what an admin saves ----------
  function clean(d) {
    const s = String;
    const out = { name: s(d.name || '').trim().slice(0, 120), boards: [...new Set((Array.isArray(d.boards) ? d.boards : []).map(String))].slice(0, 50),
      trigger: { type: ['created', 'status', 'group', 'manual'].includes(d.trigger && d.trigger.type) ? d.trigger.type : 'manual', col: s((d.trigger || {}).col || '').slice(0, 100), label: s((d.trigger || {}).label || '').slice(0, 120), group: s((d.trigger || {}).group || '').slice(0, 100), inGroup: s((d.trigger || {}).inGroup || '').slice(0, 100) },
      from: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s(d.from || '').trim()) ? s(d.from).trim().toLowerCase() : '',
      footer: d.footer !== false, stopOnReply: d.stopOnReply !== false,
      steps: (Array.isArray(d.steps) ? d.steps : []).slice(0, 20).map(x => ({ waitDays: Math.max(0, Math.min(365, Number(x.waitDays) || 0)), waitHours: Math.max(0, Math.min(23, Number(x.waitHours) || 0)), subject: s(x.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300), body: s(x.body || '').replace(/\r\n/g, '\n').slice(0, 20000) })),
      source: d.source && typeof d.source === 'object' ? { monday: s(d.source.monday || '').slice(0, 100), kind: s(d.source.kind || '').slice(0, 40), board: s(d.source.board || '').slice(0, 40) } : null,
      note: s(d.note || '').slice(0, 500) };
    if (!out.name) throw new HttpError(400, 'Give the sequence a name.');
    if (!out.boards.length) throw new HttpError(400, 'Pick at least one board.');
    if (!out.steps.length) throw new HttpError(400, 'Add at least one email.');
    out.steps.forEach((x, k) => { if (!x.subject.trim() || !x.body.trim()) throw new HttpError(400, `Email ${k + 1} needs a subject and a message.`); });
    if (out.trigger.type === 'status' && (!out.trigger.col || !out.trigger.label)) throw new HttpError(400, 'Pick the status and the label that starts it.');
    if (out.trigger.type === 'group' && !out.trigger.group) throw new HttpError(400, 'Pick the group that starts it.');
    return out;
  }

  // ---------- placeholders ----------
  const firstName = n => { let x = String(n || '').trim().split(/\s+/)[0] || 'there'; x = x.replace(/[^\p{L}'-]/gu, '') || 'there'; return x === x.toLowerCase() || x === x.toUpperCase() ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x; };
  function fill(tpl, b, item, from) {
    const rep = (mail.nameForFrom(from) || '').split(/\s+/)[0] || '';
    return String(tpl || '')
      .replace(/\{\s*pulse\.name\s*\}/gi, String(item.name || '').trim() || 'there')
      .replace(/\{\s*first\s*name\s*\}/gi, firstName(item.name))
      .replace(/\{\s*name\s*\}/gi, String(item.name || '').trim() || 'there')
      .replace(/\{\s*rep\s*\}/gi, rep)
      .replace(/\{\s*pulse\.([a-z0-9_]+)\s*\}/gi, (m, id) => { const c = (b.columns || []).find(x => x.id === id); if (!c) return ''; const v = (item.values || {})[id]; return c.type === 'status' ? statusLabel(b, id, v) : String(v ?? ''); });
  }
  const company = b => /mortgage\s*solver/i.test(((b.workspace || {}).name) || '') ? 'MortgageSolvers' : 'DebtSolvers Canada';

  // ---------- when to send ----------
  const TZ = { AB: 'America/Edmonton', BC: 'America/Vancouver', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto', QC: 'America/Toronto', NB: 'America/Halifax', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns' };
  const provOf = (b, item) => { const c = (b.columns || []).find(x => /province|prov\b|state/i.test(x.title || '')); const u = String(c ? (item.values || {})[c.id] || '' : '').toUpperCase(); const m = { ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', SASK: 'SK', MANITOBA: 'MB', ONTARIO: 'ON', QUEBEC: 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', PRINCE: 'PE', NEWFOUNDLAND: 'NL' }; for (const k in m) if (u.startsWith(k)) return m[k]; return TZ[u.trim()] ? u.trim() : ''; };
  const localParts = (prov, t) => { const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ[prov] || 'America/Toronto', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(t)); return { h: Number(f.find(p => p.type === 'hour').value), wd: f.find(p => p.type === 'weekday').value }; };
  const okToSend = (prov, t = Date.now()) => { if (env('SEQ_HOURS') === 'any') return true; const { h, wd } = localParts(prov, t); return wd !== 'Sun' && h >= 8 && h < 20; };
  const waitMs = st => (st.waitDays * 24 + st.waitHours) * 3600e3;

  // ---------- enrolling ----------
  function enroll(seq, bid, iid, by) {
    if (db.prepare("SELECT 1 FROM seq_enroll WHERE seq = ? AND board = ? AND item = ?").get(seq.id, bid, iid)) return null; // never twice
    const id = rid('se_'), first = seq.steps[0];
    db.prepare('INSERT INTO seq_enroll (id, seq, board, item, step, next_at, status, started_at, by) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)')
      .run(id, seq.id, bid, iid, new Date(Date.now() + waitMs(first)).toISOString(), 'active', now(), by || 'auto');
    return id;
  }
  const stop = (id, reason) => db.prepare("UPDATE seq_enroll SET status = 'stopped', reason = ?, next_at = NULL WHERE id = ? AND status = 'active'").run(String(reason || '').slice(0, 200), id);

  // Called for every item save (Monday copy, lead links, people): start sequences whose trigger just happened
  function onItem(bid, iid, before, after) {
    try {
      if (!after) { for (const e of db.prepare("SELECT id FROM seq_enroll WHERE board = ? AND item = ? AND status = 'active'").all(bid, iid)) stop(e.id, 'lead deleted'); return; }
      const seqs = allSeqs().filter(s => s.active && s.boards.includes(String(bid)) && s.trigger.type !== 'manual'); if (!seqs.length) return;
      const b = boardDoc(bid); if (!b) return;
      for (const s of seqs) {
        if (s.trigger.type === 'created') {
          if (before) continue;
          const created = Date.parse(after.createdAt || '') || Date.now(); if (Date.now() - created > 6 * 3600e3) continue; // old item copied in late
          if (db.prepare("SELECT 1 FROM docs WHERE id = ? AND col LIKE 'boards/%/items' AND col != ?").get(String(iid), `boards/${bid}/items`)) continue; // moved here
          if (s.trigger.inGroup && after.group !== s.trigger.inGroup) continue; // only new leads in that group
          enroll(s, bid, iid, 'auto: new lead');
        } else if (s.trigger.type === 'group') {
          if (before && before.group !== after.group && after.group === s.trigger.group) { const g = (b.groups || []).find(x => x.id === after.group); enroll(s, bid, iid, `auto: moved to ${g ? g.name : 'group'}`); }
        } else if (s.trigger.type === 'status') {
          const was = before ? statusLabel(b, s.trigger.col, (before.values || {})[s.trigger.col]) : '';
          const is = statusLabel(b, s.trigger.col, (after.values || {})[s.trigger.col]);
          if (is && is.toLowerCase() === s.trigger.label.toLowerCase() && was.toLowerCase() !== is.toLowerCase()) enroll(s, bid, iid, `auto: status → ${is}`);
        }
      }
    } catch (e) { console.error('sequences onItem:', e.message); }
  }

  // ---------- sending, every minute ----------
  let busy = false;
  async function tick() {
    if (busy || off()) return; busy = true;
    try {
      const due = db.prepare("SELECT * FROM seq_enroll WHERE status = 'active' AND next_at <= ? ORDER BY next_at LIMIT 25").all(new Date().toISOString());
      for (const e of due) {
        const seq = getSeq(e.seq); if (!seq) { stop(e.id, 'sequence deleted'); continue; }
        if (!seq.active) continue; // paused: keeps its place
        const b = boardDoc(e.board), item = itemDoc(e.board, e.item);
        if (!b || !item) { stop(e.id, 'lead deleted'); continue; }
        const why = mail.blockedReason(b, item); if (why) { stop(e.id, why.replace(/, so .*$/, '').replace(/\.$/, '')); continue; }
        if (seq.stopOnReply && (item.updates || []).some(u => (u.by === 'email' || u.by === 'sms' || /^Incoming Email/i.test(String(u.text || ''))) && String(u.at || '') > e.started_at)) { stop(e.id, 'the lead replied'); continue; }
        const prov = provOf(b, item);
        if (!okToSend(prov)) { db.prepare('UPDATE seq_enroll SET next_at = ? WHERE id = ?').run(new Date(Date.now() + 30 * 60e3).toISOString(), e.id); continue; }
        const st = seq.steps[e.step]; if (!st) { db.prepare("UPDATE seq_enroll SET status = 'done', next_at = NULL WHERE id = ?").run(e.id); continue; }
        const to = mail.leadEmails(b, item)[0]; if (!to) { stop(e.id, 'no email address'); continue; }
        const from = seq.from || mail.sendFromFor({ id: '-' }, e.board); if (!from) { stop(e.id, 'no sending address for this board'); continue; }
        const text = fill(st.body, b, item, from) + (seq.footer ? `\n\n--\n${company(b)}\nIf you’d rather not get these emails, reply UNSUBSCRIBE.` : '');
        try {
          await mail.sendEmailNow({ user: { id: 'sequence', name: `“${seq.name}” step ${e.step + 1}`, email: '' }, from, bid: e.board, iid: e.item, to, subject: fill(st.subject, b, item, from), text });
          const nx = seq.steps[e.step + 1];
          if (nx) db.prepare('UPDATE seq_enroll SET step = step + 1, next_at = ?, tries = 0 WHERE id = ?').run(new Date(Date.now() + Math.max(waitMs(nx), 60e3)).toISOString(), e.id);
          else db.prepare("UPDATE seq_enroll SET step = step + 1, status = 'done', next_at = NULL WHERE id = ?").run(e.id);
        } catch (err) {
          const tries = e.tries + 1;
          if (tries >= 3) stop(e.id, 'email failed 3 times: ' + String(err.message).slice(0, 120));
          else db.prepare('UPDATE seq_enroll SET tries = ?, next_at = ? WHERE id = ?').run(tries, new Date(Date.now() + 20 * 60e3).toISOString(), e.id);
        }
      }
    } catch (e) { console.error('sequences tick:', e.message); } finally { busy = false; }
  }
  const timer = setInterval(() => tick(), Number(env('SEQUENCE_TICK_MS')) || 60e3); timer.unref();

  // ---------- API ----------
  const outSeq = s => { const c = db.prepare("SELECT status, COUNT(*) AS n FROM seq_enroll WHERE seq = ? GROUP BY status").all(s.id); const n = k => (c.find(x => x.status === k) || {}).n || 0; return { ...s, counts: { active: n('active'), done: n('done'), stopped: n('stopped') } }; };
  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/seq')) return false;
    if (p === '/api/seq' && method === 'GET') {
      const list = allSeqs().filter(s => isAdmin(user) || s.boards.some(bid => { const i = boardInfo(bid); return i && canSee(user, i.access); }));
      return send(res, 200, { sequences: list.map(outSeq), paused: off() }), true;
    }
    let m = /^\/api\/seq\/([A-Za-z0-9_-]{3,60})$/.exec(p);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      if (!isAdmin(user)) throw new HttpError(403, 'Only admins change sequences.');
      if (method === 'DELETE') { db.prepare('DELETE FROM sequences WHERE id = ?').run(m[1]); db.prepare("UPDATE seq_enroll SET status = 'stopped', reason = 'sequence deleted', next_at = NULL WHERE seq = ? AND status = 'active'").run(m[1]); return send(res, 200, { ok: true }), true; }
      const b = await readBody(req, 512 * 1024), d = clean(b), was = getSeq(m[1]);
      const active = b.active === undefined ? (was ? was.active : false) : !!b.active;
      db.prepare('INSERT INTO sequences (id, data, active, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, active = excluded.active, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
        .run(m[1], JSON.stringify(d), active ? 1 : 0, now(), user.id);
      return send(res, 200, { ok: true, sequence: outSeq(getSeq(m[1])) }), true;
    }
    m = /^\/api\/seq\/([A-Za-z0-9_-]{3,60})\/active$/.exec(p);
    if (m && method === 'POST') {
      if (!isAdmin(user)) throw new HttpError(403, 'Only admins turn sequences on or off.');
      const b = await readBody(req, 4096); if (!getSeq(m[1])) throw new HttpError(404, 'No such sequence.');
      db.prepare('UPDATE sequences SET active = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(b.active ? 1 : 0, now(), user.id, m[1]);
      return send(res, 200, { ok: true }), true;
    }
    m = /^\/api\/seq\/([A-Za-z0-9_-]{3,60})\/enrolled$/.exec(p);
    if (m && method === 'GET') {
      const s = getSeq(m[1]); if (!s) throw new HttpError(404, 'No such sequence.');
      const rows = db.prepare('SELECT * FROM seq_enroll WHERE seq = ? ORDER BY started_at DESC LIMIT 300').all(m[1]).filter(e => { const i = boardInfo(e.board); return i && canSee(user, i.access); })
        .map(e => ({ id: e.id, board: e.board, item: e.item, name: (itemDoc(e.board, e.item) || {}).name || '(deleted)', step: e.step, of: s.steps.length, status: e.status, reason: e.reason, next: e.next_at, started: e.started_at }));
      return send(res, 200, { rows }), true;
    }
    if (p === '/api/seq/item' && method === 'GET') {
      const bid = url.searchParams.get('board') || '', iid = url.searchParams.get('item') || '';
      mail.loadItem(user, bid, iid);
      const rows = db.prepare('SELECT * FROM seq_enroll WHERE board = ? AND item = ? ORDER BY started_at DESC').all(bid, iid).map(e => { const s = getSeq(e.seq); return { id: e.id, seq: e.seq, name: s ? s.name : '(deleted)', step: e.step, of: s ? s.steps.length : 0, status: e.status, reason: e.reason, next: e.next_at, active: !!(s && s.active) }; });
      const can = allSeqs().filter(s => s.boards.includes(bid)).map(s => ({ id: s.id, name: s.name, active: s.active, steps: s.steps.length }));
      return send(res, 200, { rows, available: can }), true;
    }
    if (p === '/api/seq/enroll' && method === 'POST') {
      const b = await readBody(req, 4096), s = getSeq(String(b.seq || '')); if (!s) throw new HttpError(404, 'No such sequence.');
      const bid = String(b.board || ''), iid = String(b.item || ''); const { board, item } = mail.loadItem(user, bid, iid);
      if (!s.boards.includes(bid)) throw new HttpError(400, 'That sequence isn’t set up for this board.');
      const why = mail.blockedReason(board, item); if (why) throw new HttpError(400, why);
      if (!mail.leadEmails(board, item).length) throw new HttpError(400, 'This lead has no email address.');
      const id = enroll(s, bid, iid, user.name || user.email); if (!id) throw new HttpError(400, 'This lead has already been in that sequence.');
      return send(res, 200, { ok: true, id, active: s.active }), true;
    }
    if (p === '/api/seq/stop' && method === 'POST') {
      const b = await readBody(req, 4096), e = db.prepare('SELECT * FROM seq_enroll WHERE id = ?').get(String(b.id || '')); if (!e) throw new HttpError(404, 'Not found.');
      mail.loadItem(user, e.board, e.item); stop(e.id, 'stopped by ' + (user.name || user.email));
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }
  return { handle, onItem, tick, _clean: clean };
};
