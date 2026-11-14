// Solver.ca sign-in security: two-factor codes (TOTP, RFC 6238) and Google sign-in (OpenID Connect).
// No packages: node:crypto only.
'use strict';
const crypto = require('node:crypto');

// ---------- base32 (RFC 4648, no padding), used by authenticator apps ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('Not a base32 key.');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------- TOTP: 30-second steps, 6 digits, HMAC-SHA1 (what Google Authenticator, 1Password and Authy use) ----------
const STEP = 30, DIGITS = 6;
function hotp(key, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);
const totp = (secretB32, ms = Date.now()) => hotp(base32Decode(secretB32), counterAt(ms));
// Accepts the code for the current step and one step either side (clock drift). Returns the matched counter, or null.
// A code whose counter is not newer than `last` was already used and is refused (no replays).
function verifyTotp(secretB32, code, last = -1, ms = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secretB32) return null;
  const key = base32Decode(secretB32), now = counterAt(ms);
  for (const k of [now, now - 1, now + 1]) {
    if (k <= last) continue;
    const want = Buffer.from(hotp(key, k)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(want, got)) return k;
  }
  return null;
}
const newSecret = () => base32Encode(crypto.randomBytes(20)); // 160-bit key, as RFC 4226 recommends
function otpauthUri(secret, account, issuer = 'Solver.ca') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// ---------- one-time backup codes: shown once, only hashes are stored ----------
function newBackupCodes(n = 10) {
  const out = [];
  while (out.length < n) { const raw = base32Encode(crypto.randomBytes(5)).toLowerCase().slice(0, 8); out.push(raw.slice(0, 4) + '-' + raw.slice(4)); }
  return out;
}
const normBackup = c => String(c || '').toLowerCase().replace(/[^a-z2-7]/g, '');
const hashBackup = (userId, code) => crypto.createHash('sha256').update('solver-backup:' + userId + ':' + normBackup(code)).digest('hex');
const looksLikeBackup = c => normBackup(c).length === 8;

// ---------- Google sign-in (OpenID Connect, authorization-code flow) ----------
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const deps = { fetch: (...a) => globalThis.fetch(...a), now: () => Date.now() }; // replaced in tests
const googleOn = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const allowedDomains = () => String(process.env.GOOGLE_ALLOWED_DOMAINS || '').split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
function googleAuthUrl({ redirectUri, state, nonce }) {
  const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' });
  const doms = allowedDomains(); if (doms.length === 1) p.set('hd', doms[0]);
  return GOOGLE_AUTH + '?' + p.toString();
}
let jwksCache = { at: 0, ttl: 0, keys: [] };
async function googleKeys(force) {
  if (!force && jwksCache.keys.length && deps.now() - jwksCache.at < jwksCache.ttl) return jwksCache.keys;
  const r = await deps.fetch(GOOGLE_JWKS, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Could not load Google’s signing keys.');
  const j = await r.json();
  const m = /max-age=(\d+)/.exec(String((r.headers && r.headers.get && r.headers.get('cache-control')) || ''));
  jwksCache = { at: deps.now(), ttl: Math.min(Number(m ? m[1] : 3600), 86400) * 1000, keys: Array.isArray(j.keys) ? j.keys : [] };
  return jwksCache.keys;
}
const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
// Checks the ID token's RS256 signature against Google's published keys, then iss / aud / exp / iat / nonce / email_verified.
async function verifyGoogleIdToken(idToken, { clientId, nonce }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Google sent a malformed sign-in token.');
  const [h, p, s] = parts; let header, claims;
  try { header = b64json(h); claims = b64json(p); } catch (e) { throw new Error('Google sent a malformed sign-in token.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unexpected sign-in token type.');
  let jwk = (await googleKeys(false)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('The sign-in token was signed with an unknown key.');
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(s, 'base64url'))) throw new Error('The sign-in token’s signature is not valid.');
  const nowS = Math.floor(deps.now() / 1000);
  if (!GOOGLE_ISS.includes(claims.iss)) throw new Error('The sign-in token did not come from Google.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('The sign-in token is for a different app.');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) throw new Error('The sign-in token is for a different app.');
  if (!(Number(claims.exp) > nowS - 60)) throw new Error('The sign-in token has expired. Try again.');
  if (claims.iat && Number(claims.iat) > nowS + 300) throw new Error('The sign-in token is dated in the future.');
  if (!nonce || claims.nonce !== nonce) throw new Error('The sign-in attempt did not match. Try again.');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Your Google email address is not verified.');
  if (!claims.email) throw new Error('Google did not share an email address.');
  return claims;
}
async function googleExchange(code, redirectUri) {
  const body = new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const r = await deps.fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(10000) });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || !j.id_token) throw new Error('Google did not accept the sign-in. Try again.');
  return j.id_token;
}
function domainAllowed(email) {
  const doms = allowedDomains(); if (!doms.length) return true;
  return doms.includes(String(email).toLowerCase().split('@').pop());
}

module.exports = { base32Encode, base32Decode, hotp, totp, verifyTotp, counterAt, newSecret, otpauthUri, newBackupCodes, hashBackup, looksLikeBackup,
  googleOn, googleAuthUrl, googleExchange, verifyGoogleIdToken, domainAllowed, allowedDomains, deps, GOOGLE_TOKEN, GOOGLE_JWKS };
