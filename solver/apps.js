// Connected apps: one place to plug outside tools into Solver.ca (admins only), and the first one wired all the way
// through, Stripe: "Request payment" on any lead with any amount and any description.
//
//   Keys an admin pastes here are stored encrypted (AES-256-GCM, key from GMAIL_TOKEN_KEY / APPS_KEY) and are
//   never sent back to the page (only the last 4 characters). Turn Stripe requests off with STRIPE_REQUESTS=off.
//
//   Stripe: each request makes a Price + a Payment Link (CAD) tagged with the board and lead. Every few minutes the
//   server asks Stripe whether open links were paid; a paid one is posted on the lead's Updates and switched off so it
//   can't be paid twice. Solver.ca never sees card numbers: the client pays on Stripe's own page.
'use strict';
const crypto = require('node:crypto');

module.exports = function apps({ db, now, broadcast, q, HttpError, readBody, send, mustSee, itemVisible, boardInfo }, mail) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_secrets (app TEXT PRIMARY KEY, enc TEXT NOT NULL, last4 TEXT, info TEXT, at TEXT NOT NULL, by TEXT);
    CREATE TABLE IF NOT EXISTS pay_requests (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT NOT NULL, user_name TEXT, board TEXT NOT NULL, item TEXT NOT NULL,
      amount INTEGER NOT NULL, currency TEXT NOT NULL, descr TEXT NOT NULL, link_id TEXT, url TEXT,
      status TEXT NOT NULL, paid_at TEXT, paid_amount INTEGER, checked_at TEXT, test INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pay_requests_item ON pay_requests(board, item);
  `);
  const env = k => String(process.env[k] || '').trim();
  const key = () => crypto.createHash('sha256').update('solver-apps:' + (env('APPS_KEY') || env('GMAIL_TOKEN_KEY') || env('ADMIN_PASSWORD') || 'solver')).digest();
  const seal = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.'); };
  const unseal = s => { const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); };
  const secret = app => { const r = db.prepare('SELECT enc FROM app_secrets WHERE app = ?').get(app); try { return r ? unseal(r.enc) : ''; } catch (e) { return ''; } };
  const secretInfo = app => { const r = db.prepare('SELECT last4, info, at FROM app_secrets WHERE app = ?').get(app); return r ? { last4: r.last4, info: r.info ? JSON.parse(r.info) : {}, at: r.at } : null; };
  const isAdmin = u => u && u.role === 'admin';
  const rid = p => p + crypto.randomBytes(9).toString('base64url');
  const money = (c, cur = 'cad') => '$' + (c / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur.toLowerCase() === 'cad' ? '' : ' ' + cur.toUpperCase());

  // ---------- Stripe ----------
  const stripeKey = () => env('STRIPE_SECRET_KEY') || secret('stripe');
  const stripeOn = () => !!stripeKey() && env('STRIPE_REQUESTS').toLowerCase() !== 'off';
  const form = (obj, pre = '', out = new URLSearchParams()) => { for (const [k, v] of Object.entries(obj)) { const n = pre ? `${pre}[${k}]` : k; if (v && typeof v === 'object') form(v, n, out); else if (v !== undefined && v !== null) out.append(n, String(v)); } return out; };
  async function stripe(method, path, body, k = stripeKey()) {
    const r = await fetch('https://api.stripe.com/v1/' + path, { method, headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' }, body: body ? form(body).toString() : undefined, signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error((d.error && d.error.message) || 'Stripe answered ' + r.status);
    return d;
  }
  function addUpdate(bid, iid, upd, activityText) {
    const path = `boards/${bid}/items/${iid}`, r = q.doc.get(path); if (!r) return;
    const item = JSON.parse(r.data);
    item.updates = [...(item.updates || []), { id: 'u' + crypto.randomBytes(6).toString('hex'), at: now(), ...upd }];
    if (activityText) item.activity = [{ at: now(), by: upd.by || 'automation', text: activityText }, ...(item.activity || [])].slice(0, 40);
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), now(), upd.by || 'apps');
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
  }
  const outRow = r => ({ id: r.id, at: r.at, by: r.user_name, amount: r.amount, currency: r.currency, descr: r.descr, url: r.status === 'open' ? r.url : null, status: r.status, paidAt: r.paid_at, test: !!r.test });

  let busy = false;
  async function checkPayments() {
    if (busy || !stripeOn()) return; busy = true;
    try {
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      for (const r of db.prepare("SELECT * FROM pay_requests WHERE status = 'open' AND at > ? ORDER BY checked_at IS NOT NULL, checked_at LIMIT 50").all(since)) {
        db.prepare('UPDATE pay_requests SET checked_at = ? WHERE id = ?').run(now(), r.id);
        let s; try { s = await stripe('GET', `checkout/sessions?payment_link=${encodeURIComponent(r.link_id)}&status=complete&limit=3`); } catch (e) { console.error('stripe check:', e.message); continue; }
        const paid = (s.data || []).find(x => x.payment_status === 'paid'); if (!paid) continue;
        db.prepare("UPDATE pay_requests SET status = 'paid', paid_at = ?, paid_amount = ? WHERE id = ?").run(now(), paid.amount_total || r.amount, r.id);
        try { await stripe('POST', 'payment_links/' + r.link_id, { active: false }); } catch (e) { /* already off */ }
        addUpdate(r.board, r.item, { by: 'stripe', byName: 'Stripe', text: `✅ Paid ${money(paid.amount_total || r.amount, r.currency)} for “${r.descr}”${paid.customer_details && paid.customer_details.email ? ' · receipt to ' + paid.customer_details.email : ''}${r.test ? ' (test mode)' : ''}`, payment: { id: r.id, status: 'paid' } }, `Paid ${money(paid.amount_total || r.amount, r.currency)}`);
      }
    } finally { busy = false; }
  }
  const timer = setInterval(() => checkPayments().catch(e => console.error('stripe check:', e.message)), Number(env('STRIPE_CHECK_EVERY_MS')) || 3 * 60e3); timer.unref();

  // ---------- the apps list ----------
  function appsList(user) {
    const g = mail.gmail, st = secretInfo('stripe');
    const gm = g.on() ? g.connectedEmails() : [];
    return [
      (() => { const viaN8n = !!mail.env('EMAIL_SEND_HOOK_URL'); const senders = db.prepare("SELECT name, email_from FROM users WHERE email_from IS NOT NULL AND email_from != '' ORDER BY name").all();
        const names = senders.map(x => String(x.name || x.email_from).split(/\s+/)[0]).join(', ');
        return { id: 'gmail', name: 'Gmail', what: 'Each rep sends lead emails and Mass email from their own Gmail; replies land on the lead.', state: viaN8n || g.on() ? 'on' : 'setup',
          detail: viaN8n ? `Through n8n: ${names || 'nobody yet'}${gm.length ? ` · in-app: ${gm.map(x => x.email).join(', ')}` : ''}` : g.on() ? `${gm.length} connected: ${gm.map(x => x.email).join(', ') || 'nobody yet'}` : 'Not set up yet.' }; })(),
      { id: 'stripe', name: 'Stripe', what: 'Request any amount from a lead. They pay on Stripe’s page and the lead shows ✅ Paid.', state: stripeKey() ? (stripeOn() ? 'on' : 'paused') : 'off', detail: env('STRIPE_SECRET_KEY') ? 'Key set on the server' : st ? `Key …${st.last4}${st.info.account ? ' · ' + st.info.account : ''}${st.info.test ? ' · TEST mode' : ''}` : 'Paste a Stripe secret key to turn it on.', canKey: !env('STRIPE_SECRET_KEY') },
      { id: 'ringcentral', name: 'RingCentral', what: 'Texts and Mass text from each rep’s own line, with replies and STOP on the lead.', state: mail.env('TEXT_SEND_HOOK_URL') ? 'on' : 'off', detail: (() => { const names = db.prepare("SELECT name, email_from FROM users WHERE email_from IS NOT NULL AND email_from != '' ORDER BY name").all().map(x => String(x.name || x.email_from).split(/\s+/)[0]).join(', '); return mail.env('TEXT_SEND_HOOK_URL') ? `Through n8n: ${names || 'nobody yet'}` : 'Not set up yet.'; })() },
      { id: 'gcal', name: 'Google Calendar', what: 'Book a callback from a lead; it lands in the rep’s calendar and on the lead.', state: 'soon', detail: 'Uses the same Google key as Gmail. Next up.' },
      { id: 'docusign', name: 'DocuSign', what: 'Send the agreement from a lead and see when it’s signed.', state: 'soon', detail: 'Coming next.' },
      { id: 'quickbooks', name: 'QuickBooks', what: 'Invoices and payments on the client’s lead.', state: 'soon', detail: 'Coming next.' },
      { id: 'facebook', name: 'Facebook Lead Ads', what: 'New ad leads straight onto a board.', state: 'soon', detail: 'MortgageSolvers ads already come in through the n8n lead routers (via Monday). Only forms that aren’t routed yet will be added here, so nothing comes in twice.' },
      { id: 'api', name: 'API keys & webhooks', what: 'Let Zapier, n8n or any tool read and add leads, or get told when a lead changes.', state: 'on', detail: 'Open to manage keys, webhooks and lead links.' },
    ];
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p === '/api/apps' && method === 'GET') { if (!isAdmin(user)) throw new HttpError(403, 'Only admins manage connected apps.'); return send(res, 200, { apps: appsList(user) }), true; }
    if (p === '/api/apps/stripe/key' && (method === 'PUT' || method === 'DELETE')) {
      if (!isAdmin(user)) throw new HttpError(403, 'Only admins manage connected apps.');
      if (method === 'DELETE') { db.prepare("DELETE FROM app_secrets WHERE app = 'stripe'").run(); return send(res, 200, { ok: true }), true; }
      const b = await readBody(req, 8 * 1024); const k = String(b.key || '').trim();
      if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(k)) throw new HttpError(400, 'That doesn’t look like a Stripe secret key (it starts with sk_live_, sk_test_ or rk_live_).');
      let acct = ''; try { await stripe('GET', 'payment_links?limit=1', null, k); try { const a = await stripe('GET', 'account', null, k); acct = (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || a.business_profile && a.business_profile.name || ''; } catch (e) { /* restricted key */ } }
      catch (e) { throw new HttpError(400, 'Stripe didn’t accept that key: ' + e.message); }
      db.prepare('INSERT INTO app_secrets (app, enc, last4, info, at, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app) DO UPDATE SET enc = excluded.enc, last4 = excluded.last4, info = excluded.info, at = excluded.at, by = excluded.by')
        .run('stripe', seal(k), k.slice(-4), JSON.stringify({ account: acct, test: /_test_/.test(k) }), now(), user.id);
      return send(res, 200, { ok: true, account: acct, test: /_test_/.test(k) }), true;
    }
    // ---- payments on a lead ----
    if (p === '/api/pay/list' && method === 'GET') {
      const bid = url.searchParams.get('board') || '', iid = url.searchParams.get('item') || '';
      mail.loadItem(user, bid, iid);
      const rows = db.prepare('SELECT * FROM pay_requests WHERE board = ? AND item = ? ORDER BY at DESC LIMIT 50').all(bid, iid).map(r => ({ ...outRow(r), canCancel: r.user_id === user.id || isAdmin(user) }));
      return send(res, 200, { on: stripeOn(), canRequest: stripeOn() && mail.canSendRole(user), rows, test: /_test_/.test(stripeKey()) }), true;
    }
    if (p === '/api/pay/request' && method === 'POST') {
      if (!stripeOn()) throw new HttpError(400, 'Stripe isn’t connected. An admin can connect it under Connect apps.');
      if (!mail.canSendRole(user)) throw new HttpError(403, 'Ask an admin to let you send from your own address first (Team & settings).');
      const b = await readBody(req, 16 * 1024);
      const bid = String(b.board || ''), iid = String(b.item || ''); const { item } = mail.loadItem(user, bid, iid);
      // Plain money only: 150, 150.5, 1,250.00, or a French-style decimal comma (250,50). Nothing else (1e3, 0x10, 12.345, 1.000,50).
      let amtS = (typeof b.amount === 'string' || typeof b.amount === 'number') ? String(b.amount).replace(/[$\s ]/g, '') : '';
      if (/^\d+,\d{1,2}$/.test(amtS)) amtS = amtS.replace(',', '.');
      else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(amtS)) amtS = amtS.replace(/,/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(amtS)) throw new HttpError(400, 'Enter an amount like 150.00.');
      const amount = Math.round(Number(amtS) * 100);
      if (!Number.isFinite(amount) || amount < 100) throw new HttpError(400, 'Enter an amount of at least $1.00.');
      if (amount > 5000000) throw new HttpError(400, 'That’s over $50,000. Split it or use Stripe directly.');
      const descr = String(b.descr || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!descr) throw new HttpError(400, 'Say what the payment is for (the client sees it).');
      if (db.prepare('SELECT COUNT(*) AS n FROM pay_requests WHERE user_id = ? AND at > ?').get(user.id, new Date(Date.now() - 3600e3).toISOString()).n >= 30) throw new HttpError(429, 'That’s 30 payment requests in the last hour. Wait a bit.');
      const id = rid('pay_'), meta = { solver_request: id, solver_board: bid, solver_item: iid, requested_by: String(user.email || user.id).slice(0, 100) };
      let link;
      try {
        const price = await stripe('POST', 'prices', { currency: 'cad', unit_amount: amount, product_data: { name: descr }, metadata: meta });
        link = await stripe('POST', 'payment_links', { line_items: { 0: { price: price.id, quantity: 1 } }, metadata: meta, payment_intent_data: { metadata: meta, description: `${descr} · ${String(item.name || '').slice(0, 80)}` }, after_completion: { type: 'hosted_confirmation', hosted_confirmation: { custom_message: 'Thank you! Your payment was received.' } } });
      } catch (e) { console.error('stripe request:', e.message); throw new HttpError(502, 'Stripe didn’t make the link: ' + e.message); }
      const test = !link.livemode;
      db.prepare('INSERT INTO pay_requests (id, at, user_id, user_name, board, item, amount, currency, descr, link_id, url, status, test) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, now(), user.id, user.name || user.email, bid, iid, amount, 'cad', descr, link.id, link.url, 'open', test ? 1 : 0);
      addUpdate(bid, iid, { by: user.id, byName: user.name || user.email, text: `💳 Payment requested: ${money(amount)} for “${descr}”${test ? ' (test mode)' : ''}\n${link.url}`, payment: { id, status: 'open' } }, `Requested ${money(amount)}`);
      return send(res, 200, { ok: true, id, url: link.url, amount, descr, test }), true;
    }
    const cancel = /^\/api\/pay\/([A-Za-z0-9_-]{4,40})\/cancel$/.exec(p);
    if (cancel && method === 'POST') {
      const r = db.prepare('SELECT * FROM pay_requests WHERE id = ?').get(cancel[1]); if (!r) throw new HttpError(404, 'No such payment request.');
      mail.loadItem(user, r.board, r.item);
      if (r.user_id !== user.id && !isAdmin(user)) throw new HttpError(403, 'Only the person who asked (or an admin) can cancel it.');
      if (r.status !== 'open') throw new HttpError(400, 'It’s already ' + r.status + '.');
      try { await stripe('POST', 'payment_links/' + r.link_id, { active: false }); } catch (e) { throw new HttpError(502, 'Stripe didn’t switch the link off: ' + e.message); }
      db.prepare("UPDATE pay_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
      addUpdate(r.board, r.item, { by: user.id, byName: user.name || user.email, text: `🚫 Payment request cancelled: ${money(r.amount, r.currency)} for “${r.descr}”. The link no longer works.` }, 'Cancelled a payment request');
      return send(res, 200, { ok: true }), true;
    }
    if (p === '/api/pay/check' && method === 'POST') { await checkPayments(); return send(res, 200, { ok: true }), true; }
    return false;
  }
  return { handle, checkPayments, stripeOn };
};
