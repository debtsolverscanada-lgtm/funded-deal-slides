// Write-back to Monday, for the boards listed in MONDAY_WRITEBACK_BOARDS (e.g. "m7963934529" = Jerico Leads).
//
//   When someone changes a lead on one of those boards in Solver.ca — moves it to another group, changes a column,
//   renames it, writes a note — the same change is made on the Monday item within seconds. Monday's own automations
//   and the n8n webhooks listening to that board (Discord follow-ups, Meta lead stages, Signed → Clients + Deals,
//   the Clients pipeline) then run exactly as if the change had been made in Monday.
//   Emails/texts sent from Solver.ca and their replies are posted to the Monday item as notes too.
//   New items and deletions are NOT written (leads arrive in Monday first). Each write is logged (monday_out);
//   a failed write is retried 3 times. MONDAY_WRITEBACK=off stops all writes.
'use strict';

module.exports = function mondaywrite({ db, q, now, broadcast, HttpError, send }) {
  db.exec(`CREATE TABLE IF NOT EXISTS monday_out (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, board TEXT NOT NULL, item TEXT NOT NULL, op TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, error TEXT, done_at TEXT, by TEXT)`);
  const env = k => String(process.env[k] || '').trim();
  const boards = () => new Set(env('MONDAY_WRITEBACK_BOARDS').split(/[\s,]+/).filter(Boolean));
  const on = bid => env('MONDAY_WRITEBACK').toLowerCase() !== 'off' && !!env('MONDAY_API_TOKEN') && boards().has(String(bid));
  const mondayId = (bid, iid, doc) => { const m = String((doc && doc.mondayId) || iid); return /^\d+$/.test(m) ? m : ''; };
  const boardMid = (bid, b) => String((b && b.mondayId) || String(bid).replace(/^m/, ''));

  async function gql(query, variables) {
    const r = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { Authorization: env('MONDAY_API_TOKEN'), 'Content-Type': 'application/json', 'API-Version': '2024-10' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.errors || d.error_message) throw new Error(((d.errors || [])[0] || {}).message || d.error_message || 'Monday answered ' + r.status);
    return d.data;
  }
  // Monday's own column types (Solver.ca's copy simplifies some), cached per board
  const colCache = new Map();
  async function mondayCols(bmid) {
    const c = colCache.get(bmid); if (c && Date.now() - c.t < 30 * 60e3) return c.v;
    const d = await gql('query($b: [ID!]) { boards(ids: $b) { columns { id type } } }', { b: [bmid] });
    const v = new Map((((d.boards || [])[0] || {}).columns || []).map(x => [x.id, x.type])); colCache.set(bmid, { t: Date.now(), v }); return v;
  }
  // one Solver.ca value in the shape Monday's change_multiple_column_values wants; undefined = can't write this type
  function toMonday(type, v) {
    const empty = v === undefined || v === null || v === '';
    switch (type) {
      case 'text': case 'name': return empty ? '' : String(v);
      case 'long_text': return empty ? {} : { text: String(v) };
      case 'numbers': return empty ? '' : String(v);
      case 'status': case 'color': return empty ? {} : { index: Number(v) };
      case 'date': return empty ? {} : { date: String(v).slice(0, 10) };
      case 'phone': return empty ? {} : { phone: String(v).replace(/[^\d+]/g, ''), countryShortName: 'CA' };
      case 'email': return empty ? {} : { email: String(v), text: String(v) };
      case 'checkbox': return v ? { checked: 'true' } : {};
      case 'link': { if (empty) return {}; const m = /^(.*?)\s+-\s+(https?:\/\/\S+)$/.exec(String(v)); return m ? { url: m[2], text: m[1] } : { url: String(v), text: String(v) }; }
      default: return undefined; // people, files, dropdowns, connections, formulas… stay as Monday has them
    }
  }

  // ---------- queue ----------
  const add = (bid, iid, op, payload, by) => { db.prepare("INSERT INTO monday_out (at, board, item, op, payload, status, by) VALUES (?, ?, ?, ?, ?, 'queued', ?)").run(now(), String(bid), String(iid), op, JSON.stringify(payload), by || ''); kick(); };
  let busy = false, again = false;
  function kick() { if (busy) { again = true; return; } run().catch(e => console.error('monday write:', e.message)); }
  async function run() {
    busy = true;
    try {
      for (;;) {
        const r = db.prepare("SELECT * FROM monday_out WHERE status = 'queued' ORDER BY id LIMIT 1").get(); if (!r) break;
        const p = JSON.parse(r.payload);
        try {
          if (r.op === 'move') await gql('mutation($i: ID!, $g: String!) { move_item_to_group(item_id: $i, group_id: $g) { id } }', { i: p.mid, g: p.group });
          else if (r.op === 'values') await gql('mutation($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v, create_labels_if_missing: false) { id } }', { b: p.bmid, i: p.mid, v: JSON.stringify(p.values) });
          else if (r.op === 'update') {
            const d = await gql('mutation($i: ID!, $t: String!) { create_update(item_id: $i, body: $t) { id } }', { i: p.mid, t: p.text });
            const newMid = d && d.create_update && String(d.create_update.id);
            if (newMid && p.uid) stampMid(r.board, r.item, p.uid, newMid); // so the next Monday copy doesn't add it twice
          }
          db.prepare("UPDATE monday_out SET status = 'done', done_at = ?, tries = tries + 1, error = NULL WHERE id = ?").run(now(), r.id);
        } catch (e) {
          const tries = r.tries + 1;
          db.prepare('UPDATE monday_out SET tries = ?, error = ?, status = ? WHERE id = ?').run(tries, String(e.message).slice(0, 300), tries >= 3 ? 'failed' : 'queued', r.id);
          console.error('monday write failed:', r.op, e.message);
          if (tries < 3) { await new Promise(res => setTimeout(res, 3000 * tries)); }
        }
      }
    } finally { busy = false; if (again) { again = false; kick(); } }
  }
  function stampMid(bid, iid, uid, mid) {
    const path = `boards/${bid}/items/${iid}`, r = q.doc.get(path); if (!r) return;
    const it = JSON.parse(r.data); let hit = false;
    it.updates = (it.updates || []).map(u => u.id === uid && !u.mid ? (hit = true, { ...u, mid }) : u); if (!hit) return;
    q.upsertDoc.run(path, `boards/${bid}/items`, String(iid), JSON.stringify(it), now(), 'monday-write'); broadcast({ op: 'set', col: `boards/${bid}/items`, id: String(iid), data: it });
  }

  // ---------- what changed ----------
  async function onSaved(bid, iid, before, after, user) {
    try {
      if (!on(bid) || !before || !after) return; // new items / deletions aren't written
      const br = q.doc.get('boards/' + bid); if (!br) return; const b = JSON.parse(br.data);
      const mid = mondayId(bid, iid, after.mondayId ? after : before); if (!mid) return;
      const who = user ? (user.name || user.email) : '';
      if (after.group && after.group !== before.group) add(bid, iid, 'move', { mid, group: after.group }, who);
      const cols = await mondayCols(boardMid(bid, b)), values = {};
      if (after.name !== before.name && after.name) values.name = String(after.name);
      const keys = new Set([...Object.keys(after.values || {}), ...Object.keys(before.values || {})].filter(k => !/__d?t$/.test(k)));
      for (const k of keys) {
        const a = (after.values || {})[k], bv = (before.values || {})[k]; if (JSON.stringify(a ?? '') === JSON.stringify(bv ?? '')) continue;
        const t = cols.get(k); if (!t) continue; const mv = toMonday(t, a); if (mv !== undefined) values[k] = mv;
      }
      if (Object.keys(values).length) add(bid, iid, 'values', { mid, bmid: boardMid(bid, b), values }, who);
      const old = new Set((before.updates || []).map(u => u.id || u.mid || u.at));
      for (const u of after.updates || []) {
        if (u.mid || old.has(u.id || u.mid || u.at) || !u.text) continue; // already in Monday, or not new
        add(bid, iid, 'update', { mid, uid: u.id, text: `${String(u.text).slice(0, 5000)}\n\n— ${u.byName || who || 'Solver.ca'} (in Solver.ca)` }, who);
      }
    } catch (e) { console.error('monday write (diff):', e.message); }
  }
  // a note posted by the server itself (email sent, reply received, text sent…)
  function onNote(bid, iid, upd) {
    try {
      if (!on(bid) || !upd || !upd.text) return;
      const r = q.doc.get(`boards/${bid}/items/${iid}`); if (!r) return; const it = JSON.parse(r.data);
      const mid = mondayId(bid, iid, it); if (!mid) return;
      add(bid, iid, 'update', { mid, uid: upd.id, text: `${String(upd.text).slice(0, 5000)}\n\n— ${upd.byName || 'Solver.ca'} (in Solver.ca)` }, upd.byName || '');
    } catch (e) { console.error('monday write (note):', e.message); }
  }

  async function handle(req, res, url, user) {
    if (url.pathname === '/api/monday-out/boards' && req.method === 'GET') return send(res, 200, { boards: env('MONDAY_WRITEBACK').toLowerCase() === 'off' ? [] : [...boards()] }), true;
    if (url.pathname === '/api/monday-out' && req.method === 'GET') {
      if (!user || user.role !== 'admin') throw new HttpError(403, 'Admins only.');
      return send(res, 200, { on: [...boards()], rows: db.prepare('SELECT id, at, board, item, op, status, tries, error, done_at, by FROM monday_out ORDER BY id DESC LIMIT 100').all() }), true;
    }
    return false;
  }
  setTimeout(kick, 5000).unref();
  return { handle, onSaved, onNote, on };
};
