// One-way copy from Monday into Keystone. Reads Monday only; never writes to it.
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
const READONLY = new Set(['mirror', 'last_updated', 'board_relation', 'time_tracking', 'file', 'doc', 'direct_doc']);

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
      else if (c.type === 'link') val = cv.text || null; // Monday's own format: "name - https://…"
      else if (['formula', 'button', 'item_id', 'created'].includes(c.type)) val = null;
      else val = cv.text || null;
    } catch (e) { val = null; }
    if (val !== null && val !== undefined && val !== '' && val !== 'undefined' && val !== false) v[c.id] = val;
  }
  return v;
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
    const boards = (await gql(token, `{ boards(workspace_ids: [${Number(ws)}], limit: 500) { id name type items_count
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
        form: convForm(b.views, cols),
      }, { keep: ['automations'] });
      const seen = new Set();
      let pos = 0, cursor = null;
      if (b.items_count) {
        let page = (await gql(token, `query($id: [ID!]) { boards(ids: $id) { items_page(limit: 40) { cursor items { ${ITEM_FIELDS} } } } }`, { id: [b.id] })).boards[0].items_page;
        for (;;) {
          for (const i of page.items) {
            const doc = {
              name: i.name, group: (i.group || {}).id, pos: pos++, values: convValues(i.column_values, cols),
              updates: [...(i.updates || [])].reverse().map(u => ({ at: u.created_at, by: '', byName: (u.creator || {}).name || 'Monday user', text: String(u.text_body || '').slice(0, 6000),
                ...((u.assets || []).length ? { files: u.assets.map(a => ({ name: a.name, url: a.public_url })) } : {}),
                ...((u.replies || []).length ? { replies: u.replies.map(rp => ({ at: rp.created_at, byName: (rp.creator || {}).name || 'Monday user', text: String(rp.text_body || '').slice(0, 3000) })) } : {}) })),
              subitems: (i.subitems || []).map(x => ({ id: x.id, name: x.name, values: convValues(x.column_values, subCols) })),
              mondayId: i.id, createdAt: i.created_at, activity: [{ at, by: 'import', text: 'Copied from Monday' }],
            };
            while (JSON.stringify(doc).length > 900000 && doc.updates.length) doc.updates.shift();
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

module.exports = { syncFromMonday, convForm, convColumns };
