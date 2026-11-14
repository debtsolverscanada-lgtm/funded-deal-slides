// Write-back to Monday, for the boards listed in MONDAY_WRITEBACK_BOARDS (e.g. "m7963934529" = Jerico Leads).
//
//   When someone changes a lead on one of those boards in Solver.ca — moves it to another group, changes a column,
//   renames it, writes a note — the same change is made on the Monday item within seconds. Monday's own automations
//   and the n8n webhooks listening to that board (Discord follow-ups, Meta lead stages, Signed → Clients + Deals,
//   the Clients pipeline) then run exactly as if the change had been made in Monday.
//   Emails/texts sent from Solver.ca and their replies are posted to the Monday item as notes too.
//   New items and deletions are NOT written (leads arrive in Monday first). Each write is logged (monday_out);
//   a failed write is retried 5 times (3s-24s apart) and again after a restart if it failed in the last day. MONDAY_WRITEBACK=off stops all writes.
'use strict';

module.exports = function mondaywrite({ db, q, now, broadcast, HttpError, send, readBody, mustSee, canWrite }) {
  db.exec(`CREATE TABLE IF NOT EXISTS monday_out (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, board TEXT NOT NULL, item TEXT NOT NULL, op TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, error TEXT, done_at TEXT, by TEXT)`);
  const env = k => String(process.env[k] || '').trim();
  const boards = () => new Set(env('MONDAY_WRITEBACK_BOARDS').split(/[\s,]+/).filter(Boolean));
  const on = bid => env('MONDAY_WRITEBACK').toLowerCase() !== 'off' && !!env('MONDAY_API_TOKEN') && boards().has(String(bid));
  // the Monday item this lead is on this board's Monday copy. A lead moved or copied here from another board (it keeps its
  // old numeric id, and a "move to board" rule keeps the old board's mondayId) is NOT an item of this Monday board: writing
  // its id would move/annotate the other rep's Monday lead, so it isn't written at all.
  const mondayId = (bid, iid, doc, b) => {
    if (doc && (doc.movedFromMondayId || (doc.copiedFrom && !String(doc.copiedFrom).startsWith(bid + '/')))) return '';
    const m = String((doc && doc.mondayId) || (b && b.source === 'monday' ? '' : iid)); return /^\d+$/.test(m) ? m : '';
  };
  const boardMid = (bid, b) => String((b && b.mondayId) || String(bid).replace(/^m/, ''));
  // Monday's update body is HTML: escape what was typed and keep the line breaks
  const toHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r?\n/g, '<br>');

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
      case 'status': case 'color': return empty ? {} : /^\d+$/.test(String(v)) ? { index: Number(v) } : undefined; // a label made in Solver.ca only (id like "lab12x") isn't in Monday: leave Monday's status alone, never send index null
      case 'date': return empty ? {} : { date: String(v).slice(0, 10) };
      case 'phone': {
        if (empty) return {};
        // extension dropped, never glued onto the number; text that isn't a number leaves Monday's phone alone (undefined), never wipes it
        const p = String(v).replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, '').trim(), d = p.replace(/\D/g, '');
        if (/[a-z]/i.test(p) || d.length < 7 || d.length > 15) return undefined;
        if (!p.startsWith('+') || d[0] === '1') return { phone: p.replace(/[^\d+]/g, ''), countryShortName: 'CA' }; // local or +1 (Canada/US)
        const cc = { 44: 'GB', 33: 'FR', 49: 'DE', 39: 'IT', 34: 'ES', 31: 'NL', 32: 'BE', 41: 'CH', 353: 'IE', 351: 'PT', 61: 'AU', 64: 'NZ', 91: 'IN', 92: 'PK', 63: 'PH', 86: 'CN', 852: 'HK', 81: 'JP', 82: 'KR', 52: 'MX', 55: 'BR', 27: 'ZA', 234: 'NG', 971: 'AE', 966: 'SA', 90: 'TR', 48: 'PL', 380: 'UA', 7: 'RU', 84: 'VN' };
        const k = [3, 2, 1].map(n => d.slice(0, n)).find(x => cc[x]);
        return k ? { phone: '+' + d, countryShortName: cc[k] } : undefined; // a country we can't tell isn't sent tagged as Canada
      }
      case 'email': return empty ? {} : { email: String(v), text: String(v) };
      case 'checkbox': return v ? { checked: 'true' } : {};
      case 'link': { if (empty) return {}; const m = /^(.*?)\s+-\s+(https?:\/\/\S+)$/.exec(String(v)); return m ? { url: m[2], text: m[1] } : { url: String(v), text: String(v) }; }
      default: return undefined; // people, files, dropdowns, connections, formulas… stay as Monday has them
    }
  }

  // A Monday date with a time (Solver.ca keeps the instant in "<col>__dt" and shows the local day): Monday stores it in UTC,
  // so a new day is sent as that instant moved to the new day — the time stays, never wiped by a { date } alone.
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: env('KS_TIMEZONE') || 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
  function withTime(day, dt) {
    const t = Date.parse(dt), d = Date.parse(String(day || '').slice(0, 10)); if (isNaN(t) || isNaN(d)) return null;
    const iso = new Date(t + Math.round((d - Date.parse(dayFmt.format(new Date(t)))) / 864e5) * 864e5).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
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
        db.prepare("UPDATE monday_out SET status = 'sending' WHERE id = ?").run(r.id); // claimed: a restart mid-call never posts the same note twice
        // a write retried late (e.g. re-queued after a restart) never undoes a newer change that already reached Monday:
        // a later move of the same item wins, and so do the columns a later write already set
        if (r.op === 'move' || r.op === 'values') {
          const later = db.prepare("SELECT payload FROM monday_out WHERE board = ? AND item = ? AND op = ? AND id > ? AND status = 'done'").all(r.board, r.item, r.op, r.id).map(x => JSON.parse(x.payload));
          if (r.op === 'move' && later.length) { db.prepare("UPDATE monday_out SET status = 'skipped', error = 'A newer move was already sent', done_at = ? WHERE id = ?").run(now(), r.id); continue; }
          for (const l of later) {
            const ks = new Set([...Object.keys(l.values || {}), ...Object.keys((l.raw && l.raw.values) || {}), ...(l.raw && l.raw.name !== undefined ? ['name'] : [])]);
            for (const k of ks) { if (p.values) delete p.values[k]; if (p.raw && p.raw.values) delete p.raw.values[k]; if (k === 'name' && p.raw) delete p.raw.name; }
          }
        }
        try {
          if (r.op === 'values' && p.raw) { // queued while Monday's column types couldn't be read: converted now
            const cols = await mondayCols(p.bmid); p.values = {};
            if (p.raw.name !== undefined) p.values.name = p.raw.name;
            for (const [k, a] of Object.entries(p.raw.values || {})) { const t = cols.get(k); if (!t) continue; const mv = t === 'date' && p.raw.dt && p.raw.dt[k] ? p.raw.dt[k] : toMonday(t, a); if (mv !== undefined) p.values[k] = mv; }
          }
          if (r.op === 'values' && !Object.keys(p.values || {}).length) { /* nothing Monday can take */ }
          else if (r.op === 'move') await gql('mutation($i: ID!, $g: String!) { move_item_to_group(item_id: $i, group_id: $g) { id } }', { i: p.mid, g: p.group });
          else if (r.op === 'values') await gql('mutation($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v, create_labels_if_missing: false) { id } }', { b: p.bmid, i: p.mid, v: JSON.stringify(p.values) });
          else if (r.op === 'update') {
            const d = await gql('mutation($i: ID!, $t: String!) { create_update(item_id: $i, body: $t) { id } }', { i: p.mid, t: toHtml(p.text) });
            const newMid = d && d.create_update && String(d.create_update.id);
            if (newMid && p.uid) stampMid(r.board, r.item, p.uid, newMid); // so the next Monday copy doesn't add it twice
          }
          db.prepare("UPDATE monday_out SET status = 'done', done_at = ?, tries = tries + 1, error = NULL WHERE id = ?").run(now(), r.id);
        } catch (e) {
          const tries = r.tries + 1;
          db.prepare('UPDATE monday_out SET tries = ?, error = ?, status = ? WHERE id = ?').run(tries, String(e.message).slice(0, 300), tries >= 5 ? 'failed' : 'queued', r.id);
          console.error('monday write failed:', r.op, e.message);
          if (tries < 5) { await new Promise(res => setTimeout(res, 3000 * 2 ** (tries - 1))); } // 3s, 6s, 12s, 24s
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
      const mid = mondayId(bid, iid, after.mondayId ? after : before, b); if (!mid) return;
      const who = user ? (user.name || user.email) : '';
      if (after.group && after.group !== before.group) add(bid, iid, 'move', { mid, group: after.group }, who);
      const old = new Set((before.updates || []).map(u => u.id || u.mid || u.at));
      for (const u of after.updates || []) {
        if (u.mid || old.has(u.id || u.mid || u.at) || !u.text) continue; // already in Monday, or not new
        add(bid, iid, 'update', { mid, uid: u.id, text: `${String(u.text).slice(0, 5000)}\n\n— ${u.byName || who || 'Solver.ca'} (in Solver.ca)` }, who);
      }
      const values = {}, raw = { values: {} };
      if (after.name !== before.name && after.name) values.name = raw.name = String(after.name);
      const keys = new Set([...Object.keys(after.values || {}), ...Object.keys(before.values || {})].filter(k => !/__d?t$/.test(k)));
      for (const k of keys) {
        const a = (after.values || {})[k], bv = (before.values || {})[k]; if (JSON.stringify(a ?? '') === JSON.stringify(bv ?? '')) continue;
        raw.values[k] = a ?? '';
        const dt = (after.values || {})[k + '__dt'], wt = a && dt ? withTime(a, dt) : null;
        if (wt) (raw.dt = raw.dt || {})[k] = wt;
      }
      // queued right away and converted to Monday's column types when sent: two quick changes reach Monday in the order
      // they were made (waiting here for the column types could let the second one queue first and be overwritten)
      if (Object.keys(raw.values).length) add(bid, iid, 'values', { mid, bmid: boardMid(bid, b), raw }, who);
      else if (values.name) add(bid, iid, 'values', { mid, bmid: boardMid(bid, b), values }, who);
    } catch (e) { console.error('monday write (diff):', e.message); }
  }
  // a note posted by the server itself (email sent, reply received, text sent…)
  function onNote(bid, iid, upd) {
    try {
      if (!on(bid) || !upd || !upd.text) return;
      const r = q.doc.get(`boards/${bid}/items/${iid}`); if (!r) return; const it = JSON.parse(r.data);
      const br = q.doc.get('boards/' + bid);
      const mid = mondayId(bid, iid, it, br ? JSON.parse(br.data) : null); if (!mid) return;
      add(bid, iid, 'update', { mid, uid: upd.id, text: `${String(upd.text).slice(0, 5000)}\n\n— ${upd.byName || 'Solver.ca'} (in Solver.ca)` }, upd.byName || '');
    } catch (e) { console.error('monday write (note):', e.message); }
  }

  async function handle(req, res, url, user) {
    if (url.pathname === '/api/monday-out/boards' && req.method === 'GET') return send(res, 200, { boards: env('MONDAY_WRITEBACK').toLowerCase() === 'off' ? [] : [...boards()] }), true;
    if (url.pathname === '/api/monday-out' && req.method === 'GET') {
      if (!user || user.role !== 'admin') throw new HttpError(403, 'Admins only.');
      return send(res, 200, { on: [...boards()], rows: db.prepare('SELECT id, at, board, item, op, status, tries, error, done_at, by FROM monday_out ORDER BY id DESC LIMIT 100').all() }), true;
    }
    // a group added in Solver.ca on a write-back board is made in Monday first, so leads moved into it use Monday's group id
    if (url.pathname === '/api/monday-out/group' && req.method === 'POST') {
      if (!canWrite(user)) throw new HttpError(403, 'You can view this board but not change it.');
      const body = await readBody(req, 16 * 1024), bid = String(body.board || ''), name = String(body.name || '').trim().slice(0, 255) || 'New group';
      mustSee(user, bid);
      if (!on(bid)) return send(res, 200, { id: null }), true;
      const br = q.doc.get('boards/' + bid); const b = br ? JSON.parse(br.data) : null;
      if (body.group) { // a rename
        try { await gql('mutation($b: ID!, $g: String!, $n: String!) { update_group(board_id: $b, group_id: $g, group_attribute: title, new_value: $n) { id } }', { b: boardMid(bid, b), g: String(body.group), n: name }); }
        catch (e) { throw new HttpError(502, 'Monday didn’t rename the group: ' + e.message); }
        return send(res, 200, { id: String(body.group) }), true;
      }
      let d; try { d = await gql('mutation($b: ID!, $n: String!) { create_group(board_id: $b, group_name: $n) { id } }', { b: boardMid(bid, b), n: name }); }
      catch (e) { throw new HttpError(502, 'Monday didn’t create the group: ' + e.message); }
      const id = d && d.create_group && String(d.create_group.id || '');
      if (!id) throw new HttpError(502, 'Monday didn’t create the group. Try again.');
      return send(res, 200, { id }), true;
    }
    return false;
  }
  // on boot: a write cut off by a restart is sent again, except a note (Monday may already have it, and a note twice can't be undone);
  // a write that failed in the last day (e.g. Monday was down) gets another round of tries
  db.prepare("UPDATE monday_out SET status = 'failed', error = 'Interrupted by a server restart; it may already be in Monday, so it wasn’t posted again' WHERE status = 'sending' AND op = 'update'").run();
  db.prepare("UPDATE monday_out SET status = 'queued' WHERE status = 'sending'").run();
  db.prepare("UPDATE monday_out SET status = 'queued', tries = 0 WHERE status = 'failed' AND at > ? AND COALESCE(error, '') NOT LIKE 'Interrupted%' AND NOT (op = 'update' AND (COALESCE(error, '') LIKE '%abort%' OR COALESCE(error, '') LIKE '%timeout%' OR COALESCE(error, '') LIKE '%timed out%'))").run(new Date(Date.now() - 864e5).toISOString());
  setTimeout(kick, 5000).unref();
  return { handle, onSaved, onNote, on };
};
