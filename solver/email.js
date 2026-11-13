// Email and texts from a lead's card, sent from the rep's own Gmail / RingCentral line through n8n.
//
//   Solver.ca never holds anyone's Gmail or RingCentral login. It posts the message to an n8n webhook (a long
//   random URL kept only in the server's settings), n8n sends it with that rep's connection and answers with the
//   message id. Solver.ca logs it on the lead's Updates.
//     EMAIL_SEND_HOOK_URL / EMAIL_REPLY_HOOK_URL   Gmail send / "messages in these threads"
//     TEXT_SEND_HOOK_URL  / TEXT_REPLY_HOOK_URL    RingCentral send / "texts that came in since"
//   Replies are checked every few minutes and posted on the lead (EMAIL_REPLY_SYNC=off stops both checks).
//   A reply of STOP (texts) or UNSUBSCRIBE (email) opts that number / address out for good.
//
//   Who sends as whom: an admin sets "Sends email as" for a person (Team & settings); the same address picks the
//   rep's RingCentral line in n8n. Never messaged: Junk/Unqualified (now or before), opted out / unsubscribed / do not
//   contact, referred, and "(copy)" items. Only the lead's own address / number can be the recipient.
'use strict';
const crypto = require('node:crypto');

module.exports = function email({ db, q, now, broadcast, HttpError, readBody, send, boardInfo, mustSee, itemVisible, integHooks = {} }) {
  try { db.exec('ALTER TABLE users ADD COLUMN email_from TEXT'); } catch (e) { /* already there */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, from_email TEXT NOT NULL, to_email TEXT NOT NULL,
      board TEXT NOT NULL, item TEXT NOT NULL, subject TEXT, message_id TEXT, thread_id TEXT, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_log_thread ON email_log(thread_id);
    CREATE INDEX IF NOT EXISTS email_log_at ON email_log(at);
    CREATE TABLE IF NOT EXISTS email_seen (message_id TEXT PRIMARY KEY, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS text_log (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, from_email TEXT NOT NULL, to_phone TEXT NOT NULL,
      board TEXT NOT NULL, item TEXT NOT NULL, message_id TEXT, status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS text_log_phone ON text_log(to_phone, at);
    CREATE TABLE IF NOT EXISTS outreach_optout (value TEXT PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, source TEXT);
    CREATE TABLE IF NOT EXISTS outreach_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
  const env = k => String(process.env[k] || '').trim();
  const fromOf = user => { const r = db.prepare('SELECT email_from FROM users WHERE id = ?').get(user.id); const f = r && String(r.email_from || '').trim().toLowerCase(); return f && EMAIL.test(f) ? f : ''; };
  const canSendRole = user => !!user && user.role !== 'viewer' && (user.role === 'admin' || user.role === 'member' || !!fromOf(user));
  // A board's sender: the one non-admin person on the board's access list who has a sending address (Mariel on
  // Mariel Leads). Anyone who can see that board emails and texts as that rep; a board with no rep uses the
  // sender's own address.
  const lc = s => String(s || '').trim().toLowerCase();
  function boardFrom(bid) {
    const r = q.doc.get('boards/' + bid); if (!r) return '';
    let members = []; try { members = ((JSON.parse(r.data).access || {}).members || []).map(lc); } catch (e) { return ''; }
    if (!members.length) return '';
    const froms = new Set();
    for (const u of db.prepare("SELECT email, role, email_from FROM users WHERE email_from IS NOT NULL AND email_from != '' AND role != 'admin'").all())
      if (members.includes(lc(u.email)) && EMAIL.test(lc(u.email_from))) froms.add(lc(u.email_from));
    return froms.size === 1 ? [...froms][0] : '';
  }
  // viewers never send; a guest sends only once an admin gave them their own address
  // anyone who can see a rep's board sends as that rep (the owner's rule); viewers never send
  const sendFromFor = (user, bid) => !user || user.role === 'viewer' ? '' : boardFrom(bid) || fromOf(user);
  const nameForFrom = from => (db.prepare('SELECT name FROM users WHERE lower(email_from) = ?').get(lc(from)) || {}).name || '';
  const asNote = (user, from) => from && from !== fromOf(user) ? `\n(sent by ${user.name || user.email} as ${nameForFrom(from) || from})` : '';
  const emailLog = db.prepare('INSERT INTO email_log (id, at, user_id, from_email, to_email, board, item, subject, message_id, thread_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const textLog = db.prepare('INSERT INTO text_log (id, at, user_id, from_email, to_phone, board, item, message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const rid = p => p + crypto.randomBytes(9).toString('base64url');
  // "Connect Gmail" (gmail.js): a rep who linked their mailbox in Solver.ca sends straight from it; others go through n8n
  const gmail = require('./gmail.js')({ db, now, HttpError, send });
  const emailReady = from => gmail.hasFor(from) || !!env('EMAIL_SEND_HOOK_URL');

  // ---------- opt-outs ----------
  const phone10 = s => { const d = String(s || '').replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, '').replace(/\D/g, ''); /* "(403) 555-7777 x5": the extension isn't part of the number */ const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? t : ''; };
  const optOut = (value, kind, source) => { if (value) db.prepare('INSERT OR IGNORE INTO outreach_optout (value, kind, at, source) VALUES (?, ?, ?, ?)').run(String(value).toLowerCase(), kind, now(), source || null); };
  const isOptedOut = value => !!(value && db.prepare('SELECT 1 FROM outreach_optout WHERE value = ?').get(String(value).toLowerCase()));

  function loadItem(user, bid, iid) {
    if (!ID.test(bid || '') || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid);
    const r = ID.test(iid || '') && q.doc.get(`boards/${bid}/items/${iid}`); if (!r) throw new HttpError(404, 'No such item.');
    const item = JSON.parse(r.data); if (!itemVisible(user, info, item)) throw new HttpError(404, 'No such item.');
    return { info, item, board: (() => { const b = q.doc.get('boards/' + bid); return b ? JSON.parse(b.data) : {}; })() };
  }
  const leadEmails = (board, item) => [...new Set((board.columns || []).filter(c => c.type === 'email')
    .flatMap(c => String((item.values || {})[c.id] || '').split(/[\s,;]+/)).map(x => x.trim().toLowerCase()).filter(x => EMAIL.test(x)))];
  const leadPhones = (board, item) => [...new Set((board.columns || []).filter(c => c.type === 'phone' || /phone|mobile|cell/i.test(c.title || ''))
    .map(c => phone10((item.values || {})[c.id])).filter(Boolean))];

  // Why this lead must not be messaged (null when it's fine)
  const BAD = /junk|unqualified|opt(ed)?[\s-]*out|unsubscrib|do\s*not\s*(contact|email|call|text)|\bdnc\b|^stop$/i;
  function blockedReason(board, item) {
    if (/\(copy\)/i.test(String(item.name || ''))) return 'This is a “(copy)” item. Copies are never messaged.';
    const group = (board.groups || []).find(g => g.id === item.group);
    if (group && BAD.test(group.name)) return `This lead is in “${group.name}”, so it’s never messaged.`;
    if (group && /referr/i.test(group.name)) return 'This lead was referred, so it’s never messaged.';
    for (const c of board.columns || []) {
      const v = (item.values || {})[c.id]; if (v === undefined || v === null || v === '') continue;
      const label = c.type === 'status' || c.type === 'dropdown' ? String(((c.labels || []).find(l => String(l.id) === String(v)) || {}).label || v) : (c.type === 'checkbox' && /opt|unsub|dnc|do not/i.test(c.title) && v ? 'opted out' : '');
      if (label && BAD.test(label)) return `${c.title} is “${label}”, so this lead is never messaged.`;
      if (label && /referr/i.test(label)) return 'This lead was referred, so it’s never messaged.';
    }
    if (item.wasJunk || (item.activity || []).some(a => /junk|unqualified/i.test(String(a.text || '')))) return 'This lead was in Junk/Unqualified before, so it’s never messaged.';
    if (leadEmails(board, item).some(isOptedOut) || leadPhones(board, item).some(isOptedOut)) return 'This lead opted out (STOP or unsubscribe), so it’s never messaged.';
    return null;
  }

  function addUpdate(bid, iid, upd, activityText) {
    const path = `boards/${bid}/items/${iid}`, r = q.doc.get(path); if (!r) return;
    const item = JSON.parse(r.data);
    const nu = { id: 'u' + crypto.randomBytes(6).toString('hex'), at: now(), ...upd };
    item.updates = [...(item.updates || []), nu];
    if (activityText) item.activity = [{ at: now(), by: upd.by || 'automation', text: activityText }, ...(item.activity || [])].slice(0, 40);
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), now(), upd.by || 'outreach');
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
    if (integHooks.updateAdded) { try { integHooks.updateAdded(bid, iid, nu); } catch (e) { /* write-back only */ } }
  }

  async function postHook(url, body, ms) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error((d && (d.error || d.message)) || `the sending service answered ${r.status}`);
    return d || {};
  }

  // One email / one text to one lead, logged on the lead. Throws an Error with a plain message when it didn't go.
  async function sendEmailNow({ user, from, bid, iid, to, subject, text, blastId }) {
    const id = rid('em_');
    let out;
    try { out = gmail.hasFor(from) ? await gmail.sendMail(from, { to, subject, text, name: user.name }) : await postHook(env('EMAIL_SEND_HOOK_URL'), { id, from, to, subject, text }, 30000); }
    catch (e) { emailLog.run(id, now(), user.id, from, to, bid, iid, subject, null, null, 'failed'); throw new Error(String(e.message || 'the email service didn’t answer').slice(0, 200)); }
    if (out.ok === false) { emailLog.run(id, now(), user.id, from, to, bid, iid, subject, null, null, 'failed'); throw new Error(String(out.error || 'Gmail refused it').slice(0, 200)); }
    emailLog.run(id, now(), user.id, from, to, bid, iid, subject, String(out.id || '') || null, String(out.threadId || '') || null, 'sent');
    addUpdate(bid, iid, { by: user.id, byName: user.name || user.email, text: `📧 ${blastId ? 'Mass email' : 'Email'} sent to ${to}${asNote(user, from)}\nSubject: ${subject}\n\n${text}`, email: { dir: 'out', to, from, subject, threadId: out.threadId || null } }, `Emailed ${to}: “${subject.slice(0, 80)}”`);
    return out;
  }
  async function sendTextNow({ user, from, bid, iid, to10, text, blastId }) {
    const id = rid('tx_');
    let out;
    try { out = await postHook(env('TEXT_SEND_HOOK_URL'), { id, from, to: '+1' + to10, text }, 30000); }
    catch (e) { textLog.run(id, now(), user.id, from, to10, bid, iid, null, 'failed'); throw new Error(String(e.message || 'the texting service didn’t answer').slice(0, 200)); }
    if (out.ok === false) { textLog.run(id, now(), user.id, from, to10, bid, iid, null, 'failed'); throw new Error(String(out.error || 'RingCentral refused it').slice(0, 200)); }
    textLog.run(id, now(), user.id, from, to10, bid, iid, String(out.id || '') || null, 'sent');
    addUpdate(bid, iid, { by: user.id, byName: user.name || user.email, text: `💬 ${blastId ? 'Mass text' : 'Text'} sent to ${to10.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}${asNote(user, from)}\n\n${text}`, sms: { dir: 'out', to: to10 } }, 'Texted the lead');
    return out;
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p.startsWith('/api/gmail/')) return gmail.handle(req, res, url, user);
    if (p === '/api/email/check' && method === 'GET') {
      const { board, item } = loadItem(user, url.searchParams.get('board'), url.searchParams.get('item'));
      const sf = sendFromFor(user, url.searchParams.get('board'));
      return send(res, 200, { configured: emailReady(sf), gmail: gmail.on() ? (gmail.mine(user.id) || false) : null, textConfigured: !!env('TEXT_SEND_HOOK_URL'), from: sf, canSend: !!sf, fromName: nameForFrom(sf), asRep: !!sf && sf !== fromOf(user), boardRep: !!boardFrom(url.searchParams.get('board')), to: leadEmails(board, item), phones: leadPhones(board, item), blocked: blockedReason(board, item), name: item.name || '' }), true;
    }
    if (p === '/api/email/send' && method === 'POST') {
      const b = await readBody(req, 256 * 1024);
      const from = sendFromFor(user, String(b.board || '')); if (!from) throw new HttpError(400, 'This board has no rep with a sending address, and you don’t have one either. An admin can set one in Team & settings.');
      if (!emailReady(from)) throw new HttpError(400, gmail.on() ? 'Connect your Gmail first (your profile menu → Connect Gmail).' : 'Email sending isn’t set up yet.');
      const bid = String(b.board || ''), iid = String(b.item || '');
      const { board, item } = loadItem(user, bid, iid);
      const why = blockedReason(board, item); if (why) throw new HttpError(400, why);
      const to = String(b.to || '').trim().toLowerCase();
      if (!leadEmails(board, item).includes(to)) throw new HttpError(400, 'You can only email the address on this lead.');
      const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300), text = String(b.text || '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
      if (!subject) throw new HttpError(400, 'Add a subject.'); if (!text) throw new HttpError(400, 'Write a message.');
      if (String(b.text || '').replace(/\r\n/g, '\n').trim().length > 20000) throw new HttpError(400, 'That email is too long: keep it under 20,000 characters.'); // never send a cut-off email
      if (db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE user_id = ? AND at > ?').get(user.id, new Date(Date.now() - 3600e3).toISOString()).n >= 60) throw new HttpError(429, 'That’s 60 emails in the last hour. Wait a bit before sending more.');
      let out; try { out = await sendEmailNow({ user, from, bid, iid, to, subject, text }); }
      catch (e) { console.error('email send:', e.message); throw new HttpError(502, 'The email didn’t send: ' + e.message); }
      return send(res, 200, { ok: true, threadId: out.threadId || null }), true;
    }
    return false;
  }

  // ---------- replies: every few minutes ----------
  const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt\s*out|remove me)\b/i;
  const meta = { get: k => (db.prepare('SELECT v FROM outreach_meta WHERE k = ?').get(k) || {}).v, set: (k, v) => db.prepare('INSERT INTO outreach_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v) };
  const seen = mid => { if (db.prepare('SELECT 1 FROM email_seen WHERE message_id = ?').get(mid)) return true; db.prepare('INSERT OR IGNORE INTO email_seen (message_id, at) VALUES (?, ?)').run(mid, now()); return false; };
  let busy = false;
  async function checkReplies() {
    if (busy || env('EMAIL_REPLY_SYNC').toLowerCase() === 'off') return;
    busy = true;
    try {
      const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
      if (env('EMAIL_REPLY_HOOK_URL') || gmail.on()) {
        const rows = db.prepare("SELECT from_email, thread_id, board, item, to_email FROM email_log WHERE status = 'sent' AND thread_id IS NOT NULL AND at > ? GROUP BY thread_id").all(since30);
        const byFrom = new Map(); rows.forEach(r => { if (!byFrom.has(r.from_email)) byFrom.set(r.from_email, []); byFrom.get(r.from_email).push(r); });
        for (const [from, list] of byFrom) {
          for (let i = 0; i < list.length; i += 100) {
            const part = list.slice(i, i + 100);
            if (!gmail.hasFor(from) && !env('EMAIL_REPLY_HOOK_URL')) continue;
            let d; try { d = gmail.hasFor(from) ? await gmail.threads(from, part.map(r => r.thread_id)) : await postHook(env('EMAIL_REPLY_HOOK_URL'), { from, threads: part.map(r => r.thread_id) }, 60000); } catch (e) { console.error('email replies:', e.message); continue; }
            for (const m of Array.isArray(d.messages) ? d.messages : []) {
              const mid = String(m.id || ''), tid = String(m.threadId || ''); if (!mid || !tid) continue;
              if (String(m.from || '').toLowerCase().includes(from)) continue; // our own message in the thread
              if (seen(mid)) continue;
              const row = part.find(r => r.thread_id === tid); if (!row) continue;
              const body = String(m.text || m.snippet || '').trim().slice(0, 4000);
              const out = STOP.test(body) || /unsubscribe/i.test(body.slice(0, 60));
              if (out) optOut(row.to_email, 'email', 'reply');
              addUpdate(row.board, row.item, { by: 'email', byName: 'Email reply', text: `↩️ Reply from ${String(m.from || row.to_email).slice(0, 200)}${m.subject ? `\nSubject: ${String(m.subject).slice(0, 300)}` : ''}\n\n${body}${out ? '\n\n(They asked to stop: this address won’t get any more emails from Solver.ca.)' : ''}`, email: { dir: 'in', threadId: tid } }, out ? 'Lead unsubscribed from email' : 'Lead replied by email');
            }
          }
        }
      }
      if (env('TEXT_REPLY_HOOK_URL')) {
        const froms = db.prepare("SELECT DISTINCT from_email FROM text_log WHERE status = 'sent' AND at > ?").all(since30).map(r => r.from_email);
        for (const from of froms) {
          const key = 'text_since:' + from, since = meta.get(key) || new Date(Date.now() - 3600e3).toISOString(), started = now();
          let d; try { d = await postHook(env('TEXT_REPLY_HOOK_URL'), { from, since }, 60000); } catch (e) { console.error('text replies:', e.message); continue; }
          for (const m of Array.isArray(d.messages) ? d.messages : []) {
            const mid = 'sms:' + String(m.id || ''), p10 = phone10(m.from); if (mid === 'sms:' || !p10) continue;
            if (seen(mid)) continue;
            const row = db.prepare("SELECT board, item FROM text_log WHERE to_phone = ? AND from_email = ? AND status = 'sent' AND at > ? ORDER BY at DESC LIMIT 1").get(p10, from, since30);
            const body = String(m.text || '').trim().slice(0, 2000), out = STOP.test(body);
            if (out) optOut(p10, 'phone', 'text STOP');
            if (!row) continue; // a text from someone we didn't text from Solver.ca: left to the rep's phone app
            addUpdate(row.board, row.item, { by: 'text', byName: 'Text reply', text: `💬 Text reply from ${p10.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')}\n\n${body}${out ? '\n\n(They texted STOP: this number won’t get any more texts from Solver.ca.)' : ''}`, sms: { dir: 'in' } }, out ? 'Lead texted STOP' : 'Lead replied by text');
          }
          meta.set(key, started);
        }
      }
    } finally { busy = false; }
  }
  const firstMs = Number(process.env.EMAIL_REPLY_FIRST_MS) || 45e3, everyMs = Math.max(20e3, Number(process.env.EMAIL_REPLY_EVERY_MS) || 3 * 60e3);
  setTimeout(() => { checkReplies().catch(e => console.error('replies:', e.message)); setInterval(() => checkReplies().catch(e => console.error('replies:', e.message)), everyMs).unref(); }, firstMs).unref();

  return { handle, gmail, emailReady, boardFrom, sendFromFor, nameForFrom, checkReplies, blockedReason, leadEmails, leadPhones, loadItem, fromOf, canSendRole, sendEmailNow, sendTextNow, env, phone10, isOptedOut, optOut };
};
