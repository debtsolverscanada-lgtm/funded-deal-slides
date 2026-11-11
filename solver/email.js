// Email from a lead's card, sent from the rep's own Gmail through n8n's Gmail connector.
//
//   Solver.ca never holds anyone's Gmail password or Google token. It posts the email to an n8n webhook
//   (EMAIL_SEND_HOOK_URL, a long random URL kept only in the server's settings); n8n sends it with that rep's
//   Gmail connection and answers with Gmail's message and thread id. Solver.ca then logs it on the lead's Updates.
//   Replies: every few minutes Solver.ca asks a second n8n webhook (EMAIL_REPLY_HOOK_URL) for new messages in the
//   threads it started, and posts each reply on the lead. EMAIL_REPLY_SYNC=off stops that check.
//
//   Who sends as whom: an admin sets "Sends email as" for a person (Team & settings). Nobody else can send.
//   Never emailed: Junk/Unqualified (now or in the item's history), opted out / unsubscribed / do not contact,
//   referred, and "(copy)" items. Only the lead's own email address(es) can be the recipient.
'use strict';
const crypto = require('node:crypto');

module.exports = function email({ db, q, now, broadcast, HttpError, readBody, send, boardInfo, mustSee, itemVisible }) {
  try { db.exec('ALTER TABLE users ADD COLUMN email_from TEXT'); } catch (e) { /* already there */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, from_email TEXT NOT NULL, to_email TEXT NOT NULL,
      board TEXT NOT NULL, item TEXT NOT NULL, subject TEXT, message_id TEXT, thread_id TEXT, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_log_thread ON email_log(thread_id);
    CREATE INDEX IF NOT EXISTS email_log_at ON email_log(at);
    CREATE TABLE IF NOT EXISTS email_seen (message_id TEXT PRIMARY KEY, at TEXT NOT NULL);
  `);
  const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
  const sendUrl = () => String(process.env.EMAIL_SEND_HOOK_URL || '').trim();
  const replyUrl = () => String(process.env.EMAIL_REPLY_HOOK_URL || '').trim();
  const fromOf = user => { const r = db.prepare('SELECT email_from FROM users WHERE id = ?').get(user.id); const f = r && String(r.email_from || '').trim().toLowerCase(); return f && EMAIL.test(f) ? f : ''; };
  const sentRecently = db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE user_id = ? AND at > ?');
  const logIns = db.prepare('INSERT INTO email_log (id, at, user_id, from_email, to_email, board, item, subject, message_id, thread_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  function loadItem(user, bid, iid) {
    if (!ID.test(bid || '') || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid);
    const r = ID.test(iid || '') && q.doc.get(`boards/${bid}/items/${iid}`); if (!r) throw new HttpError(404, 'No such item.');
    const item = JSON.parse(r.data); if (!itemVisible(user, info, item)) throw new HttpError(404, 'No such item.');
    return { info, item, board: (() => { const b = q.doc.get('boards/' + bid); return b ? JSON.parse(b.data) : {}; })() };
  }
  const leadEmails = (board, item) => [...new Set((board.columns || []).filter(c => c.type === 'email')
    .flatMap(c => String((item.values || {})[c.id] || '').split(/[\s,;]+/)).map(x => x.trim().toLowerCase()).filter(x => EMAIL.test(x)))];

  // Why this lead must not be emailed (null when it's fine)
  const BAD = /junk|unqualified|opt(ed)?[\s-]*out|unsubscrib|do\s*not\s*(contact|email|call)|\bdnc\b|^stop$/i;
  function blockedReason(board, item) {
    if (/\(copy\)/i.test(String(item.name || ''))) return 'This is a “(copy)” item. Copies are never emailed.';
    const group = (board.groups || []).find(g => g.id === item.group);
    if (group && BAD.test(group.name)) return `This lead is in “${group.name}”, so it’s never emailed.`;
    if (group && /referr/i.test(group.name)) return 'This lead was referred, so it’s never emailed.';
    for (const c of board.columns || []) {
      const v = (item.values || {})[c.id]; if (v === undefined || v === null || v === '') continue;
      const label = c.type === 'status' || c.type === 'dropdown' ? String(((c.labels || []).find(l => String(l.id) === String(v)) || {}).label || v) : (c.type === 'checkbox' && /opt|unsub|dnc|do not/i.test(c.title) && v ? 'opted out' : '');
      if (label && BAD.test(label)) return `${c.title} is “${label}”, so this lead is never emailed.`;
      if (label && /referr/i.test(label)) return 'This lead was referred, so it’s never emailed.';
    }
    if ((item.activity || []).some(a => /junk|unqualified/i.test(String(a.text || '')))) return 'This lead was in Junk/Unqualified before, so it’s never emailed.';
    return null;
  }

  function addUpdate(bid, iid, upd, activityText) {
    const path = `boards/${bid}/items/${iid}`, r = q.doc.get(path); if (!r) return;
    const item = JSON.parse(r.data);
    item.updates = [...(item.updates || []), { id: 'u' + crypto.randomBytes(6).toString('hex'), at: now(), ...upd }];
    if (activityText) item.activity = [{ at: now(), by: upd.by || 'automation', text: activityText }, ...(item.activity || [])].slice(0, 40);
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), now(), upd.by || 'email');
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
  }

  async function postHook(url, body, ms) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((d && (d.error || d.message)) || `the email service answered ${r.status}`);
    return d || {};
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p === '/api/email/check' && method === 'GET') {
      const { board, item } = loadItem(user, url.searchParams.get('board'), url.searchParams.get('item'));
      const from = fromOf(user), canSend = user.role === 'admin' || user.role === 'member';
      return send(res, 200, { configured: !!sendUrl(), from, canSend, to: leadEmails(board, item), blocked: blockedReason(board, item), name: item.name || '' }), true;
    }
    if (p === '/api/email/send' && method === 'POST') {
      if (!(user.role === 'admin' || user.role === 'member')) throw new HttpError(403, 'Only team members can send email.');
      if (!sendUrl()) throw new HttpError(400, 'Email sending isn’t set up yet.');
      const from = fromOf(user); if (!from) throw new HttpError(400, 'An admin needs to set the Gmail address you send from (Team & settings).');
      const b = await readBody(req, 256 * 1024);
      const bid = String(b.board || ''), iid = String(b.item || '');
      const { board, item } = loadItem(user, bid, iid);
      const why = blockedReason(board, item); if (why) throw new HttpError(400, why);
      const to = String(b.to || '').trim().toLowerCase();
      if (!leadEmails(board, item).includes(to)) throw new HttpError(400, 'You can only email the address on this lead.');
      const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300), text = String(b.text || '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
      if (!subject) throw new HttpError(400, 'Add a subject.'); if (!text) throw new HttpError(400, 'Write a message.');
      if (sentRecently.get(user.id, new Date(Date.now() - 3600e3).toISOString()).n >= 60) throw new HttpError(429, 'That’s 60 emails in the last hour. Wait a bit before sending more.');
      const id = 'em_' + crypto.randomBytes(9).toString('base64url');
      let out;
      try { out = await postHook(sendUrl(), { id, from, to, subject, text, lead: String(item.name || '').slice(0, 200) }, 30000); }
      catch (e) { logIns.run(id, now(), user.id, from, to, bid, iid, subject, null, null, 'failed'); console.error('email send:', e.message); throw new HttpError(502, 'The email didn’t send: ' + String(e.message || 'the email service didn’t answer').slice(0, 200)); }
      if (out.ok === false) { logIns.run(id, now(), user.id, from, to, bid, iid, subject, null, null, 'failed'); throw new HttpError(502, 'The email didn’t send: ' + String(out.error || 'Gmail refused it').slice(0, 200)); }
      logIns.run(id, now(), user.id, from, to, bid, iid, subject, String(out.id || '') || null, String(out.threadId || '') || null, 'sent');
      addUpdate(bid, iid, { by: user.id, byName: user.name || user.email, text: `📧 Email sent to ${to}\nSubject: ${subject}\n\n${text}`, email: { dir: 'out', to, from, subject, threadId: out.threadId || null } }, `Emailed ${to}: “${subject.slice(0, 80)}”`);
      return send(res, 200, { ok: true, threadId: out.threadId || null }), true;
    }
    return false;
  }

  // ---------- replies: ask n8n for new messages in the threads we started (last 30 days), every 3 minutes ----------
  let busy = false;
  async function checkReplies() {
    if (busy || !replyUrl() || String(process.env.EMAIL_REPLY_SYNC || '').toLowerCase() === 'off') return;
    busy = true;
    try {
      const rows = db.prepare("SELECT from_email, thread_id, board, item, to_email FROM email_log WHERE status = 'sent' AND thread_id IS NOT NULL AND at > ? GROUP BY thread_id").all(new Date(Date.now() - 30 * 864e5).toISOString());
      const byFrom = new Map(); rows.forEach(r => { if (!byFrom.has(r.from_email)) byFrom.set(r.from_email, []); byFrom.get(r.from_email).push(r); });
      for (const [from, list] of byFrom) {
        let d; try { d = await postHook(replyUrl(), { from, threads: list.map(r => r.thread_id).slice(0, 100) }, 60000); } catch (e) { console.error('email replies:', e.message); continue; }
        for (const m of Array.isArray(d.messages) ? d.messages : []) {
          const mid = String(m.id || ''), tid = String(m.threadId || ''); if (!mid || !tid) continue;
          const sender = String(m.from || '').toLowerCase(); if (sender.includes(from)) continue; // our own message in the thread
          if (db.prepare('SELECT 1 FROM email_seen WHERE message_id = ?').get(mid)) continue;
          db.prepare('INSERT OR IGNORE INTO email_seen (message_id, at) VALUES (?, ?)').run(mid, now());
          const row = list.find(r => r.thread_id === tid); if (!row) continue;
          const snippet = String(m.text || m.snippet || '').replace(/\s+\n/g, '\n').trim().slice(0, 4000);
          addUpdate(row.board, row.item, { by: 'email', byName: 'Email reply', text: `↩️ Reply from ${String(m.from || row.to_email).slice(0, 200)}${m.subject ? `\nSubject: ${String(m.subject).slice(0, 300)}` : ''}\n\n${snippet}`, email: { dir: 'in', threadId: tid } }, 'Lead replied by email');
        }
      }
    } finally { busy = false; }
  }
  const firstMs = Number(process.env.EMAIL_REPLY_FIRST_MS) || 45e3, everyMs = Math.max(30e3, Number(process.env.EMAIL_REPLY_EVERY_MS) || 3 * 60e3);
  setTimeout(() => { checkReplies().catch(e => console.error('email replies:', e.message)); setInterval(() => checkReplies().catch(e => console.error('email replies:', e.message)), everyMs).unref(); }, firstMs).unref();

  return { handle, checkReplies, blockedReason, leadEmails };
};
