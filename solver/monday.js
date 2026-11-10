// One-way copy from Monday into Solver.ca. Reads Monday only; never writes to it.
// Needs MONDAY_API_TOKEN. Workspaces come from MONDAY_WORKSPACE_IDS (comma-separated).
'use strict';

const API = 'https://api.monday.com/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gql(token, query, variables = {}) {
  for (let t = 0; t < 8; t++) {
    let d;
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2025-04' }, body: JSON.stringify({ query, variables }) });
      if (r.status === 429 || r.status >= 500) { await sleep(Math.min(60000, 2000 * 2 ** t)); continue; }
      d = await r.json();
    } catch (e) { await sleep(Math.min(60000, 2000 * 2 ** t)); continue; }
    const msg = JSON.stringify(d.errors || d.error_message || '');
    if (d.errors || d.error_message) {
      if (/complexity|rate|limit|429|timeout/i.test(msg)) { await sleep(20000); continue; }
      if (/not authenticated|unauthorized|invalid token/i.test(msg)) throw new Error('Monday refused the API token. Check MONDAY_API_TOKEN.');
      throw new Error('Monday API error: ' + msg.slice(0, 300));
    }
    return d.data;
  }
  throw new Error('Monday kept timing out. Try again later.');
}

const SKIP = new Set(['name', 'subtasks']);
// Monday stores date+time in UTC; people see it in the company's time zone.
const TZ = process.env.KS_TIMEZONE || 'America/Toronto';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = iso => dayFmt.format(new Date(iso));
const READONLY = new Set(['mirror', 'last_updated', 'board_relation', 'time_tracking', 'doc', 'direct_doc']);

// Monday's file column text is a comma-separated list of links. Solver.ca keeps [{ name, url }].
function parseFiles(text) {
  if (Array.isArray(text)) return text;
  const s = String(text || '').trim(); if (!s) return [];
  return s.split(/,\s*(?=https?:\/\/)/).map(u => u.trim()).filter(Boolean).map(url => {
    let name = url; try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || url); } catch (e) {}
    return { name, url };
  });
}
// Who can see a board, from Monday: private and shareable boards are limited to their subscribers and owners.
function boardAccess(b) {
  const kind = String(b.board_kind || 'public');
  const members = [...new Set([...(b.subscribers || []), ...(b.owners || [])].map(u => String((u && u.email) || '').trim().toLowerCase()).filter(Boolean))].sort();
  return { private: kind === 'private' || kind === 'share', members, kind, source: 'monday' };
}

function convColumns(cols) {
  const out = [];
  for (const c of cols || []) {
    if (SKIP.has(c.type)) continue;
    let s = {}; try { s = JSON.parse(c.settings_str || '{}') || {}; } catch (e) {}
    const col = { id: c.id, title: c.title };
    if (c.type === 'status') {
      col.type = 'status';
      const pos = s.labels_positions_v2 || {};
      const labels = Object.entries(s.labels || {}).filter(([, v]) => v !== null).map(([k, v]) => {
        const l = { id: String(k), label: v || '(blank)', color: ((s.labels_colors || {})[k] || {}).color || '#c4c4c4' };
        if ((s.labels_descriptions || {})[k]) l.desc = s.labels_descriptions[k];
        if ((s.deactivated_labels || []).includes(Number(k))) l.hidden = true;
        l._p = pos[k] ?? 999; return l;
      }).sort((a, b) => a._p - b._p);
      labels.forEach(l => delete l._p);
      col.labels = labels;
    } else if (c.type === 'people') col.type = 'person';
    else if (c.type === 'date') col.type = 'date';
    else if (c.type === 'phone') col.type = 'phone';
    else if (c.type === 'email') col.type = 'email';
    else if (c.type === 'numbers') {
      col.type = 'number';
      const sym = (s.unit || {}).symbol || '';
      if (sym === '$') col.format = 'currency'; else if (sym === '%') col.format = 'percent';
    } else if (c.type === 'formula') {
      col.type = 'formula'; col.formula = String(s.formula || '');
    } else if (c.type === 'checkbox') col.type = 'checkbox';
    else if (c.type === 'button') col.type = 'button';
    else if (c.type === 'link') col.type = 'link';
    else if (c.type === 'item_id') col.type = 'item_id';
    else if (c.type === 'file') col.type = 'file';
    else if (c.type === 'creation_log') col.type = 'created';
    else if (c.type === 'dropdown') {
      col.type = 'dropdown';
      col.options = (Array.isArray(s.labels) ? s.labels.map(l => l.name) : Object.values(s.labels || {})).filter(Boolean);
    } else {
      col.type = 'text';
      if (READONLY.has(c.type)) { col.readonly = true; col.source = c.type; }
      if (c.type === 'long_text') col.long = true;
    }
    out.push(col);
  }
  return out;
}

