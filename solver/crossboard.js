// "Copy into / move to another board" automations onto a board the person can't see — e.g. a rep moves a lead to
// Signed and the board's rule copies it to Brandon's Clients board. The rep's browser can't write there, so the
// server does it, but only for a rule that really is on the rep's board, switched on, with that exact action.
'use strict';
const crypto = require('node:crypto');

module.exports = function crossboard({ db, q, now, broadcast, HttpError, readBody, send, mustSee, canWrite, boardInfo }, hooks = {}) {
  const doc = p => { const r = q.doc.get(p); return r ? JSON.parse(r.data) : null; };
  const labelName = (col, v) => { const l = (col.labels || []).find(x => String(x.id) === String(v)); return l ? l.label : null; };
  function mapValues(b, tb, item, map) {
    const values = {}, mapped = new Set();
    const carry = (sc, tc, v, srcId) => {
      if (v === undefined || v === null || v === '') return;
      if (sc && sc.type === 'status' && tc.type === 'status') { const n = labelName(sc, v); const tl = n && (tc.labels || []).find(l => String(l.label).toLowerCase() === n.toLowerCase()); if (!tl) return; v = tl.id; }
      values[tc.id] = v; mapped.add(tc.id);
      const dt = (item.values || {})[srcId + '__dt']; if (dt && tc.type === 'date') values[tc.id + '__dt'] = dt;
    };
    for (const [tgt, src] of Object.entries(map || {})) { const tc = (tb.columns || []).find(c => c.id === tgt), sc = (b.columns || []).find(c => c.id === src); if (tc) carry(sc, tc, (item.values || {})[src], src); }
    for (let [k, v] of Object.entries(item.values || {})) {
      if (k.endsWith('__t') || k.endsWith('__dt')) { const base = k.replace(/__d?t$/, ''); if (!map && (tb.columns || []).some(c => c.id === base)) values[k] = v; continue; }
      if (map && Object.values(map).includes(k)) continue;
      const sc = (b.columns || []).find(c => c.id === k);
      const tc = (tb.columns || []).find(c => c.id === k && (!sc || c.type === sc.type)) || (sc && (tb.columns || []).find(c => String(c.title).toLowerCase() === String(sc.title).toLowerCase() && c.type === sc.type));
      if (!tc || mapped.has(tc.id)) continue;
      if (sc && sc.type === 'status') { const n = labelName(sc, v); const tl = n && (tc.labels || []).find(l => String(l.label).toLowerCase() === n.toLowerCase()); if (!tl) continue; v = tl.id; }
      values[tc.id] = v;
    }
    return values;
  }
  async function handle(req, res, url, user) {
    if (url.pathname !== '/api/rules/crossboard' || req.method !== 'POST') return false;
    const b0 = await readBody(req, 8192);
    const bid = String(b0.board || ''), iid = String(b0.item || ''), ruleId = String(b0.rule || ''), target = String(b0.target || ''), type = b0.type === 'move_board' ? 'move_board' : 'copy_to_board';
    mustSee(user, bid);
    if (!canWrite(user) && user.role !== 'guest') throw new HttpError(403, 'Your account can view this board but not change it.');
    const b = doc('boards/' + bid), item = doc(`boards/${bid}/items/${iid}`); if (!b || !item) throw new HttpError(404, 'No such item.');
    const rule = (b.automations || []).find(r => String(r.id) === ruleId);
    const act = rule && rule.on !== false && (rule.actions || []).find(a => a.type === type && String(a.board) === target);
    if (!act) throw new HttpError(403, 'No switched-on automation on this board does that.');
    const tb = doc('boards/' + target); if (!tb || !boardInfo(target)) throw new HttpError(404, 'The board this automation copies to isn’t in Solver.ca.');
    // a board written back to Monday, copying into a board that is copied from Monday: Monday's own automation makes
    // that copy (and Solver.ca picks it up), so making one here too would double it
    const wb = new Set(String(process.env.MONDAY_WRITEBACK_BOARDS || '').split(/[\s,]+/).filter(Boolean));
    if (wb.has(bid) && tb.source === 'monday' && process.env.MONDAY_WRITEBACK !== 'off') return send(res, 200, { ok: true, viaMonday: true, board: tb.name }), true;
    // the same lead copied there by this rule already (e.g. moved to Signed twice): don't make a second one
    const already = db.prepare("SELECT id FROM docs WHERE col = ? AND json_extract(data, '$.copiedFrom') = ?").get(`boards/${target}/items`, `${bid}/${iid}`);
    if (already && type === 'copy_to_board') return send(res, 200, { ok: true, id: already.id, already: true }), true;
    const g = (tb.groups || []).find(x => x.id === act.group) || (tb.groups || [])[0];
    const newId = type === 'move_board' ? iid : 'i' + crypto.randomBytes(9).toString('base64url');
    const why = rule.title ? `Automation “${String(rule.title).slice(0, 80)}”` : 'Automation';
    const data = { ...item, values: mapValues(b, tb, item, act.map), group: g ? g.id : '', pos: Date.now(), copiedFrom: `${bid}/${iid}`,
      activity: [{ at: now(), by: 'automation', text: `${why} ${type === 'move_board' ? 'moved' : 'copied'} this here from “${b.name}” (${user.name || user.email})` }, ...(type === 'move_board' ? (item.activity || []) : [])].slice(0, 40) };
    delete data.id; if (type !== 'move_board') { delete data.mondayId; data.updates = []; data.createdAt = now(); }
    q.upsertDoc.run(`boards/${target}/items/${newId}`, `boards/${target}/items`, newId, JSON.stringify(data), now(), user.id);
    broadcast({ op: 'set', col: `boards/${target}/items`, id: newId, data });
    if (type === 'move_board') { q.deleteDoc.run(`boards/${bid}/items/${iid}`); broadcast({ op: 'delete', col: `boards/${bid}/items`, id: iid }); }
    try { if (hooks.itemSaved) hooks.itemSaved(target, newId, null, data); } catch (e) { /* sequences only */ }
    try { if (type !== 'move_board' && hooks.newItem) hooks.newItem(target, newId, data); } catch (e) { /* NEW CLIENT banner */ }
    return send(res, 200, { ok: true, id: newId, board: tb.name }), true;
  }
  return { handle };
};
