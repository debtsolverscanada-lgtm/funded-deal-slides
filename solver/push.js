// Solver.ca push alerts: Web Push for the installed app (phone or desktop), with node:crypto only.
//   - VAPID (RFC 8292): an ES256-signed token tells the push service who is sending.
//   - aes128gcm (RFC 8291 + RFC 8188): the payload is encrypted for that one browser; the push service can't read it.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, raw P-256). Without them a pair is made once and kept in the
// database's server_meta table (never in the board data, never logged).
// Each person turns alerts on per device in Profile ("Phone/desktop alerts"); their in-app notifications
// (mentions, assignments, reminders, automation alerts) are then pushed to those devices.
'use strict';
const crypto = require('node:crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s || ''), 'base64url');

// ---------- keys ----------
const pubJwk = pubRaw => ({ kty: 'EC', crv: 'P-256', x: b64u(pubRaw.subarray(1, 33)), y: b64u(pubRaw.subarray(33, 65)) });
function keyObjects(pubRaw, privRaw) {
  const jwk = pubJwk(pubRaw);
  return { publicKey: crypto.createPublicKey({ key: jwk, format: 'jwk' }), privateKey: crypto.createPrivateKey({ key: { ...jwk, d: b64u(privRaw) }, format: 'jwk' }) };
}
function newVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// ---------- VAPID header ----------
function vapidAuth(endpoint, keys, subject, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject }));
  const { privateKey } = keyObjects(unb64u(keys.publicKey), unb64u(keys.privateKey));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---------- aes128gcm payload encryption (RFC 8291) ----------
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function encrypt(payload, p256dh, auth, opts = {}) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Bad subscription key.');
  if (authSecret.length < 16) throw new Error('Bad subscription auth secret.');
  const as = crypto.createECDH('prime256v1'); if (opts.asPrivate) as.setPrivateKey(opts.asPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = opts.salt || crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // one record, ended with the 0x02 delimiter
  const rs = 4096; if (plain.length + 16 > rs) throw new Error('That alert is too long.');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(rs, 16); head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}