function convValues(cvs, cols) {
  const byId = new Map(cols.map(c => [c.id, c]));
  const v = {};
  for (const cv of cvs || []) {
    const c = byId.get(cv.id); if (!c) continue;
    let val = null;
    try {
      if (c.type === 'status') val = cv.value ? String(JSON.parse(cv.value).index) : null;
      else if (c.type === 'date') { const dv = cv.value ? JSON.parse(cv.value) : null; val = dv ? dv.date : null; if (dv && dv.date && dv.time) { const iso = `${dv.date}T${dv.time}Z`; v[c.id + '__dt'] = iso; val = localDay(iso); } }
      else if (c.type === 'number') { const t = String(cv.text || '').replace(/,/g, ''); val = t ? Number(t) : null; if (Number.isNaN(val)) val = null; }
      else if (c.type === 'checkbox') val = cv.value ? (JSON.parse(cv.value).checked === true || JSON.parse(cv.value).checked === 'true') : null;
      else if (c.type === 'file' || c.source === 'file') { val = parseFiles(cv.text); if (!val.length) val = null; }
      else if (c.type === 'link') val = cv.text || null; // Monday's own format: "name - https://…"
      else if (['formula', 'button', 'item_id', 'created'].includes(c.type)) val = null;
      else val = cv.text || null;
    } catch (e) { val = null; }
    if (val !== null && val !== undefined && val !== '' && val !== 'undefined' && val !== false) v[c.id] = val;
  }
  return v;
}

// One Monday item as a Solver.ca item document.
function itemDoc(i, cols, subCols, extra = {}) {
  const doc = {
    name: i.name, group: (i.group || {}).id, values: convValues(i.column_values, cols),
    updates: [...(i.updates || [])].reverse().map(u => ({ at: u.created_at, by: '', byName: (u.creator || {}).name || 'Monday user', text: String(u.text_body || '').slice(0, 6000),
      ...((u.assets || []).length ? { files: u.assets.map(a => ({ name: a.name, url: a.public_url })) } : {}),
      ...((u.replies || []).length ? { replies: u.replies.map(rp => ({ at: rp.created_at, byName: (rp.creator || {}).name || 'Monday user', text: String(rp.text_body || '').slice(0, 3000) })) } : {}) })),
    subitems: (i.subitems || []).map(x => ({ id: x.id, name: x.name, values: convValues(x.column_values, subCols) })),
    mondayId: i.id, createdAt: i.created_at, ...extra,
  };
  while (JSON.stringify(doc).length > 900000 && doc.updates.length) doc.updates.shift();
  return doc;
}

const ITEM_FIELDS = `id name group { id } created_at
  column_values { id type text value }
  updates(limit: 100) { id text_body created_at creator { name } assets { name public_url } replies { text_body created_at creator { name } } }
  subitems { id name column_values { id type text value } }`;

