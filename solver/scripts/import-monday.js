// Loads a Monday export (made by scripts/monday_export.py + scripts/monday_transform.py) into Solver.ca.
// Usage: node scripts/import-monday.js path/to/import-dir [--replace]
// Re-running is safe: boards and items are merged by id, the same way a copy from Monday is (monday.js):
// Monday's columns, labels, groups, values, comments and subitems are refreshed, and everything added in
// Solver.ca stays (its own columns and values, comments, subitems, files, permissions, access edits, automations,
// views). Boards made in Solver.ca are never touched.
// --replace also removes boards copied from Monday that aren't in this export, and items copied from Monday
// that are no longer on their board. It never removes a board or item made in Solver.ca.
const fs = require('node:fs');
const path = require('node:path');
const { db, q, now } = require('../server.js');
const { mergeBoardDoc, mergeItemDoc } = require('../monday.js');
const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/import-monday.js path/to/import-dir [--replace]'); process.exit(1); }
const replace = process.argv.includes('--replace');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const load = p => { const r = q.doc.get(p); if (!r) return null; try { return JSON.parse(r.data); } catch (e) { return null; } };
let n = 0, skipped = 0, removed = 0;
const boardsSeen = new Set(), itemsSeen = new Map(); // board id -> Set of item ids
db.exec('BEGIN');
try {
  for (const part of manifest.parts) {
    const chunks = JSON.parse(fs.readFileSync(path.join(dir, part), 'utf8'));
    for (const { board, items } of chunks) {
      const { id: bid, ...bdata } = board;
      const merged = mergeBoardDoc(load('boards/' + bid), bdata);
      if (!merged) { skipped++; console.log(`Skipped “${bdata.name}”: a board made in Solver.ca already uses that id.`); continue; }
      q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(merged), now(), 'import');
      boardsSeen.add(bid);
      const seen = itemsSeen.get(bid) || new Set(); itemsSeen.set(bid, seen);
      for (const it of items) {
        const { id: iid, ...doc } = it;
        const ip = `boards/${bid}/items/${iid}`, old = load(ip);
        const next = old ? { ...mergeItemDoc(old, doc, bdata.columns || [], bdata.subColumns || []), pos: old.pos != null ? old.pos : doc.pos } : doc;
        q.upsertDoc.run(ip, `boards/${bid}/items`, iid, JSON.stringify(next), now(), 'import');
        seen.add(String(iid));
        n++;
      }
    }
  }
  if (replace) {
    for (const r of q.docsInCol.all('boards')) {
      let d = {}; try { d = JSON.parse(r.data); } catch (e) { continue; }
      if (d.source !== 'monday') continue; // made in Solver.ca: never removed
      if (!boardsSeen.has(r.id)) {
        // a Monday board that's not in this export: only when nothing made in Solver.ca is on it
        const rows = q.docsInCol.all(`boards/${r.id}/items`);
        if (rows.some(x => { try { return !JSON.parse(x.data).mondayId; } catch (e) { return true; } })) { console.log(`Kept “${d.name}”: it has items made in Solver.ca.`); continue; }
        q.deleteDoc.run('boards/' + r.id); q.deleteCol.run(`boards/${r.id}/items`); removed++; // board first: the recycle bin keeps it with its items
        continue;
      }
      const seen = itemsSeen.get(r.id) || new Set();
      for (const x of q.docsInCol.all(`boards/${r.id}/items`)) {
        let it = {}; try { it = JSON.parse(x.data); } catch (e) { continue; }
        if (it.mondayId && !seen.has(String(x.id))) { q.deleteDoc.run(`boards/${r.id}/items/${x.id}`); removed++; }
      }
    }
  }
  q.upsertDoc.run('meta/import', 'meta', 'import', JSON.stringify({ exportedAt: manifest.exported_at, finishedAt: now(), items: n }), now(), 'import');
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`Imported ${boardsSeen.size} boards and ${n} items (Monday export from ${manifest.exported_at}).${skipped ? ` ${skipped} skipped.` : ''}${replace ? ` ${removed} removed.` : ''}`);
