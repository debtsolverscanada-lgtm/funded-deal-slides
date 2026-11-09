// Loads a Monday export (made by scripts/monday_export.py + scripts/monday_transform.py) into Keystone.
// Usage: node scripts/import-monday.js path/to/import-dir [--replace]
// Re-running is safe: boards and items are written by id, so existing copies are overwritten, not duplicated.
const fs = require('node:fs');
const path = require('node:path');
const { db, q, now } = require('../server.js');
const dir = process.argv[2];
if (!dir) { console.error('Usage: node scripts/import-monday.js path/to/import-dir [--replace]'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
if (process.argv.includes('--replace')) {
  db.exec("DELETE FROM docs WHERE col = 'boards' OR col LIKE 'boards/%'");
  console.log('Removed existing boards first.');
}
let n = 0;
db.exec('BEGIN');
try {
  for (const part of manifest.parts) {
    const chunks = JSON.parse(fs.readFileSync(path.join(dir, part), 'utf8'));
    for (const { board, items } of chunks) {
      const { id: bid, ...bdata } = board;
      q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(bdata), now(), 'import');
      for (const it of items) {
        const { id: iid, ...doc } = it;
        q.upsertDoc.run(`boards/${bid}/items/${iid}`, `boards/${bid}/items`, iid, JSON.stringify(doc), now(), 'import');
        n++;
      }
    }
  }
  q.upsertDoc.run('meta/import', 'meta', 'import', JSON.stringify({ exportedAt: manifest.exported_at, finishedAt: now(), items: n }), now(), 'import');
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`Imported ${manifest.boards.length} boards and ${n} items (Monday export from ${manifest.exported_at}).`);