// Copies every board in the given workspaces. `save(path, col, id, data)` writes one record.
// `onProgress({ msg, boards, items })` reports progress. Returns totals.
async function syncFromMonday({ token, workspaceIds, save, removeStale, onProgress = () => {} }) {
  if (!token) throw new Error('Set MONDAY_API_TOKEN on the server first.');
  if (!workspaceIds.length) throw new Error('Set MONDAY_WORKSPACE_IDS on the server first.');
  const at = new Date().toISOString();
  let boardsDone = 0, itemsDone = 0, order = 0;
  for (const ws of workspaceIds) {
    const w = (await gql(token, `{ workspaces(ids: [${Number(ws)}]) { id name } }`)).workspaces[0];
    const workspace = { id: String(ws), name: w ? w.name : String(ws) };
    const boards = (await gql(token, `{ boards(workspace_ids: [${Number(ws)}], limit: 500) { id name type items_count board_kind subscribers { email } owners { email }
      groups { id title color position } columns { id title type settings_str } views { id name type settings_str } } }`)).boards;
    const folders = (await gql(token, `{ folders(workspace_ids: [${Number(ws)}]) { id name children { id } } }`)).folders;
    const folderOf = new Map(); folders.forEach(f => (f.children || []).forEach(ch => folderOf.set(String(ch.id), f.name)));
    const subBoards = new Map(boards.filter(b => b.type === 'sub_items_board').map(b => [b.name, b]));
    for (const b of boards) {
      if (b.type !== 'board') continue;
      onProgress({ msg: `Copying ${workspace.name} / ${b.name}`, boards: boardsDone, items: itemsDone });
      const cols = convColumns(b.columns);
      const sb = subBoards.get('Subitems of ' + b.name);
      const subCols = convColumns(sb ? sb.columns : []);
      const groups = [...b.groups].sort((x, y) => Number(x.position || 0) - Number(y.position || 0));
      const bid = 'm' + b.id;
      save('boards/' + bid, 'boards', bid, {
        name: b.name, order: ++order, workspace, folder: folderOf.get(String(b.id)) || '', source: 'monday', mondayId: b.id, syncedAt: at,
        groups: groups.map(g => ({ id: g.id, name: g.title, color: g.color || '#579bfc' })), columns: cols, subColumns: subCols, automations: [],
        form: convForm(b.views, cols), access: boardAccess(b),
      }, { keep: ['automations'] });
      const seen = new Set();
      let pos = 0, cursor = null;
      if (b.items_count) {
        let page = (await gql(token, `query($id: [ID!]) { boards(ids: $id) { items_page(limit: 40) { cursor items { ${ITEM_FIELDS} } } } }`, { id: [b.id] })).boards[0].items_page;
        for (;;) {
          for (const i of page.items) {
            const doc = itemDoc(i, cols, subCols, { pos: pos++, activity: [{ at, by: 'import', text: 'Copied from Monday' }] });
            save(`boards/${bid}/items/${i.id}`, `boards/${bid}/items`, String(i.id), doc);
            seen.add(String(i.id));
            itemsDone++;
          }
          onProgress({ msg: `Copying ${workspace.name} / ${b.name}`, boards: boardsDone, items: itemsDone });
          cursor = page.cursor; if (!cursor) break;
          page = (await gql(token, `query($c: String!) { next_items_page(limit: 40, cursor: $c) { cursor items { ${ITEM_FIELDS} } } }`, { c: cursor })).next_items_page;
        }
      }
      removeStale(bid, seen);
      boardsDone++;
    }
  }
  return { boards: boardsDone, items: itemsDone, at };
}

