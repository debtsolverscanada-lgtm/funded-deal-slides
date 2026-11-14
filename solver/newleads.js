// "NEW LEAD" banners (DebtSolvers boards only).
//
//   When a brand-new lead lands on a DebtSolvers board (from the Monday copy or a lead link), it is noted here with
//   its name, email and phone. Everyone who can see that board gets a big banner in the app until they close it
//   (X). Several at once stack: closing one shows the next. A lead moved from another board, an old item copied in
//   late (created more than NEWLEAD_MAX_AGE_H hours ago, default 6) and MortgageSolvers boards never banner.
//   NEW_LEAD_BANNERS=off stops new ones. Banners older than 48 hours aren't shown.
'use strict';

module.exports = function newleads({ db, q, now, HttpError, readBody, send, canSee, boardInfo, itemVisible = () => true }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_arrivals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, board TEXT NOT NULL, item TEXT NOT NULL,
      name TEXT, email TEXT, phone TEXT, UNIQUE(board, item)
    );
    CREATE INDEX IF NOT EXISTS lead_arrivals_at ON lead_arrivals(at);
    CREATE TABLE IF NOT EXISTS lead_seen (user_id TEXT NOT NULL, arrival INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (user_id, arrival));
  `);
  try { db.exec("ALTER TABLE lead_arrivals ADD COLUMN kind TEXT NOT NULL DEFAULT 'lead'"); } catch (e) { /* already there */ }
  const env = k => String(process.env[k] || '').trim();
  // a lead board has the sales groups (Pitched + Signed); the Clients board gets "NEW CLIENT"; anything else: nothing
  const kindOf = b => { const g = (b.groups || []).map(x => String(x.name || '')); if (g.some(n => /pitch/i.test(n)) && g.some(n => /signed/i.test(n))) return 'lead'; if (/^clients?$/i.test(String(b.name || '').trim())) return 'client'; return ''; };
  const off = () => env('NEW_LEAD_BANNERS').toLowerCase() === 'off';
  const isDebtSolvers = b => { const w = b.workspace || {}; return !!w.id && w.id !== 'main' && !/mortgage\s*solver/i.test(w.name || ''); };
  const phone10 = s => { const d = String(s || '').replace(/\D/g, ''); const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d; return t.length === 10 ? t : ''; };

  // banners recorded before kinds existed: label them again by their board (Clients -> NEW CLIENT, others dropped)
  try { for (const r of db.prepare('SELECT DISTINCT board FROM lead_arrivals').all()) { const d = q.doc.get('boards/' + r.board); const k = d ? kindOf(JSON.parse(d.data)) : '';
    if (!k) db.prepare('DELETE FROM lead_arrivals WHERE board = ?').run(r.board); else db.prepare('UPDATE lead_arrivals SET kind = ? WHERE board = ?').run(k, r.board); } } catch (e) { console.error('new lead kinds:', e.message); }
  // Called when an item is saved for the first time on a board
  function noteItem(bid, iid, doc) {
    try {
      if (off() || !doc) return;
      const r = q.doc.get('boards/' + bid); if (!r) return; const b = JSON.parse(r.data);
      if (!isDebtSolvers(b)) return;
      const kind = kindOf(b); if (!kind) return;
      if (/\(copy\)/i.test(String(doc.name || ''))) return;
      const created = Date.parse(doc.createdAt || doc.created_at || '') || Date.now();
      if (Date.now() - created > (Number(env('NEWLEAD_MAX_AGE_H')) || 6) * 3600e3) return; // an old item, not a new lead
      // moved here from another board (same id already on a different board): not new
      if (db.prepare("SELECT 1 FROM docs WHERE id = ? AND col LIKE 'boards/%/items' AND col != ?").get(String(iid), `boards/${bid}/items`)) return;
      const cols = b.columns || [], v = doc.values || {};
      const email = (cols.filter(c => c.type === 'email').map(c => String(v[c.id] || '').trim()).find(x => x.includes('@')) || '').slice(0, 200);
      const phone = cols.filter(c => c.type === 'phone' || /phone|mobile|cell/i.test(c.title || '')).map(c => phone10(v[c.id])).find(Boolean) || '';
      if (!email && !phone) return; // not a lead (a task, a note…)
      db.prepare('INSERT OR IGNORE INTO lead_arrivals (at, board, item, name, email, phone, kind) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), String(bid), String(iid), String(doc.name || '').slice(0, 120), email, phone, kind);
    } catch (e) { console.error('new lead banner:', e.message); }
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (p === '/api/leads/new' && method === 'GET') {
      const since = new Date(Date.now() - 48 * 3600e3).toISOString();
      const rows = db.prepare('SELECT a.* FROM lead_arrivals a LEFT JOIN lead_seen s ON s.arrival = a.id AND s.user_id = ? WHERE s.arrival IS NULL AND a.at > ? ORDER BY a.id LIMIT 200').all(user.id, since);
      const out = [];
      for (const r of rows) {
        const info = boardInfo(r.board); if (!info || !canSee(user, info.access)) continue;
        const ir = q.doc.get(`boards/${r.board}/items/${r.item}`); if (!ir) continue; // deleted since
        if (!itemVisible(user, info, JSON.parse(ir.data))) continue; // "only items assigned to them" boards: just theirs
        out.push({ id: r.id, at: r.at, board: r.board, boardName: info.name, item: r.item, name: r.name, email: r.email, phone: r.phone, kind: r.kind || 'lead' });
      }
      return send(res, 200, { leads: out }), true;
    }
    if (p === '/api/leads/seen' && method === 'POST') {
      const b = await readBody(req, 16 * 1024); const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
      const ins = db.prepare('INSERT OR IGNORE INTO lead_seen (user_id, arrival, at) VALUES (?, ?, ?)');
      for (const id of ids) ins.run(user.id, id, now());
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }
  // tidy: forget banners older than 30 days
  setInterval(() => { try { const t = new Date(Date.now() - 30 * 864e5).toISOString(); db.prepare('DELETE FROM lead_seen WHERE arrival IN (SELECT id FROM lead_arrivals WHERE at < ?)').run(t); db.prepare('DELETE FROM lead_arrivals WHERE at < ?').run(t); } catch (e) {} }, 6 * 3600e3).unref();
  return { handle, noteItem };
};
