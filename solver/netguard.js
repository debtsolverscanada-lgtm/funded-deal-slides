// Solver.ca outgoing requests to addresses people typed in (webhooks, push endpoints).
// Every address the name resolves to is checked, at connect time, so a name can't point at this server or the
// private network (loopback, private ranges, link-local, CGNAT, ULA, IPv4-mapped IPv6, unspecified, multicast).
// Redirects are never followed. KS_ALLOW_PRIVATE_WEBHOOKS=1 lifts the address check (local tests only).
'use strict';
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const allowPrivate = () => process.env.KS_ALLOW_PRIVATE_WEBHOOKS === '1';

function v4Private(a) {
  const p = a.split('.').map(Number); if (p.length !== 4 || p.some(x => !(x >= 0 && x <= 255))) return true;
  const [x, y] = p;
  return x === 0 || x === 10 || x === 127 || x >= 224 // this network, private, loopback, multicast + reserved + broadcast
    || (x === 100 && y >= 64 && y <= 127) // CGNAT
    || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
    || (x === 192 && y === 0 && p[2] === 0) || (x === 192 && y === 0 && p[2] === 2) || (x === 198 && (y === 18 || y === 19))
    || (x === 198 && y === 51 && p[2] === 100) || (x === 203 && y === 0 && p[2] === 113);
}
// IPv6 -> 8 numbers, or null
function v6Words(a) {
  let s = String(a).toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) { const p = m.slice(1).map(Number); s = s.slice(0, m.index) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const halves = s.split('::'); if (halves.length > 2) return null;
  const part = h => h ? h.split(':').map(x => /^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN) : [];
  const head = part(halves[0]), back = halves.length === 2 ? part(halves[1]) : [];
  let words;
  if (halves.length === 2) { const fill = 8 - head.length - back.length; if (fill < 0) return null; words = [...head, ...Array(fill).fill(0), ...back]; }
  else words = head;
  return words.length === 8 && words.every(w => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}
function isPrivateAddress(addr) {
  const a = String(addr || '');
  if (net.isIPv4(a)) return v4Private(a);
  if (!net.isIPv6(a.replace(/^\[|\]$/g, ''))) return true;
  const w = v6Words(a); if (!w) return true;
  const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.every(x => x === 0)) return true; // ::
  if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return true; // ::1
  if (w.slice(0, 5).every(x => x === 0) && (w[5] === 0xffff || w[5] === 0)) return v4Private(v4of(w[6], w[7])); // v4-mapped / v4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b) return v4Private(v4of(w[6], w[7])); // NAT64
  if (w[0] === 0x2002) return v4Private(v4of(w[1], w[2])); // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard
  return false;
}

// dns.lookup replacement for http(s).request: refuses names that resolve to any private address.
function guardedLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs || !addrs.length) return cb(Object.assign(new Error('That address does not resolve.'), { code: 'ENOTFOUND' }));
    if (!allowPrivate() && addrs.some(x => isPrivateAddress(x.address))) return cb(Object.assign(new Error('That address points at a private network. Use a public address.'), { code: 'EPRIVATE' }));
    let list = addrs; if (options && options.family) list = addrs.filter(x => x.family === options.family);
    if (!list.length) return cb(Object.assign(new Error('No address of that family.'), { code: 'ENOTFOUND' }));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}
// Throws when a URL can't be used: not http(s), or a name/IP that is (or resolves to) a private address.
async function checkUrl(u, { httpsOnly = false } = {}) {
  let x; try { x = new URL(u); } catch (e) { throw new Error('That isn’t a web address.'); }
  if (!(x.protocol === 'https:' || (!httpsOnly && x.protocol === 'http:'))) throw new Error('Use an https:// address.');
  if (x.username || x.password) throw new Error('Don’t put a user name or password in the address.');
  if (allowPrivate()) return x;
  const host = x.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isPrivateAddress(host)) throw new Error('That address points at a private network. Use a public address.'); return x; }
  const addrs = await dns.promises.lookup(host, { all: true, verbatim: true }).catch(() => { throw new Error('That address does not resolve.'); });
  if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new Error('That address points at a private network. Use a public address.');
  return x;
}
// POST without following redirects; every resolved address is checked when connecting. Resolves to { status, ok }.
function safePost(u, { headers = {}, body = '', timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let x; try { x = new URL(u); } catch (e) { return reject(new Error('Bad address.')); }
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return reject(new Error('Only http(s) addresses.'));
    const host = x.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate() && isPrivateAddress(host)) return reject(new Error('That address points at a private network.'));
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const mod = x.protocol === 'https:' ? https : http;
    const req = mod.request(x, { method: 'POST', headers: { ...headers, 'Content-Length': buf.length }, lookup: guardedLookup, timeout, agent: false }, res => {
      res.resume(); // the body isn't needed
      res.on('end', () => {}); resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out.')));
    req.on('error', reject);
    req.end(buf);
  });
}
// Web Push services browsers use. Anything else is refused (loopback too, unless KS_ALLOW_PRIVATE_WEBHOOKS=1 for tests).
function pushHostOk(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  const h = x.hostname.toLowerCase();
  if (allowPrivate() && (h === '127.0.0.1' || h === 'localhost' || h === '[::1]')) return x.protocol === 'http:' || x.protocol === 'https:';
  if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false;
  return h === 'fcm.googleapis.com' || h === 'web.push.apple.com' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.services\.mozilla\.com$/.test(h) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$/.test(h);
}

// Links people can click: only http(s) addresses or this server's own files. Tabs/newlines browsers ignore are ignored here too.
const urlOk = u => { const s = String(u ?? '').replace(/[\u0000- \u007f]+/g, ''); return /^https?:\/\//i.test(s) || /^\/api\/files\/f_[A-Za-z0-9_-]+(\?[^#]*)?$/.test(s); };
const DANGER = /(^|[\s|,-])(javascript|vbscript|data|file|blob)\s*:/i;
// Every new link in an item: file-column entries, files on updates (and replies), and link-column text.
// `before` is the stored item (links already there are left alone). Returns the first bad link, or null.
function badLink(before, after, linkCols) {
  const old = new Set();
  const walk = (v, f) => { if (Array.isArray(v)) v.forEach(x => walk(x, f)); else if (v && typeof v === 'object') { if ('url' in v) f(v.url); for (const k of Object.keys(v)) if (k !== 'url') walk(v[k], f); } };
  if (before) walk([before.values, before.updates, before.subitems], u => old.add(String(u)));
  let bad = null;
  walk([after && after.values, after && after.updates, after && after.subitems], u => { if (!bad && !old.has(String(u)) && !urlOk(u)) bad = String(u).slice(0, 80); });
  if (bad) return bad;
  for (const cid of linkCols || []) {
    const v = ((after && after.values) || {})[cid], was = ((before && before.values) || {})[cid];
    if (typeof v === 'string' && v !== was && DANGER.test(v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ''))) return v.slice(0, 80);
  }
  return null;
}

module.exports = { isPrivateAddress, checkUrl, safePost, pushHostOk, guardedLookup, urlOk, badLink };
