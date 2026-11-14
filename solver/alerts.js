// Solver.ca staff email alerts: built, OFF until the server has RESEND_API_KEY and ALERTS_FROM.
// Each Solver.ca person chooses "Email me my notifications": off, instant, or a daily digest.
// Emails only ever go to a Solver.ca person's OWN sign-in address, looked up from the users table by id.
// Never to clients or leads: no item, column or update value is ever used as an address.
'use strict';

const API_BASE = () => String(process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
const MODES = ['off', 'instant', 'daily'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function alerts({ db, now, HttpError, readBody, send }) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_prefs (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email_mode TEXT NOT NULL DEFAULT 'off', digest_last TEXT, sent_hour TEXT, sent_n INTEGER NOT NULL DEFAULT 0
  )`);
  const configured = () => !!(process.env.RESEND_API_KEY && process.env.ALERTS_FROM);
  const prefs = uid => db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(uid) || { user_id: uid, email_mode: 'off', digest_last: null };
  const setMode = (uid, mode) => db.prepare(`INSERT INTO user_prefs (user_id, email_mode) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET email_mode = excluded.email_mode`).run(uid, mode);
  const appUrl = () => (process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/+$/, '') : '');

  // The only way an email leaves Solver.ca. `userId` must be a Solver.ca account; the address is its own email.
  async function sendToUser(userId, subject, text, html) {
    if (!configured()) return { skipped: 'not set up' };
    const u = db.prepare('SELECT id, email, name, disabled FROM users WHERE id = ?').get(userId);
    if (!u || u.disabled || !/^[^@\s]+@[^@\s]+$/.test(u.email)) return { skipped: 'no such person' };
    // at most 30 emails per person per hour, whatever happens
    const hour = new Date().toISOString().slice(0, 13), p = prefs(userId);
    const n = p.sent_hour === hour ? (p.sent_n || 0) : 0; if (n >= 30) return { skipped: 'hourly limit' };
    db.prepare(`INSERT INTO user_prefs (user_id, sent_hour, sent_n) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET sent_hour = excluded.sent_hour, sent_n = excluded.sent_n`).run(userId, hour, n + 1);
    const r = await fetch(API_BASE() + '/emails', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.ALERTS_FROM, to: [u.email], subject: String(subject).slice(0, 200), text, html }) });
    if (!r.ok) throw new Error(`The email service said ${r.status}.`);
    return { ok: true };
  }
  const line = n => `${n.text}`;
  function onNotify(user, n) {
    if (!configured()) return;
    if (prefs(user.id).email_mode !== 'instant') return;
    const link = appUrl() ? `${appUrl()}/#open=${encodeURIComponent(n.board || '')}${n.item ? '/' + encodeURIComponent(n.item) : ''}` : '';
    sendToUser(user.id, `Solver.ca: ${String(n.text).slice(0, 80)}`, `${line(n)}${link ? '\n\nOpen: ' + link : ''}\n\nYou get these because you chose “Email me my notifications: instant” in Solver.ca.`,
      `<p>${esc(line(n))}</p>${link ? `<p><a href="${esc(link)}">Open in Solver.ca</a></p>` : ''}<p style="color:#888;font-size:12px">You chose “Email me my notifications: instant” in Solver.ca. Change it in Profile.</p>`).catch(e => console.error('alert email:', e.message));
  }
  // Daily digest: once a day after DIGEST_HOUR (default 7) in the company time zone, unread notifications since the last one.
  const TZ = process.env.KS_TIMEZONE || 'America/Toronto';
  const local = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  async function runDigests(force) {
    if (!configured()) return 0;
    const t = local(new Date()), today = `${t.year}-${t.month}-${t.day}`, hour = Number(t.hour === '24' ? 0 : t.hour);
    if (!force && hour < Number(process.env.DIGEST_HOUR || 7)) return 0;
    let sent = 0;
    for (const p of db.prepare("SELECT * FROM user_prefs WHERE email_mode = 'daily'").all()) {
      if (p.digest_last === today && !force) continue;
      const since = p.digest_last ? new Date(Date.now() - 36 * 3600e3).toISOString() : new Date(Date.now() - 24 * 3600e3).toISOString();
      const list = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND read = 0 AND at > ? ORDER BY at DESC LIMIT 50').all(p.user_id, since);
      db.prepare('UPDATE user_prefs SET digest_last = ? WHERE user_id = ?').run(today, p.user_id);
      if (!list.length) continue;
      try {
        await sendToUser(p.user_id, `Solver.ca: ${list.length} notification${list.length === 1 ? '' : 's'} for you`,
          list.map(n => '• ' + line(n)).join('\n') + (appUrl() ? `\n\nOpen Solver.ca: ${appUrl()}` : ''),
          `<p>Your Solver.ca notifications:</p><ul>${list.map(n => `<li>${esc(line(n))}</li>`).join('')}</ul>${appUrl() ? `<p><a href="${esc(appUrl())}">Open Solver.ca</a></p>` : ''}`);
        sent++;
      } catch (e) { console.error('digest:', e.message); }
    }
    return sent;
  }
  if (process.env.KS_DIGESTS !== 'off') setInterval(() => { runDigests(false).catch(() => {}); }, 15 * 60 * 1000).unref();

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p !== '/api/me/alerts' && p !== '/api/me/alerts/test') return false;
    if (p === '/api/me/alerts' && method === 'GET') return send(res, 200, { email: { configured: configured(), mode: prefs(user.id).email_mode, to: user.email, message: configured() ? '' : 'Not set up yet' } });
    if (p === '/api/me/alerts' && method === 'PUT') {
      const b = await readBody(req); const mode = String(b.emailMode || '');
      if (!MODES.includes(mode)) throw new HttpError(400, 'Pick off, instant or daily.');
      if (mode !== 'off' && !configured()) throw new HttpError(400, 'Email alerts are not set up yet on this server.');
      setMode(user.id, mode);
      return send(res, 200, { ok: true, mode });
    }
    if (p === '/api/me/alerts/test' && method === 'POST') {
      if (!configured()) throw new HttpError(400, 'Email alerts are not set up yet on this server.');
      const r = await sendToUser(user.id, 'Solver.ca: test email', 'Email alerts are working.', '<p>Email alerts are working.</p>');
      return send(res, 200, r);
    }
    return false;
  }
  return { handle, onNotify, runDigests, sendToUser };
};
