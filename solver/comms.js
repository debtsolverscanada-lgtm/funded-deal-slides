// Solver.ca "Calls & texts" panel: a lead's calls and texts, matched by phone number.
//  1. Events your phone/texting tools already post to /api/v1/events (client_called, client_texted, …) are kept
//     here and shown as a timeline on the item.
//  2. Optional read-only RingCentral connector: OFF unless RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET and
//     RINGCENTRAL_JWT are all set. It only reads the call log and message store for the lead's number.
// Nothing here ever places a call or sends a text.
'use strict';
const crypto = require('node:crypto');

const RC_BASE = () => String(process.env.RINGCENTRAL_SERVER || 'https://platform.ringcentral.com').replace(/\/+$/, '');
const digits = s => String(s || '').replace(/\D/g, '').slice(-10);

module.exports = function comms({ db, q, now, HttpError, send, boardInfo, mustSee, itemVisible }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comm_events (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, phone TEXT, email TEXT, board TEXT, item TEXT,
      direction TEXT, note TEXT, duration INTEGER, source TEXT
    );
    CREATE INDEX IF NOT EXISTS comm_events_item ON comm_events(board, item);
    CREATE INDEX IF NOT EXISTS comm_events_phone ON comm_events(phone);
  `);
  const ins = db.prepare('INSERT INTO comm_events (id, at, type, phone, email, board, item, direction, note, duration, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Called by /api/v1/events after it matched the event to items. One row per matched item; one unmatched row otherwise.
  function onEvent(body, hits, actor) {
    const at = body.at && !isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : now();
    const note = String(body.text || body.message || body.body || body.summary || body.note || '').slice(0, 1000);
    const dir = ['inbound', 'outbound'].includes(String(body.direction || '').toLowerCase()) ? String(body.direction).toLowerCase() : 'inbound';
    const dur = Number.isFinite(Number(body.duration)) ? Math.max(0, Math.round(Number(body.duration))) : null;
    const base = [at, String(body.type), digits(body.phone) || null, String(body.email || '').toLowerCase().slice(0, 200) || null];
    const src = String((actor && actor.name) || 'API').slice(0, 80);
    if (!hits.length) ins.run('ce_' + crypto.randomBytes(9).toString('base64url'), ...base, null, null, dir, note, dur, src);
    for (const h of hits) ins.run('ce_' + crypto.randomBytes(9).toString('base64url'), ...base, String(h.bid), String(h.iid), dir, note, dur, src);
    db.prepare('DELETE FROM comm_events WHERE at < ?').run(new Date(Date.now() - 400 * 864e5).toISOString());
  }

  // ---------- RingCentral (read-only) ----------
  const rcOn = () => !!(process.env.RINGCENTRAL_CLIENT_ID && process.env.RINGCENTRAL_CLIENT_SECRET && process.env.RINGCENTRAL_JWT);
  let token = null; const cache = new Map();
  async function rcToken() {
    if (token && token.exp > Date.now() + 60000) return token.value;
    const basic = Buffer.from(`${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(RC_BASE() + '/restapi/oauth/token', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: process.env.RINGCENTRAL_JWT }).toString() });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.access_token) throw new Error('RingCentral sign-in failed (' + r.status + ').');
    token = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
    return token.value;
  }
  async function rcGet(path) {
    const r = await fetch(RC_BASE() + path, { headers: { Authorization: 'Bearer ' + await rcToken() }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('RingCentral said ' + r.status + '.');
    return r.json();
  }
  async function rcFetch(phone10) {
    const hit = cache.get(phone10); if (hit && Date.now() - hit.at < 120000) return hit.v;
    const from = new Date(Date.now() - 180 * 864e5).toISOString(), num = '+1' + phone10, out = [];
    const calls = await rcGet(`/restapi/v1.0/account/~/extension/~/call-log?phoneNumber=${encodeURIComponent(num)}&dateFrom=${encodeURIComponent(from)}&perPage=100&view=Simple`);
    for (const c of calls.records || []) out.push({ id: 'rc_' + c.id, at: c.startTime, type: 'call', direction: String(c.direction || '').toLowerCase(), duration: c.duration, note: c.result || '', source: 'RingCentral' });
    const msgs = await rcGet(`/restapi/v1.0/account/~/extension/~/message-store?phoneNumber=${encodeURIComponent(num)}&dateFrom=${encodeURIComponent(from)}&messageType=SMS&perPage=100`);
    for (const m of msgs.records || []) out.push({ id: 'rm_' + m.id, at: m.creationTime, type: 'text', direction: String(m.direction || '').toLowerCase(), note: String(m.subject || '').slice(0, 1000), source: 'RingCentral' });
    cache.set(phone10, { at: Date.now(), v: out }); if (cache.size > 500) cache.clear();
    return out;
  }

  const TYPE = { client_called: 'call', client_texted: 'text', client_emailed: 'email', documents_received: 'docs' };
  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p !== '/api/comms' || method !== 'GET') return false;
    const bid = url.searchParams.get('board') || '', iid = url.searchParams.get('item') || '';
    const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
    if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid);
    const r = ID.test(iid) && q.doc.get(`boards/${bid}/items/${iid}`); if (!r) throw new HttpError(404, 'No such item.');
    const item = JSON.parse(r.data); if (!itemVisible(user, info, item)) throw new HttpError(404, 'No such item.');
    const phones = [...new Set((info.columns || []).filter(c => c.type === 'phone').map(c => digits((item.values || {})[c.id])).filter(x => x.length === 10))].slice(0, 3);
    // this item's events; admins also see events for its phone number that weren't matched to any item, and the
    // RingCentral log. Those are matched by phone number alone, so they could belong to a lead on a board
    // this person can't see: only admins (who see every board) get them.
    const admin = user && user.role === 'admin', byPhone = admin ? phones : [];
    const rows = db.prepare(`SELECT * FROM comm_events WHERE (board = ? AND item = ?) ${byPhone.length ? `OR (board IS NULL AND phone IN (${byPhone.map(() => '?').join(',')}))` : ''} ORDER BY at DESC LIMIT 200`).all(bid, iid, ...byPhone);
    let events = rows.map(e => ({ id: e.id, at: e.at, type: TYPE[e.type] || e.type, direction: e.direction, note: e.note || '', duration: e.duration, source: e.source || 'API' }));
    const rc = { on: rcOn(), error: null, ...(rcOn() && !admin ? { adminsOnly: true } : {}) };
    if (rc.on && admin && phones.length) {
      try { for (const ph of phones.slice(0, 2)) events.push(...await rcFetch(ph)); }
      catch (e) { rc.error = e.message; }
    }
    events = events.filter(e => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
    return send(res, 200, { phones: phones.length, events, ringcentral: rc });
  }
  return { handle, onEvent };
};
