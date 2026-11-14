// One-off: set who can see each board copied from Monday, without a full re-copy.
// Reads Monday only (board kind, subscribers and owners); never writes to Monday.
//
//   MONDAY_API_TOKEN=... MONDAY_WORKSPACE_IDS=11508737,7066043 DATA_DIR=/data node scripts/monday-board-access.js [--dry-run]
//
// Private and shareable Monday boards become private in Solver.ca, visible to their subscribers and owners
// (matched by email) and to admins. Main boards stay open. Open pages pick it up after a reload.
'use strict';
const { gql, boardAccess } = require('../monday.js');
const { db, q, now } = require('../server.js');

(async () => {
  const token = process.env.MONDAY_API_TOKEN;
  const workspaces = String(process.env.MONDAY_WORKSPACE_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const dry = process.argv.includes('--dry-run');
  if (!token) { console.error('Set MONDAY_API_TOKEN first.'); process.exit(1); }

  const ours = new Map(); // Monday board id -> Solver.ca board id
  for (const r of q.docsInCol.all('boards')) { try { const d = JSON.parse(r.data); if (d.mondayId) ours.set(String(d.mondayId), r.id); } catch (e) {} }
  if (!ours.size) { console.log('No boards copied from Monday in this database.'); return; }

  const found = new Map();
  const FIELDS = 'id name board_kind subscribers { email } owners { email }';
  for (const ws of workspaces) {
    const boards = (await gql(token, `{ boards(workspace_ids: [${Number(ws)}], limit: 500) { ${FIELDS} } }`)).boards || [];
    boards.forEach(b => found.set(String(b.id), b));
  }
  // Boards in the database that aren't in those workspaces (or no workspaces given): look them up by id.
  const rest = [...ours.keys()].filter(id => !found.has(id));
  for (let k = 0; k < rest.length; k += 25) {
    const boards = (await gql(token, `query($ids: [ID!]) { boards(ids: $ids, limit: 25) { ${FIELDS} } }`, { ids: rest.slice(k, k + 25) })).boards || [];
    boards.forEach(b => found.set(String(b.id), b));
  }

  let changed = 0, missing = 0;
  db.exec('BEGIN');
  try {
    for (const [mid, bid] of ours) {
      const b = found.get(mid);
      const r = q.doc.get('boards/' + bid); if (!r) continue;
      const d = JSON.parse(r.data);
      if (!b) { missing++; console.log(`  ?  ${d.name}: not readable in Monday with this token, left as it is`); continue; }
      const access = boardAccess(b);
      const same = JSON.stringify(d.access || null) === JSON.stringify(access);
      console.log(`  ${access.private ? 'private' : 'open   '}  ${d.name}${access.private ? ` (${access.members.length} ${access.members.length === 1 ? 'person' : 'people'})` : ''}${same ? ' · unchanged' : ''}`);
      if (same) continue;
      d.access = access; changed++;
      if (!dry) q.upsertDoc.run('boards/' + bid, 'boards', bid, JSON.stringify(d), now(), 'monday-access');
    }
    db.exec(dry ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log(`${dry ? 'Would update' : 'Updated'} ${changed} of ${ours.size} boards${missing ? `, ${missing} not found in Monday` : ''}.${dry ? '' : ' Reload Solver.ca pages to see it.'}`);
})().catch(e => { console.error(e.message); process.exit(1); });
