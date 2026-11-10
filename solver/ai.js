// Solver.ca AI columns: a column whose cells are written by Claude from a prompt template that uses the item's
// other columns, like "Summarise {Notes} for {Name} in one line". Runs when someone presses Run (a cell or a whole
// group), and optionally when a column the prompt uses changes.
//
// Needs ANTHROPIC_API_KEY on the server. Without it the column says so and nothing is ever sent anywhere.
// Only the item being filled in is sent, and only after checking the person can see its board and the item.
'use strict';

const API_BASE = () => String(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const DEFAULT_MODEL = 'claude-opus-5-5';
const MODEL_RE = /^claude-[a-z0-9.-]{2,60}$/;
const MAX_PROMPT = 12000, MAX_FIELD = 2000, MAX_RESULT = 4000, MAX_GROUP = 50;
const PER_USER_PER_MIN = 30, GLOBAL_PER_MIN = 120, CONCURRENCY = 3;
const SYSTEM = 'You fill in one cell of a CRM table for a mortgage brokerage. Reply with only the text that belongs in the cell: no preamble, no markdown headings, no quotes around it. Keep it short (under 120 words) unless the instructions ask for more. If the information you need is missing, say what is missing in a few words.';

module.exports = function ai({ db, q, now, broadcast, HttpError, readBody, send, boardInfo, mustSee, itemVisible, canWrite, lockedCols, lockError }) {
  const on = () => !!process.env.ANTHROPIC_API_KEY;
  const model = c => (c && MODEL_RE.test(String(c.model || '')) ? c.model : (MODEL_RE.test(String(process.env.AI_MODEL || '')) ? process.env.AI_MODEL : DEFAULT_MODEL));
  const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

  // ---------- rate limits ----------
  const hits = new Map(); let global = [];
  function allow(uid) {
    const t = Date.now(); global = global.filter(x => t - x < 60000);
    const mine = (hits.get(uid) || []).filter(x => t - x < 60000);
    if (mine.length >= PER_USER_PER_MIN || global.length >= GLOBAL_PER_MIN) { hits.set(uid, mine); return false; }
    mine.push(t); global.push(t); hits.set(uid, mine); return true;
  }
  let running = 0; const waiting = [];
  const slot = () => new Promise(r => { if (running < CONCURRENCY) { running++; r(); } else waiting.push(r); });
  const done = () => { const n = waiting.shift(); if (n) n(); else running--; };

  // ---------- the prompt ----------
  const readable = (b, c, item) => {
    const v = (item.values || {})[c.id];
    if (v == null || v === '') return '';
    if (c.type === 'status') return (((c.labels || []).find(l => l.id === String(v))) || {}).label || '';
    if (Array.isArray(v)) return v.map(x => (x && (x.name || x.url)) || String(x)).join(', ');
    if (c.type === 'checkbox') return v ? 'yes' : 'no';
    return String(v);
  };
  const cap = (s, n) => (s.length > n ? s.slice(0, n) + ' [cut]' : s);
  // {Column Title}, {Name}/{Item}, {Group}, {Updates} (the last five updates)
  function fillPrompt(b, c, item) {
    const cols = b.columns || [], norm = s => String(s || '').trim().toLowerCase();
    let text = String(c.prompt || '').replace(/\{([^{}]{1,80})\}/g, (m, key) => {
      const k = norm(key);
      if (k === 'name' || k === 'item' || k === 'item name') return cap(String(item.name || ''), MAX_FIELD);
      if (k === 'group') return ((b.groups || []).find(g => g.id === item.group) || {}).name || '';
      if (k === 'updates') return cap((item.updates || []).slice(-5).map(u => `${u.byName || 'Someone'} (${String(u.at || '').slice(0, 10)}): ${u.text || ''}`).join('\n'), MAX_FIELD * 2);
      const col = cols.find(x => norm(x.title) === k || x.id === key);
      if (!col || col.id === c.id || col.type === 'ai') return '';
      return cap(readable(b, col, item), MAX_FIELD);
    });
    if (text.length > MAX_PROMPT) text = text.slice(0, MAX_PROMPT) + ' [cut]';
    return text;
  }
  // Which columns a prompt reads (to re-run "on change").
  function promptCols(b, c) {
    const norm = s => String(s || '').trim().toLowerCase(), out = new Set();
    for (const m of String(c.prompt || '').matchAll(/\{([^{}]{1,80})\}/g)) {
      const k = norm(m[1]);
      if (k === 'name' || k === 'item' || k === 'item name') { out.add('__name'); continue; }
      if (k === 'updates') { out.add('__updates'); continue; }
      const col = (b.columns || []).find(x => norm(x.title) === k || x.id === m[1]); if (col && col.id !== c.id) out.add(col.id);
    }
    return out;
  }

  // ---------- one call to the Messages API ----------
  async function callClaude(prompt, mdl) {
    const r = await fetch(API_BASE() + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({ model: mdl, max_tokens: 4000, system: SYSTEM, output_config: { effort: 'low' }, fallbacks: 'default', messages: [{ role: 'user', content: prompt }] }),
    });
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok) {
      const msg = (d && d.error && d.error.message) || `HTTP ${r.status}`;
      throw new Error(r.status === 429 ? 'The AI service is busy. Try again in a minute.' : r.status === 401 ? 'The Anthropic key was refused. Check ANTHROPIC_API_KEY.' : 'The AI service said: ' + String(msg).slice(0, 200));
    }
    if (d && d.stop_reason === 'refusal') throw new Error('Claude declined to fill this cell.');
    const text = ((d && d.content) || []).filter(x => x && x.type === 'text').map(x => x.text).join('').trim();
    if (!text) throw new Error('No answer came back.');
    return { text: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '…' : text, model: (d && d.model) || mdl };
  }

  // Fills one cell and saves it. The item is read fresh after the call so other edits made meanwhile are kept.
  async function runCell(bid, iid, colId, actor) {
    const path = `boards/${bid}/items/${iid}`;
    const r0 = q.doc.get(path); if (!r0) throw new Error('That item is gone.');
    const b = JSON.parse(q.doc.get('boards/' + bid).data), c = (b.columns || []).find(x => x.id === colId && x.type === 'ai');
    if (!c) throw new Error('That AI column is gone.');
    if (!String(c.prompt || '').trim()) throw new Error('Write the column’s prompt first.');
    const prompt = fillPrompt(b, c, JSON.parse(r0.data));
    await slot();
    let out, err = null;
    try { out = await callClaude(prompt, model(c)); } catch (e) { err = e.message || 'The AI call failed.'; } finally { done(); }
    const r = q.doc.get(path); if (!r) return { error: 'That item was deleted.' };
    const item = JSON.parse(r.data);
    item.ai = { ...(item.ai || {}) };
    if (err) item.ai[colId] = { ...(item.ai[colId] || {}), error: err, at: now(), by: actor.name || '' };
    else { item.values = { ...(item.values || {}), [colId]: out.text }; item.ai[colId] = { at: now(), model: out.model, by: actor.name || '' }; }
    q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), now(), actor.id || 'ai');
    broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
    return err ? { error: err } : { ok: true, text: out.text, model: out.model };
  }

  function check(user, bid, colId) {
    if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
    const info = mustSee(user, bid); // never send data from a board this person can't see
    if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
    const b = JSON.parse(q.doc.get('boards/' + bid).data), c = (b.columns || []).find(x => x.id === colId && x.type === 'ai');
    if (!c) throw new HttpError(404, 'No such AI column.');
    if (lockedCols(user, info).has(colId)) throw lockError(info, new Set([colId]));
    if (!on()) { const e = new HttpError(400, 'Add an Anthropic key to turn on AI columns.'); e.code = 'ai_off'; throw e; }
    return { info, b, c };
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/ai/')) return false;
    if (p === '/api/ai/status' && method === 'GET') return send(res, 200, { on: on(), model: model(null), message: on() ? '' : 'Add an Anthropic key to turn on AI columns' });
    if (p === '/api/ai/run' && method === 'POST') {
      const body = await readBody(req); const bid = String(body.board || ''), colId = String(body.col || '');
      const { info, b } = check(user, bid, colId);
      const actor = { id: user.id, name: user.name };
      if (body.item) {
        const iid = String(body.item), r = ID.test(iid) && q.doc.get(`boards/${bid}/items/${iid}`);
        if (!r || !itemVisible(user, info, JSON.parse(r.data))) throw new HttpError(404, 'No such item.');
        if (!allow(user.id)) throw new HttpError(429, 'That’s a lot of AI runs at once. Wait a minute and try again.');
        const out = await runCell(bid, iid, colId, actor);
        if (out.error) throw new HttpError(502, out.error);
        return send(res, 200, out);
      }
      if (body.group) {
        const gid = String(body.group); if (!(b.groups || []).some(g => g.id === gid)) throw new HttpError(404, 'No such group.');
        const items = q.docsInCol.all(`boards/${bid}/items`).map(r => ({ id: r.id, d: JSON.parse(r.data) })).filter(x => x.d.group === gid && itemVisible(user, info, x.d))
          .filter(x => body.onlyEmpty ? !((x.d.values || {})[colId]) : true).slice(0, MAX_GROUP);
        let queued = 0;
        for (const x of items) { if (!allow(user.id)) break; queued++; runCell(bid, x.id, colId, actor).catch(e => console.error('ai:', e.message)); }
        return send(res, 202, { ok: true, queued, skipped: items.length - queued, cap: MAX_GROUP });
      }
      throw new HttpError(400, 'Say which item or group to run.');
    }
    return false;
  }

  // "Run when the columns it uses change" (AI columns with autorun on). Called after a person saves an item.
  const pending = new Map();
  function itemSaved(dp, before, after, user) {
    if (!on() || !before || !after || !user || !user.id) return;
    const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(dp); if (!m) return;
    const [, bid, iid] = m; const r = q.doc.get('boards/' + bid); if (!r) return;
    const b = JSON.parse(r.data);
    for (const c of (b.columns || []).filter(x => x.type === 'ai' && x.autorun && String(x.prompt || '').trim())) {
      const uses = promptCols(b, c);
      const changed = [...uses].some(k => k === '__name' ? before.name !== after.name : k === '__updates' ? (before.updates || []).length !== (after.updates || []).length : JSON.stringify((before.values || {})[k] ?? '') !== JSON.stringify((after.values || {})[k] ?? ''));
      if (!changed) continue;
      const key = `${bid}|${iid}|${c.id}`; clearTimeout(pending.get(key));
      pending.set(key, setTimeout(() => {
        pending.delete(key);
        try { const info = mustSee(user, bid); const cur = q.doc.get(dp); if (!info || !cur || !itemVisible(user, info, JSON.parse(cur.data))) return; } catch (e) { return; }
        if (!allow(user.id)) return;
        runCell(bid, iid, c.id, { id: user.id, name: user.name }).catch(e => console.error('ai:', e.message));
      }, Number(process.env.AI_AUTORUN_DELAY_MS || 4000)));
    }
  }
  return { handle, itemSaved, fillPrompt, promptCols };
};