// The board's Monday Form view, as an ordered list of fact-find questions tied to columns.
function convForm(views, cols) {
  const ids = new Set(cols.map(c => c.id));
  for (const v of views || []) {
    if (v.type !== 'FormBoardView') continue;
    let st = {}; try { st = JSON.parse(v.settings_str || '{}') || {}; } catch (e) { continue; }
    const qs = st.columns || {}, order = st.sortedQuestionsList || Object.keys(qs);
    const questions = order.map(id => ({ id, q: qs[id] })).filter(({ id, q }) => q && q.visible && ids.has(id))
      .map(({ id, q }) => ({ col: id, q: String(q.question || '').trim(), desc: String(q.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
    if (questions.length) return { title: st.formTitle || v.name || 'Fact find', questions };
  }
  return null;
}

// ---------- live pull: only what changed in Monday since the last pull (reads Monday, never writes) ----------
// boards: [{ bid, mondayId, columns, subColumns, groups }] — boards already copied into Solver.ca.
// store: { getItem(bid, iid), saveItem(bid, iid, doc, isNew), removeItem(bid, iid), saveGroups(bid, groups), newPos(bid) }
// Changes are found with each board's activity log (column changes, new, moved, deleted and archived items)
// plus its newest updates (comments don't show up in the activity log). Changed items are then fetched in full.
const SKIP_EVENTS = new Set(['subscribe', 'unsubscribe', 'add_owner', 'remove_owner']);
async function pullFromMonday({ token, boards, since, store, onProgress = () => {} }) {
  if (!token) throw new Error('Set MONDAY_API_TOKEN on the server first.');
  const startedAt = new Date().toISOString();
  const from = new Date(Math.max(Date.parse(since) || 0, Date.now() - 7 * 864e5) - 2 * 60000).toISOString(); // two minutes of overlap
  const byMonday = new Map(boards.map(b => [String(b.mondayId), b]));
  const touched = new Map(); // Monday item id -> Set of Solver.ca board ids where it changed
  const touch = (id, bid) => { if (!id) return; id = String(id); if (!touched.has(id)) touched.set(id, new Set()); touched.get(id).add(bid); };
  const readLogs = (b, logs) => {
    for (const l of logs || []) {
      if (SKIP_EVENTS.has(l.event)) continue;
      let d = {}; try { d = JSON.parse(l.data || '{}') || {}; } catch (e) { continue; }
      if (d.parent_item_id) { touch(d.parent_item_id, b.bid); continue; }
      if (Array.isArray(d.pulse_ids)) d.pulse_ids.forEach(id => touch(id, b.bid));
      touch(d.pulse_id || (d.pulse && d.pulse.id), b.bid);
    }
  };
  const fromMs = Date.parse(from);
  const readUpdates = (b, ups) => { let fresh = 0; for (const u of ups || []) if (Date.parse(u.created_at) >= fromMs) { touch(u.item_id, b.bid); fresh++; } return fresh; };
  const LOGS = 500, UPS = 25;
  for (let k = 0; k < boards.length; k += 10) {
    const chunk = boards.slice(k, k + 10);
    onProgress({ msg: `Checking ${chunk.length} boards for changes` });
    const data = await gql(token, `query($ids: [ID!]) { boards(ids: $ids, limit: 10) { id groups { id title color position }
      activity_logs(from: "${from}", limit: ${LOGS}) { event data } updates(limit: ${UPS}) { item_id created_at } } }`, { ids: chunk.map(b => String(b.mondayId)) });
    for (const mb of data.boards || []) {
      const b = byMonday.get(String(mb.id)); if (!b) continue;
      readLogs(b, mb.activity_logs);
      for (let page = 2; (mb.activity_logs || []).length === LOGS && page <= 20; page++) {
        const more = (await gql(token, `query($id: [ID!]) { boards(ids: $id) { activity_logs(from: "${from}", limit: ${LOGS}, page: ${page}) { event data } } }`, { id: [String(mb.id)] })).boards[0];
        readLogs(b, more.activity_logs); if ((more.activity_logs || []).length < LOGS) break;
      }
      for (let page = 2, fresh = readUpdates(b, mb.updates); fresh === UPS && page <= 20; page++) {
        const more = (await gql(token, `query($id: [ID!]) { boards(ids: $id) { updates(limit: ${UPS}, page: ${page}) { item_id created_at } } }`, { id: [String(mb.id)] })).boards[0];
        fresh = readUpdates(b, more.updates);
      }
      // groups added in Monday since the copy
      const known = new Set((b.groups || []).map(g => g.id));
      const added = [...(mb.groups || [])].sort((x, y) => Number(x.position || 0) - Number(y.position || 0)).filter(g => !known.has(g.id));
      if (added.length) { b.groups = [...(b.groups || []), ...added.map(g => ({ id: g.id, name: g.title, color: g.color || '#579bfc' }))]; store.saveGroups(b.bid, b.groups); }
    }
  }
  const ids = [...touched.keys()];
  let saved = 0, removed = 0;
  const at = new Date().toISOString();
  for (let k = 0; k < ids.length; k += 25) {
    const chunk = ids.slice(k, k + 25);
    onProgress({ msg: `Reading ${ids.length} changed items` });
    const items = (await gql(token, `query($ids: [ID!]) { items(ids: $ids, limit: 25) { ${ITEM_FIELDS} state board { id } } }`, { ids: chunk })).items || [];
    const got = new Map(items.map(i => [String(i.id), i]));
    for (const id of chunk) {
      const i = got.get(id), origins = touched.get(id);
      const alive = i && i.state === 'active';
      const target = alive ? byMonday.get(String((i.board || {}).id)) : null;
      for (const bid of origins) if (!target || target.bid !== bid) { if (store.removeItem(bid, id)) removed++; }
      if (!target) continue;
      const old = store.getItem(target.bid, id);
      const doc = itemDoc(i, target.columns || [], target.subColumns || []);
      const same = old && ['name', 'group', 'values', 'updates', 'subitems'].every(f => JSON.stringify(old[f] ?? null) === JSON.stringify(doc[f] ?? null));
      if (same) continue;
      let activity = (old && old.activity) || [];
      if (old && activity[0] && activity[0].text === 'Updated from Monday') activity = activity.slice(1);
      const next = { ...(old || {}), ...doc, pos: old && old.pos != null ? old.pos : store.newPos(target.bid),
        activity: [{ at, by: 'import', text: old ? 'Updated from Monday' : 'Copied from Monday' }, ...activity].slice(0, 40) };
      store.saveItem(target.bid, id, next, !old);
      saved++;
    }
  }
  return { at: startedAt, boards: boards.length, checked: ids.length, saved, removed };
}

module.exports = { syncFromMonday, pullFromMonday, convForm, convColumns, convValues, parseFiles, boardAccess, gql };
