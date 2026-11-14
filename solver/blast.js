// Mass email / mass text: tick leads, write one message, and each lead gets their OWN email or text (never a group
// message), sent one at a time from the rep's Gmail / RingCentral line through email.js.
//
//   Preview first: who gets it, who's skipped and why, and the first message as it will read.
//   Skipped: anything email.js blocks (Junk/Unqualified now or before, opted out, referred, "(copy)"), no address /
//   number, and leads whose inquiry is older than 6 months (Canada's anti-spam law: implied consent from an inquiry
//   lasts 6 months). Every email ends with the company name and "reply UNSUBSCRIBE"; every text with "Reply STOP".
//   Pacing: one email every BLAST_EMAIL_GAP_MS (10 s), one text every BLAST_TEXT_GAP_MS (4 s); texts only 9am-8pm in
//   the lead's province. Each lead is checked again right before its message goes. A blast can be stopped any time.
//   Members can send up to 50 at once; bigger blasts are for admins. BLASTS=off stops all sending.
'use strict';
const crypto = require('node:crypto');

module.exports = function blast({ db, q, now, HttpError, readBody, send, mustSee, boardInfo, itemVisible }, mail) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blasts (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT, user_role TEXT, from_email TEXT NOT NULL,
      channel TEXT NOT NULL, board TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS blast_rows (
      id TEXT PRIMARY KEY, blast_id TEXT NOT NULL, item TEXT NOT NULL, name TEXT, to_addr TEXT NOT NULL, prov TEXT,
      status TEXT NOT NULL, at TEXT, err TEXT
    );
    CREATE INDEX IF NOT EXISTS blast_rows_blast ON blast_rows(blast_id, status);
  `);
  // a lead that was mid-send when the server stopped: it may have gone out, so it's never sent again
  for (const r of db.prepare("SELECT id, blast_id FROM blast_rows WHERE status = 'sending'").all()) {
    db.prepare("UPDATE blast_rows SET status = 'failed', err = 'Interrupted by a server restart while sending; it may have gone out, so it wasn’t sent again' WHERE id = ?").run(r.id);
    db.prepare('UPDATE blasts SET failed = failed + 1 WHERE id = ?').run(r.blast_id);
  }
  const MAX = 500, MEMBER_MAX = 50, SIX_MONTHS = 183 * 864e5;
  const gap = ch => ch === 'email' ? Math.max(2000, Number(process.env.BLAST_EMAIL_GAP_MS) || 10000) : Math.max(1000, Number(process.env.BLAST_TEXT_GAP_MS) || 4000);
  const off = () => String(process.env.BLASTS || '').toLowerCase() === 'off';

  // ---------- reading a lead ----------
  const TZ = { AB: 'America/Edmonton', BC: 'America/Vancouver', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto', QC: 'America/Toronto', NB: 'America/Halifax', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit' };
  const NAMES = { ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', 'B C': 'BC', SASKATCHEWAN: 'SK', SASK: 'SK', MANITOBA: 'MB', ONTARIO: 'ON', QUEBEC: 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD': 'PE', PEI: 'PE', NEWFOUNDLAND: 'NL', YUKON: 'YT', NORTHWEST: 'NT', NUNAVUT: 'NU' };
  const provOf = (board, item) => {
    const c = (board.columns || []).find(x => /province|prov\b|state/i.test(x.title || '')); const raw = c ? String((item.values || {})[c.id] || '') : '';
    const u = raw.toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim(); if (TZ[u.replace(/ /g, '')]) return u.replace(/ /g, ''); for (const k in NAMES) if (u.startsWith(k)) return NAMES[k]; return '';
  };
  const localHour = (prov, t = Date.now()) => Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ[prov] || 'America/Toronto', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
  const inquiryAt = (board, item) => {
    const c = (board.columns || []).find(x => x.type === 'date' && /entered|created|inquir|submitted|lead date|date added/i.test(x.title || ''));
    const v = c && (item.values || {})[c.id]; const t = v ? Date.parse(String(v).slice(0, 10)) : NaN;
    if (!isNaN(t)) return t;
    const t2 = Date.parse(item.createdAt || item.created_at || ''); return isNaN(t2) ? null : t2;
  };
  const firstName = n => { let s = String(n || '').trim().split(/\s+/)[0] || 'there'; s = s.replace(/[^\p{L}'-]/gu, '') || 'there'; return s === s.toLowerCase() || s === s.toUpperCase() ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; };
  const company = board => /mortgage\s*solver/i.test(((board.workspace || {}).name) || '') ? 'MortgageSolvers' : 'DebtSolvers Canada';
  // replacements are functions so a name with "$&" or "$'" in it goes in as typed, not as a replace() pattern
  const fill = (tpl, item, user) => String(tpl || '').replace(/\{\s*first\s*name\s*\}/gi, () => firstName(item.name)).replace(/\{\s*(?:pulse\.)?name\s*\}/gi, () => String(item.name || '').trim() || 'there').replace(/\{\s*rep\s*\}/gi, () => firstName(user.name || user.email));
  const withFooter = (channel, text, board) => channel === 'email'
    ? `${text}\n\n--\n${company(board)}\nIf you’d rather not get these emails, reply UNSUBSCRIBE.`
    : (/reply\s+stop/i.test(text) ? text : `${text}${/[.!?…)]$/.test(text) ? '' : '.'} Reply STOP to opt out.`);

  // Who gets it and who's skipped (and why), for a list of item ids on one board
  // the same message already went (or is queued in a running blast) to this address in the last day: never twice
  const gotSame = (channel, bid, to, msg) => !!msg && !!db.prepare(`SELECT 1 FROM blast_rows r JOIN blasts b ON b.id = r.blast_id
    WHERE r.to_addr = ? AND b.channel = ? AND b.board = ? AND b.body = ? AND (? = 'text' OR COALESCE(b.subject, '') = ?) AND b.at > ?
      AND (r.status IN ('sent', 'sending') OR (r.status = 'queued' AND b.status = 'sending')) LIMIT 1`)
    .get(to, channel, bid, msg.body, channel, msg.subject || '', new Date(Date.now() - 864e5).toISOString());
  function plan(user, bid, ids, channel, msg) {
    if (!boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid), br = q.doc.get('boards/' + bid), board = br ? JSON.parse(br.data) : {};
    const go = [], skip = [], seenTo = new Set();
    for (const iid of [...new Set(ids.map(String))].slice(0, MAX)) {
      const r = q.doc.get(`boards/${bid}/items/${iid}`); if (!r) continue;
      const item = JSON.parse(r.data); if (!itemVisible(user, info, item)) continue;
      const name = String(item.name || '').slice(0, 120);
      const why = mail.blockedReason(board, item);
      // reasons are shown as a heading over a list of leads, so drop the "This lead…" wording: In “Junk/Unqualified” (8)
      if (why) { skip.push({ item: iid, name, why: why.replace(/, so .*$/, '').replace(/\.$/, '').replace(/\. Copies are never messaged$/, '').replace(/^This lead is in /, 'In ').replace(/^This lead (was|opted)/, (x, v) => v[0].toUpperCase() + v.slice(1)).replace(/^This is a /, '').replace(/, so this lead is never messaged$/, '') }); continue; }
      const to = channel === 'email' ? mail.leadEmails(board, item)[0] : mail.leadPhones(board, item)[0];
      if (!to) {
        const has = (board.columns || []).filter(c => channel === 'email' ? c.type === 'email' : c.type === 'phone' || /phone|mobile|cell/i.test(c.title || '')).some(c => String((item.values || {})[c.id] || '').trim());
        skip.push({ item: iid, name, why: channel === 'email' ? (has ? 'Email address isn’t valid' : 'No email address') : (!has ? 'No phone number' : (board.columns || []).some(c => (c.type === 'phone' || /phone|mobile|cell/i.test(c.title || '')) && String((item.values || {})[c.id] || '').replace(/\D/g, '').length >= 7) ? 'Not a Canadian/US mobile number' : 'Phone number isn’t valid') }); continue;
      }
      if (gotSame(channel, bid, to, msg)) { skip.push({ item: iid, name, why: 'Already got this same message in the last day' }); continue; }
      if (seenTo.has(to)) { skip.push({ item: iid, name, why: 'Same ' + (channel === 'email' ? 'email' : 'number') + ' as another selected lead' }); continue; }
      const at = inquiryAt(board, item);
      if (at && Date.now() - at > SIX_MONTHS) { skip.push({ item: iid, name, why: 'Inquiry older than 6 months' }); continue; }
      seenTo.add(to); go.push({ item: iid, name, to, prov: provOf(board, item), lead: item });
    }
    return { board, go, skip };
  }
  function checkReady(user, channel, bid) {
    if (off()) throw new HttpError(400, 'Mass sending is switched off right now.');
    if (channel !== 'email' && channel !== 'text') throw new HttpError(400, 'Pick email or text.');
    const from = mail.sendFromFor(user, String(bid || '')); if (!from) throw new HttpError(400, 'This board has no rep with a sending address, and you don’t have one either. An admin can set one in Team & settings.');
    if (channel === 'email' ? !mail.emailReady(from) : !mail.env('TEXT_SEND_HOOK_URL')) throw new HttpError(400, channel === 'email' ? (mail.gmail.on() ? 'Connect your Gmail first (your profile menu → Connect Gmail).' : 'Email sending isn’t set up yet.') : 'Texting isn’t set up yet.');
    return from;
  }
  function readMsg(b, channel) {
    const subject = String(b.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300), body = String(b.text || '').replace(/\r\n/g, '\n').trim().slice(0, channel === 'email' ? 20000 : 600);
    if (channel === 'email' && !subject) throw new HttpError(400, 'Add a subject.');
    if (!body) throw new HttpError(400, 'Write a message.');
    return { subject, body };
  }

  // ---------- sending, one lead at a time ----------
  const lastSent = new Map(); let ticking = false;
  async function tick() {
    if (ticking || off()) return; ticking = true;
    try {
      for (const bl of db.prepare("SELECT * FROM blasts WHERE status = 'sending' ORDER BY at").all()) {
        const key = bl.from_email + '|' + bl.channel; if (Date.now() - (lastSent.get(key) || 0) < gap(bl.channel)) continue;
        const rows = db.prepare("SELECT * FROM blast_rows WHERE blast_id = ? AND status = 'queued' ORDER BY rowid").all(bl.id);
        if (!rows.length) { db.prepare("UPDATE blasts SET status = 'done' WHERE id = ?").run(bl.id); continue; }
        // texts wait for 9am-8pm where the lead lives; a text still waiting after a day is dropped
        const row = bl.channel === 'text' ? rows.find(r => { const h = localHour(r.prov); return h >= 9 && h < 20; }) : rows[0];
        if (!row) { const old = Date.now() - Date.parse(bl.at) > 864e5; if (old) { db.prepare("UPDATE blast_rows SET status = 'skipped', err = 'Outside texting hours for a whole day' WHERE blast_id = ? AND status = 'queued'").run(bl.id); } continue; }
        const mark = (st, err) => { db.prepare('UPDATE blast_rows SET status = ?, at = ?, err = ? WHERE id = ?').run(st, now(), err || null, row.id); db.prepare(`UPDATE blasts SET ${st === 'sent' ? 'sent = sent + 1' : st === 'failed' ? 'failed = failed + 1' : 'skipped = skipped + 1'} WHERE id = ?`).run(bl.id); };
        const r = q.doc.get(`boards/${bl.board}/items/${row.item}`), br = q.doc.get('boards/' + bl.board);
        if (!r || !br) { mark('skipped', 'The lead is gone'); continue; }
        const item = JSON.parse(r.data), board = JSON.parse(br.data);
        const why = mail.blockedReason(board, item); if (why) { mark('skipped', why); continue; }
        const nowTo = bl.channel === 'email' ? mail.leadEmails(board, item) : mail.leadPhones(board, item);
        if (!nowTo.includes(row.to_addr)) { mark('skipped', 'The lead’s ' + (bl.channel === 'email' ? 'email' : 'number') + ' changed'); continue; }
        const user = { id: bl.user_id, name: bl.user_name, role: bl.user_role };
        const rep = { ...user, name: mail.nameForFrom(bl.from_email) || user.name };
        const text = withFooter(bl.channel, fill(bl.body, item, rep), board);
        lastSent.set(key, Date.now());
        db.prepare("UPDATE blast_rows SET status = 'sending', at = ? WHERE id = ?").run(now(), row.id); // claimed before the send, so a restart mid-send never sends it again
        try {
          if (bl.channel === 'email') await mail.sendEmailNow({ user, from: bl.from_email, bid: bl.board, iid: row.item, to: row.to_addr, subject: fill(bl.subject, item, rep), text, blastId: bl.total > 1 ? bl.id : null }); // one lead: logged as a plain Email/Text
          else await mail.sendTextNow({ user, from: bl.from_email, bid: bl.board, iid: row.item, to10: row.to_addr, text, blastId: bl.total > 1 ? bl.id : null });
          mark('sent');
        } catch (e) {
          mark('failed', e.message);
          // the same error three times running: something is wrong with the connection, so stop rather than burn the list
          const last = db.prepare("SELECT status FROM blast_rows WHERE blast_id = ? AND status IN ('sent','failed') ORDER BY at DESC LIMIT 3").all(bl.id);
          if (last.length === 3 && last.every(x => x.status === 'failed')) { db.prepare("UPDATE blasts SET status = 'stopped' WHERE id = ?").run(bl.id); console.error('blast stopped after 3 failures:', e.message); }
        }
      }
    } finally { ticking = false; }
  }
  setInterval(() => tick().catch(e => console.error('blast:', e.message)), 1000).unref();

  const summary = bl => bl && { id: bl.id, channel: bl.channel, board: bl.board, status: bl.status, total: bl.total, sent: bl.sent, failed: bl.failed, skipped: bl.skipped, at: bl.at,
    queued: db.prepare("SELECT COUNT(*) AS n FROM blast_rows WHERE blast_id = ? AND status = 'queued'").get(bl.id).n,
    // texts waiting for 9am-8pm where the lead lives, so the pill can say why nothing is moving
    held: bl.channel === 'text' && bl.status === 'sending' ? db.prepare("SELECT prov FROM blast_rows WHERE blast_id = ? AND status = 'queued'").all(bl.id).filter(r => { const h = localHour(r.prov); return h < 9 || h >= 20; }).length : 0 };

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/blast')) return false;
    if (p === '/api/blast/preview' && method === 'POST') {
      const b = await readBody(req, 256 * 1024), channel = String(b.channel || '');
      // "Check who gets it" works before the message is written: the list comes back, the sample waits for the text
      const typed = !!String(b.text || '').trim(), from = checkReady(user, channel, b.board), msg = readMsg({ subject: String(b.subject || '').trim() ? b.subject : '-', text: typed ? b.text : '-' }, channel);
      if (!String(b.subject || '').trim()) msg.subject = '';
      const { board, go, skip } = plan(user, String(b.board || ''), Array.isArray(b.items) ? b.items : [], channel, typed ? { body: msg.body, subject: channel === 'email' ? msg.subject : '' } : null);
      const s = go[0], u = { id: user.id, name: mail.nameForFrom(from) || user.name, role: user.role };
      return send(res, 200, { from, fromName: mail.nameForFrom(from) || '', channel, count: go.length, skipped: skip, limit: user.role === 'admin' ? MAX : MEMBER_MAX,
        later: channel === 'text' ? go.filter(g => { const h = localHour(g.prov); return h < 9 || h >= 20; }).length : 0, // held until 9am-8pm their time
        sample: s && typed ? { name: s.name, to: s.to, subject: channel === 'email' ? fill(msg.subject, s.lead, u) : '', text: withFooter(channel, fill(msg.body, s.lead, u), board) } : null,
        unknown: [...new Set(((channel === 'email' ? msg.subject + ' ' : '') + msg.body).replace(/\{\s*(?:first\s*name|(?:pulse\.)?name|rep)\s*\}/gi, '').match(/\{[^{}\n]{1,40}\}/g) || [])].slice(0, 10),
        minutes: Math.ceil(go.length * gap(channel) / 60000) }), true;
    }
    if (p === '/api/blast/start' && method === 'POST') {
      const b = await readBody(req, 256 * 1024), channel = String(b.channel || '');
      const from = checkReady(user, channel, b.board), msg = readMsg(b, channel), bid = String(b.board || '');
      const { go, skip } = plan(user, bid, Array.isArray(b.items) ? b.items : [], channel, msg);
      if (!go.length) throw skip.some(s => s.why === 'Already got this same message in the last day') ? new HttpError(409, 'These leads already got this message or are in a blast that’s sending it.') : new HttpError(400, 'None of the selected leads can get this.');
      if (user.role !== 'admin' && go.length > MEMBER_MAX) throw new HttpError(403, `That’s ${go.length} leads. Blasts over ${MEMBER_MAX} need an admin to send them.`);
      if (Number(b.expect) && Number(b.expect) !== go.length) throw new HttpError(409, 'The list changed since the preview. Check it again.');
      const id = 'bl_' + crypto.randomBytes(9).toString('base64url');
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO blasts (id, at, user_id, user_name, user_role, from_email, channel, board, subject, body, status, total, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, now(), user.id, user.name || user.email, user.role, from, channel, bid, msg.subject || null, msg.body, 'sending', go.length, 0);
        const ins = db.prepare("INSERT INTO blast_rows (id, blast_id, item, name, to_addr, prov, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')");
        go.forEach((g, i) => ins.run(id + '_' + i, id, g.item, g.name, g.to, g.prov));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      console.log(`Blast ${id}: ${channel} to ${go.length} leads by ${user.id} (${skip.length} skipped)`);
      return send(res, 200, summary(db.prepare('SELECT * FROM blasts WHERE id = ?').get(id))), true;
    }
    if (p === '/api/blast/mine' && method === 'GET') {
      const list = db.prepare("SELECT * FROM blasts WHERE (user_id = ? OR ? = 'admin') AND (status = 'sending' OR at > ?) ORDER BY at DESC LIMIT 10").all(user.id, user.role, new Date(Date.now() - 6 * 3600e3).toISOString());
      return send(res, 200, list.map(summary)), true;
    }
    const m = p.match(/^\/api\/blast\/(bl_[A-Za-z0-9_-]+)\/stop$/);
    if (m && method === 'POST') {
      const bl = db.prepare('SELECT * FROM blasts WHERE id = ?').get(m[1]); if (!bl) throw new HttpError(404, 'No such blast.');
      if (bl.user_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'Only the sender or an admin can stop it.');
      db.prepare("UPDATE blasts SET status = 'stopped' WHERE id = ? AND status = 'sending'").run(bl.id);
      return send(res, 200, summary(db.prepare('SELECT * FROM blasts WHERE id = ?').get(bl.id))), true;
    }
    return false;
  }
  return { handle, tick, plan };
};