// The other side of encrypt(): what a browser does. Used by the tests' mock push service.
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ua = crypto.createECDH('prime256v1'); ua.setPrivateKey(unb64u(uaPrivate));
  const ecdhSecret = ua.computeSecret(asPublic), uaPub = unb64u(uaPublic);
  const ikm = hmac(hmac(unb64u(auth), ecdhSecret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1; while (end >= 0 && plain[end] === 0) end--; // padding
  if (plain[end] !== 2) throw new Error('Bad record delimiter.');
  return plain.subarray(0, end).toString('utf8');
}
function verifyVapid(header, publicKeyB64) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(String(header || '')); if (!m) return null;
  const [h, c, s] = m[1].split('.');
  const pub = crypto.createPublicKey({ key: pubJwk(unb64u(publicKeyB64)), format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(s));
  return ok && m[2] === publicKeyB64 ? JSON.parse(unb64u(c).toString()) : null;
}

module.exports = function push({ db, now, HttpError, readBody, send, safeUrl }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      device TEXT, created_at TEXT NOT NULL, last_ok TEXT, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
  `);
  let keys = null;
  function vapidKeys() {
    if (keys) return keys;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) { keys = { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() }; return keys; }
    const row = db.prepare("SELECT v FROM server_meta WHERE k = 'vapid'").get();
    if (row) { keys = JSON.parse(row.v); return keys; }
    keys = newVapidKeys();
    db.prepare("INSERT INTO server_meta (k, v) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    console.log('Push alerts: made a new VAPID key pair (kept in the database).');
    return keys;
  }
  const subject = () => process.env.VAPID_SUBJECT || (process.env.PUBLIC_URL ? String(process.env.PUBLIC_URL).replace(/\/+$/, '') : 'https://solver.ca');

  async function sendTo(sub, data) {
    const k = vapidKeys();
    const body = encrypt(JSON.stringify(data), sub.p256dh, sub.auth);
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(10000), body,
        headers: { Authorization: vapidAuth(sub.endpoint, k, subject()), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' } });
      if (r.status === 404 || r.status === 410) { db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint); return r.status; }
      db.prepare('UPDATE push_subs SET last_ok = ?, last_error = ? WHERE endpoint = ?').run(r.ok ? now() : null, r.ok ? null : `Got ${r.status}`, sub.endpoint);
      return r.status;
    } catch (e) { db.prepare('UPDATE push_subs SET last_error = ? WHERE endpoint = ?').run(String(e.message).slice(0, 200), sub.endpoint); return 0; }
  }
  // An in-app notification was just made for this person: push it to their devices (if they turned alerts on).
  function onNotify(user, n) {
    const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(user.id); if (!subs.length) return;
    const title = { mention: 'You were mentioned', assign: 'Assigned to you', reminder: 'Reminder', automation: 'Solver.ca' }[n.kind] || 'Solver.ca';
    const data = { title, body: String(n.text || '').slice(0, 300), tag: n.id, url: n.board ? `/#open=${encodeURIComponent(n.board)}${n.item ? '/' + encodeURIComponent(n.item) : ''}` : '/' };
    for (const s of subs.slice(0, 10)) sendTo(s, data).catch(() => {});
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/push/')) return false;
    if (p === '/api/push/key' && method === 'GET') return send(res, 200, { publicKey: vapidKeys().publicKey });
    if (p === '/api/push/status' && method === 'GET') {
      const rows = db.prepare('SELECT endpoint, device, created_at, last_ok, last_error FROM push_subs WHERE user_id = ?').all(user.id);
      return send(res, 200, { publicKey: vapidKeys().publicKey, devices: rows.map(r => ({ id: crypto.createHash('sha256').update(r.endpoint).digest('hex').slice(0, 16), device: r.device || '', since: r.created_at, lastOk: r.last_ok, lastError: r.last_error })) });
    }
    if (p === '/api/push/subscribe' && method === 'POST') {
      const b = await readBody(req); const sub = b.subscription || b;
      const endpoint = safeUrl(sub && sub.endpoint), keysIn = (sub && sub.keys) || {};
      if (!endpoint || !/^https:/.test(endpoint) && process.env.KS_ALLOW_PRIVATE_WEBHOOKS !== '1') throw new HttpError(400, 'That browser gave an address push alerts can’t use.');
      if (unb64u(keysIn.p256dh).length !== 65 || unb64u(keysIn.auth).length < 16) throw new HttpError(400, 'That browser gave keys push alerts can’t use.');
      if (db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get(user.id).n >= 10) throw new HttpError(400, 'Alerts are on for 10 devices already. Turn one off first.');
      db.prepare(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`).run(endpoint, user.id, keysIn.p256dh, keysIn.auth, String(b.device || '').slice(0, 80), now());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && method === 'POST') {
      const b = await readBody(req);
      if (b.all) db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(user.id);
      else db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(user.id, String(b.endpoint || ''));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/test' && method === 'POST') {
      const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(user.id);
      if (!subs.length) throw new HttpError(400, 'Turn on alerts on this device first.');
      const codes = await Promise.all(subs.map(s => sendTo(s, { title: 'Solver.ca', body: 'Alerts are working on this device.', tag: 'test', url: '/' })));
      return send(res, 200, { ok: codes.some(c => c >= 200 && c < 300), sent: codes.filter(c => c >= 200 && c < 300).length });
    }
    return false;
  }
  return { handle, onNotify, vapidKeys };
};
module.exports.encrypt = encrypt;
module.exports.decrypt = decrypt;
module.exports.vapidAuth = vapidAuth;
module.exports.verifyVapid = verifyVapid;
module.exports.newVapidKeys = newVapidKeys;
