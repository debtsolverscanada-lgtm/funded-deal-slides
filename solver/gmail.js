// "Connect Gmail" inside Solver.ca: each rep links their own Gmail once, and emails from leads (single and mass)
// go straight out of that mailbox with the Gmail API. Replies in those threads come back the same way.
//
//   Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Google Cloud OAuth client, Web application, with
//   <site>/api/gmail/callback as a redirect URI and the Gmail API turned on). Without them the button stays hidden
//   and email keeps going through n8n (EMAIL_SEND_HOOK_URL) as before.
//   Only the long-lived Google refresh token is kept, encrypted (AES-256-GCM) with GMAIL_TOKEN_KEY (or, if that
//   isn't set, a key derived from the client secret). Passwords are never seen. A person can connect only the
//   mailbox that is their own sign-in email or their "Sends email as" address, and can disconnect any time.
'use strict';
const crypto = require('node:crypto');

module.exports = function gmail({ db, now, HttpError, send }) {
  db.exec(`CREATE TABLE IF NOT EXISTS gmail_tokens (
    user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, refresh_enc TEXT NOT NULL, at TEXT NOT NULL)`);
  const env = k => String(process.env[k] || '').trim();
  const on = () => !!(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
  const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';

  // ---------- the stored token, encrypted ----------
  const key = () => crypto.createHash('sha256').update('solver-gmail:' + (env('GMAIL_TOKEN_KEY') || env('GOOGLE_CLIENT_SECRET'))).digest();
  const seal = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.'); };
  const open = s => { const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); };
  const rowFor = from => db.prepare('SELECT * FROM gmail_tokens WHERE email = ?').get(String(from || '').toLowerCase());
  const mine = uid => db.prepare('SELECT email, at FROM gmail_tokens WHERE user_id = ?').get(uid) || null;
  const hasFor = from => on() && !!rowFor(from);
  const drop = email => { db.prepare('DELETE FROM gmail_tokens WHERE email = ?').run(email); cache.delete(email); };

  // ---------- Google calls ----------
  const cache = new Map(); // email -> { token, exp }
  async function tokenCall(params) {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), ...params }), signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(d.error_description || d.error || 'Google answered ' + r.status); e.code = d.error; throw e; }
    return d;
  }
  async function access(email) {
    const c = cache.get(email); if (c && c.exp > Date.now() + 60e3) return c.token;
    const row = rowFor(email); if (!row) throw new Error('Gmail isn’t connected for ' + email + '.');
    let d; try { d = await tokenCall({ grant_type: 'refresh_token', refresh_token: open(row.refresh_enc) }); }
    catch (e) { if (e.code === 'invalid_grant') { drop(email); throw new Error('The Gmail connection for ' + email + ' expired or was removed. Connect Gmail again (your profile menu).'); } throw e; }
    cache.set(email, { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 }); return d.access_token;
  }
  async function api(email, path, opts = {}) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { ...opts, headers: { Authorization: 'Bearer ' + await access(email), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error((d.error && d.error.message) || 'Gmail answered ' + r.status);
    return d;
  }

  // ---------- sending and reading ----------
  const hdr = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
  async function sendMail(from, { to, subject, text, name }) {
    const clean = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
    const mime = [`From: ${name ? hdr(clean(name).replace(/["<>]/g, '')) + ' ' : ''}<${from}>`, `To: <${clean(to)}>`, `Subject: ${hdr(clean(subject))}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')].join('\r\n');
    const d = await api(from, 'messages/send', { method: 'POST', body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }) });
    return { ok: true, id: d.id, threadId: d.threadId };
  }
  async function threads(from, ids) {
    const messages = [];
    for (const tid of ids.filter(x => /^[A-Za-z0-9]{6,40}$/.test(String(x))).slice(0, 100)) {
      let t; try { t = await api(from, `threads/${tid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`); } catch (e) { if (/expired|isn’t connected/.test(e.message)) throw e; continue; }
      for (const m of t.messages || []) {
        const h = n => ((m.payload && m.payload.headers) || []).find(x => x.name.toLowerCase() === n) || {};
        messages.push({ id: m.id, threadId: m.threadId, from: h('from').value || '', subject: h('subject').value || '', text: m.snippet || '', at: m.internalDate || '' });
      }
    }
    return { messages };
  }

  // ---------- connect / disconnect ----------
  const states = new Map();
  const redirectUri = req => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https')).split(',')[0].trim();
    return `${proto}://${host}/api/gmail/callback`;
  };
  const allowed = (u, email) => {
    const r = db.prepare('SELECT email, email_from FROM users WHERE id = ?').get(u.id) || {};
    return [r.email, r.email_from].map(x => String(x || '').trim().toLowerCase()).filter(Boolean).includes(email);
  };
  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p === '/api/gmail/status' && method === 'GET') return send(res, 200, { available: on(), connected: on() ? mine(user.id) : null }), true;
    if (p === '/api/gmail/connect' && method === 'GET') {
      if (!on()) throw new HttpError(404, 'Connecting Gmail isn’t set up yet.');
      for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
      const state = crypto.randomBytes(24).toString('base64url'), ru = redirectUri(req);
      states.set(state, { uid: user.id, exp: Date.now() + 10 * 60e3, ru });
      const row = db.prepare('SELECT email, email_from FROM users WHERE id = ?').get(user.id) || {};
      const q = new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), redirect_uri: ru, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state, login_hint: row.email_from || row.email || '' });
      res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (p === '/api/gmail/callback' && method === 'GET') {
      const back = h => { res.writeHead(302, { Location: '/#gmail=' + h, 'Cache-Control': 'no-store' }); res.end(); return true; };
      const st = states.get(url.searchParams.get('state') || ''); states.delete(url.searchParams.get('state') || '');
      if (url.searchParams.get('error')) return back('error&msg=' + encodeURIComponent('Gmail wasn’t connected (cancelled).'));
      if (!on() || !st || st.exp < Date.now() || st.uid !== user.id) return back('error&msg=' + encodeURIComponent('That Gmail connection expired or didn’t start here. Try again.'));
      try {
        const d = await tokenCall({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: st.ru });
        if (!d.refresh_token) throw new Error('Google didn’t give a lasting connection. Try again.');
        if (!/gmail\.send/.test(d.scope || '') || !/gmail\.readonly/.test(d.scope || '')) throw new Error('Tick both Gmail boxes on the Google screen (send email, and read replies).');
        const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + d.access_token }, signal: AbortSignal.timeout(20000) }).then(r => r.json());
        const email = String(pr.emailAddress || '').toLowerCase();
        if (!email) throw new Error('Couldn’t read which Gmail that is.');
        if (!allowed(user, email)) throw new Error(`That’s ${email}. Connect your own work Gmail (the one you sign in to Solver.ca with).`);
        const other = db.prepare('SELECT user_id FROM gmail_tokens WHERE email = ? AND user_id != ?').get(email, user.id);
        if (other) throw new Error(email + ' is already connected by someone else.');
        db.prepare('DELETE FROM gmail_tokens WHERE user_id = ?').run(user.id); cache.clear();
        db.prepare('INSERT INTO gmail_tokens (user_id, email, refresh_enc, at) VALUES (?, ?, ?, ?)').run(user.id, email, seal(d.refresh_token), now());
        db.prepare('UPDATE users SET email_from = ? WHERE id = ?').run(email, user.id);
        cache.set(email, { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 });
        return back('ok&email=' + encodeURIComponent(email));
      } catch (e) { console.error('gmail connect:', e.message); return back('error&msg=' + encodeURIComponent(String(e.message).slice(0, 200))); }
    }
    if (p === '/api/gmail/disconnect' && method === 'POST') {
      const m = mine(user.id); if (m) {
        try { const row = rowFor(m.email); await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(open(row.refresh_enc)), { method: 'POST', signal: AbortSignal.timeout(10000) }); } catch (e) { /* removed here either way */ }
        drop(m.email);
      }
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }
  return { handle, on, hasFor, sendMail, threads, mine, connectedEmails: () => db.prepare('SELECT user_id, email FROM gmail_tokens').all() };
};
