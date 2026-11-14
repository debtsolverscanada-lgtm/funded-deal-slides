// One-way copy from Monday into Solver.ca. Reads Monday only; never writes to it.
// Needs MONDAY_API_TOKEN. Workspaces come from MONDAY_WORKSPACE_IDS (comma-separated).
'use strict';

const API = 'https://api.monday.com/v2';
const { convViews } = require('./public/viewfilters.js');
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
      // connected boards and mirrors: Monday leaves text empty and puts the shown names/values in display_value
      else if (c.source === 'board_relation' || c.source === 'mirror') val = (cv.display_value != null && cv.display_value !== '' ? cv.display_value : cv.text) || null;
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
      ...(u.id ? { mid: String(u.id) } : {}),
      ...((u.assets || []).length ? { files: u.assets.map(a => ({ name: a.name, url: a.public_url })) } : {}),
      ...((u.replies || []).length ? { replies: u.replies.map(rp => ({ at: rp.created_at, byName: (rp.creator || {}).name || 'Monday user', text: String(rp.text_body || '').slice(0, 3000), ...(rp.id ? { mid: String(rp.id) } : {}) })) } : {}) })),
    subitems: (i.subitems || []).map(x => ({ id: x.id, name: x.name, values: convValues(x.column_values, subCols) })),
    mondayId: i.id, createdAt: i.created_at, ...extra,
  };
  // Monday returned as many comments as asked for: older ones may exist there. Noted before any are trimmed to fit, so the
  // merge keeps stored comments older than the ones returned (a non-enumerable mark: it's never saved)
  const full = (i.updates || []).length >= UPDATES_LIMIT;
  while (JSON.stringify(doc).length > 900000 && doc.updates.length) doc.updates.shift();
  if (full || doc.updates.length < (i.updates || []).length) Object.defineProperty(doc.updates, 'full', { value: true });
  return doc;
}

const CV_FIELDS = 'column_values { id type text value ... on BoardRelationValue { display_value linked_item_ids } ... on MirrorValue { display_value } }';
const UPDATES_LIMIT = 100;
const ITEM_FIELDS = `id name group { id } created_at
  ${CV_FIELDS}
  updates(limit: ${UPDATES_LIMIT}) { id text_body created_at creator { name } assets { name public_url } replies { id text_body created_at creator { name } } }
  subitems { id name ${CV_FIELDS} }`;

// ---------- merging a fresh Monday copy into what Solver.ca already has ----------
// Monday owns its own columns, labels, groups, comments and subitems. Everything made in Solver.ca stays:
// Solver-only columns and their values, Solver comments and replies, Solver subitems, files uploaded here,
// time tracking, docs, activity, history, permissions, access edits, automations and views made here.
const NO_VALUE = new Set(['formula', 'button', 'item_id', 'created']);
const tms = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
const byAt = (a, b) => tms(a.at) - tms(b.at);
const solverFiles = v => (Array.isArray(v) ? v.filter(f => f && typeof f.url === 'string' && f.url.startsWith('/api/files/')) : []);
// The subitems board of a Monday board: its subitems column names it in settings_str.boardIds.
function subBoardId(columns) {
  for (const c of columns || []) {
    if (c.type !== 'subtasks') continue;
    try { const s = JSON.parse(c.settings_str || '{}') || {}; if (Array.isArray(s.boardIds) && s.boardIds.length) return String(s.boardIds[0]); } catch (e) {}
  }
  return null;
}
// Labels/options: Monday's list first, then the ones added in Solver.ca (so items using them still show them).
function mergeLabels(oldL, newL) {
  const ids = new Set(newL.map(l => String(l.id)));
  return [...newL, ...(Array.isArray(oldL) ? oldL.filter(l => l && !ids.has(String(l.id))) : [])];
}
function mergeColumns(oldCols, newCols) {
  oldCols = Array.isArray(oldCols) ? oldCols : []; newCols = Array.isArray(newCols) ? newCols : [];
  const fresh = new Map(newCols.map(c => [c.id, c]));
  const out = oldCols.map(c => {
    const m = fresh.get(c.id); if (!m) return c; // added in Solver.ca, or gone from Monday: kept
    if (c.type !== m.type) return m; // Monday changed the column's type
    const x = { ...c, ...m };
    if (m.labels) x.labels = mergeLabels(c.labels, m.labels);
    if (m.options) x.options = [...m.options, ...(Array.isArray(c.options) ? c.options.filter(o => !m.options.includes(o)) : [])];
    return x;
  });
  // columns new in Monday go right after the Monday column before them
  let prev = null;
  for (const m of newCols) {
    if (!oldCols.some(c => c.id === m.id)) { const at = prev ? out.findIndex(c => c.id === prev) + 1 : 0; out.splice(at, 0, m); }
    prev = m.id;
  }
  return out;
}
function mergeGroups(oldG, newG) {
  oldG = Array.isArray(oldG) ? oldG : []; newG = Array.isArray(newG) ? newG : [];
  const fresh = new Map(newG.map(g => [g.id, g]));
  const out = oldG.map(g => (fresh.has(g.id) ? { ...g, ...fresh.get(g.id) } : g));
  for (const g of newG) if (!oldG.some(o => o.id === g.id)) out.push(g);
  return out;
}
// A board doc. Returns null for a board that wasn't copied from Monday: those are never touched.
function mergeBoardDoc(old, fresh) {
  if (!old) return fresh;
  if (old.source !== 'monday') return null;
  const oldViews = Array.isArray(old.views) ? old.views : [];
  // Monday's views are replaced by their current version (keeping settings saved on them here); views made here stay
  const views = !Array.isArray(fresh.views) ? oldViews : [...fresh.views.map(v => { const o = oldViews.find(x => x.id === v.id); return o && o.settings !== undefined ? { ...v, settings: o.settings } : v; }),
    ...oldViews.filter(v => v.source !== 'monday')];
  const out = { ...old };
  // fields the fresh copy doesn't carry (an older export) keep their stored value
  for (const k of ['name', 'workspace', 'folder', 'mondayId', 'syncedAt', 'form']) if (fresh[k] !== undefined) out[k] = fresh[k];
  return Object.assign(out, {
    source: 'monday',
    groups: mergeGroups(old.groups, fresh.groups), columns: mergeColumns(old.columns, fresh.columns), subColumns: mergeColumns(old.subColumns, fresh.subColumns),
    // access changed by an admin in Solver.ca no longer says source: 'monday'; it then stays as the admin set it
    access: (old.access && old.access.source !== 'monday') || !fresh.access ? old.access : fresh.access,
    automations: old.automations !== undefined ? old.automations : fresh.automations,
    views,
  });
}
function mergeValues(oldV, freshV, cols) {
  const v = { ...(oldV || {}) }; freshV = freshV || {};
  // Monday's columns unknown (null): only the columns the fresh copy carries are replaced
  if (cols == null) cols = Object.keys(freshV).filter(k => !/__dt$/.test(k)).map(id => ({ id }));
  for (const c of cols) {
    if (NO_VALUE.has(c.type)) continue;
    const keep = c.type === 'file' || c.source === 'file' ? solverFiles(v[c.id]) : []; // files uploaded in Solver.ca
    delete v[c.id]; delete v[c.id + '__dt'];
    if (freshV[c.id] !== undefined) v[c.id] = freshV[c.id];
    if (freshV[c.id + '__dt'] !== undefined) v[c.id + '__dt'] = freshV[c.id + '__dt'];
    if (keep.length) v[c.id] = [...(Array.isArray(v[c.id]) ? v[c.id] : []), ...keep];
  }
  return v;
}
// Replies: Monday's, plus the ones written in Solver.ca (they carry `by` and no Monday id).
function mergeReplies(oldR, freshR) {
  const fr = Array.isArray(freshR) ? freshR : [];
  const mine = (Array.isArray(oldR) ? oldR : []).filter(r => r && !r.mid && r.by);
  return [...fr, ...mine].sort(byAt);
}
// Comments: matched by Monday id (older copies without one: by Monday's created_at). Comments made in Solver.ca stay.
// A Monday comment that Monday no longer lists was deleted there, unless it's older than the last `limit` Monday returned.
function mergeUpdates(oldU, freshU, limit = UPDATES_LIMIT) {
  oldU = Array.isArray(oldU) ? oldU : []; freshU = Array.isArray(freshU) ? freshU : [];
  const byMid = new Map(freshU.filter(u => u.mid).map(u => [u.mid, u])), byTime = new Map(freshU.map(u => [u.at, u]));
  // an export made without Monday ids can't say what was deleted in Monday: then nothing stored is dropped
  const noIds = freshU.some(u => !u.mid), full = freshU.full === true || freshU.length >= limit, oldest = freshU.length ? Math.min(...freshU.map(u => tms(u.at))) : Infinity;
  const used = new Set(), out = [];
  // a note written in Solver.ca and written back to Monday comes back as "<text>\n\n— Name (in Solver.ca)"; before its Monday id is stamped it's matched by that text
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim(), oldMids = new Set(oldU.filter(u => u && u.mid).map(u => u.mid));
  const echoOf = u => { const t = norm(u.text); if (!t) return null; return freshU.find(f => f.mid && !oldMids.has(f.mid) && !used.has(f) && /\(in Solver\.ca\)$/.test(norm(f.text)) && norm(f.text).startsWith(t)) || null; };
  for (const u of oldU) {
    if (!u || typeof u !== 'object') continue;
    let f = u.mid ? byMid.get(u.mid) : null;
    if (!f && !u.by) { const x = byTime.get(u.at); if (x && (!x.mid || !u.mid)) f = x; } // a copy without ids: same Monday time
    if (!f && !u.mid && u.by) f = echoOf(u);
    if (f && !used.has(f)) {
      used.add(f);
      // a note written in Solver.ca keeps its author, text and time; Monday adds only its id and replies
      const x = u.by ? { ...f, ...u, mid: f.mid } : { ...u, ...f }; const r = mergeReplies(u.replies, f.replies); if (r.length) x.replies = r; else delete x.replies;
      out.push(x); continue;
    }
    if (u.mid) { if (noIds || (full && tms(u.at) <= oldest)) out.push(u); continue; } // same second as the oldest returned: may be just past the limit // deleted in Monday, unless older than what Monday returned
    out.push(u); // made in Solver.ca (or an older copy that can't be matched): kept
  }
  for (const f of freshU) if (!used.has(f)) out.push(f);
  return out.map((u, i) => [u, i]).sort((a, b) => byAt(a[0], b[0]) || a[1] - b[1]).map(x => x[0]);
}
const isMondaySub = s => /^\d+$/.test(String((s && s.id) || ''));
function mergeSubitems(oldS, freshS, subCols) {
  oldS = Array.isArray(oldS) ? oldS : []; freshS = Array.isArray(freshS) ? freshS : [];
  const fresh = new Map(freshS.map(s => [String(s.id), s])), out = [];
  for (const s of oldS) {
    const f = fresh.get(String(s && s.id));
    if (f) { out.push({ ...s, ...f, values: mergeValues(s.values, f.values, subCols) }); fresh.delete(String(s.id)); }
    else if (!isMondaySub(s)) out.push(s); // made in Solver.ca
  }
  for (const f of fresh.values()) out.push(f);
  return out;
}
// An item doc: fresh (from itemDoc) merged into the stored one. cols/subCols: the board's columns as Monday has them.
// cols/subCols null: Monday's columns aren't known, so only the values the fresh copy carries are replaced.
function mergeItemDoc(old, fresh, cols, subCols) {
  if (!old) return fresh;
  return {
    ...old,
    name: fresh.name, group: fresh.group, mondayId: fresh.mondayId, createdAt: old.createdAt || fresh.createdAt,
    values: mergeValues(old.values, fresh.values, cols),
    updates: mergeUpdates(old.updates, fresh.updates),
    subitems: mergeSubitems(old.subitems, fresh.subitems, subCols),
  };
}
const ITEM_KEYS = ['name', 'group', 'values', 'updates', 'subitems'];
// key order doesn't matter (a merge re-adds Monday's values after the ones kept from Solver.ca)
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
const sameItem = (a, b) => !!a && !!b && ITEM_KEYS.every(f => stable(a[f] ?? null) === stable(b[f] ?? null));

// Copies every board in the given workspaces. `save(path, col, id, data)` writes one record; `load(path)` reads one
// (or null). What's already in Solver.ca is merged, not overwritten (see mergeBoardDoc / mergeItemDoc), and boards
// whose source isn't Monday are skipped. `onProgress({ msg, boards, items })` reports progress. Returns totals.
async function syncFromMonday({ token, workspaceIds, save, load = () => null, removeStale, movedAway = () => false, onProgress = () => {} }) {
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
    // Monday user id -> name, so saved views filtered by a person keep working (views stay readable without it)
    const people = {}; try { for (const u of (await gql(token, '{ users(limit: 500) { id name } }')).users || []) people[String(u.id)] = u.name; } catch (e) { /* views keep the raw person ids */ }
    const subById = new Map(boards.filter(b => b.type === 'sub_items_board').map(b => [String(b.id), b]));
    const subByName = new Map(boards.filter(b => b.type === 'sub_items_board').map(b => [b.name, b]));
    for (const b of boards) {
      if (b.type !== 'board') continue;
      onProgress({ msg: `Copying ${workspace.name} / ${b.name}`, boards: boardsDone, items: itemsDone });
      const cols = convColumns(b.columns);
      // the subitems board is named in the subitems column's settings (boards can share a name)
      const sid = subBoardId(b.columns);
      const sb = (sid && subById.get(sid)) || (!sid ? subByName.get('Subitems of ' + b.name) : null);
      const subCols = convColumns(sb ? sb.columns : []);
      const groups = [...b.groups].sort((x, y) => Number(x.position || 0) - Number(y.position || 0));
      const bid = 'm' + b.id, bpath = 'boards/' + bid;
      const fresh = {
        name: b.name, order: ++order, workspace, folder: folderOf.get(String(b.id)) || '', source: 'monday', mondayId: b.id, syncedAt: at,
        groups: groups.map(g => ({ id: g.id, name: g.title, color: g.color || '#579bfc' })), columns: cols, subColumns: subCols, automations: [],
        form: convForm(b.views, cols), access: boardAccess(b), views: convViews(b.views, cols, { people }),
      };
      const merged = mergeBoardDoc(load(bpath), fresh);
      if (!merged) { boardsDone++; continue; } // a Solver.ca board sits at that id: never touched
      save(bpath, 'boards', bid, merged);
      const seen = new Set();
      let pos = 0, cursor = null;
      if (b.items_count) {
        let page = (await gql(token, `query($id: [ID!]) { boards(ids: $id) { items_page(limit: 40) { cursor items { ${ITEM_FIELDS} } } } }`, { id: [b.id] })).boards[0].items_page;
        for (;;) {
          for (const i of page.items) {
            const ipath = `boards/${bid}/items/${i.id}`, old = load(ipath);
            const p = pos++;
            if (!old && movedAway(String(i.id))) { seen.add(String(i.id)); itemsDone++; continue; } // moved to another board in Solver.ca
            const freshItem = itemDoc(i, cols, subCols, { pos: p, activity: [{ at, by: 'import', text: 'Copied from Monday' }] });
            let doc = freshItem;
            if (old) {
              doc = mergeItemDoc(old, freshItem, cols, subCols);
              if (old.pos == null) doc.pos = p;
              if (!sameItem(old, doc)) doc.activity = [{ at, by: 'import', text: 'Updated from Monday' }, ...(old.activity || [])].slice(0, 40);
              else doc.activity = old.activity;
            }
            if (!old || stable(old) !== stable(doc)) save(ipath, `boards/${bid}/items`, String(i.id), doc);
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
// store: { getItem(bid, iid), saveItem(bid, iid, doc, isNew), removeItem(bid, iid), saveBoardParts(bid, { groups, columns, subColumns }), newPos(bid) }
// Items are merged (mergeItemDoc), so values of Solver-only columns, Solver comments and subitems stay.
// Returns gap: true when the last pull is more than 7 days old (Monday's log is read for 7 days): run a full copy.
// Changes are found with each board's activity log (column changes, new, moved, deleted and archived items)
// plus its newest updates (comments don't show up in the activity log). Changed items are then fetched in full.
const SKIP_EVENTS = new Set(['subscribe', 'unsubscribe', 'add_owner', 'remove_owner']);
async function pullFromMonday({ token, boards, since, store, onProgress = () => {} }) {
  if (!token) throw new Error('Set MONDAY_API_TOKEN on the server first.');
  const startedAt = new Date().toISOString();
  const weekAgo = Date.now() - 7 * 864e5;
  // Monday's activity log is read for the last 7 days at most: a longer gap needs a full copy to catch up
  const gap = !(Date.parse(since) >= weekAgo);
  const from = new Date(Math.max(Date.parse(since) || 0, weekAgo) - 2 * 60000).toISOString(); // two minutes of overlap
  const byMonday = new Map(boards.map(b => [String(b.mondayId), b]));
  const subIds = new Map(); // Monday subitems board id -> board
  for (const b of boards) b.stored = { groups: b.groups, columns: b.columns, subColumns: b.subColumns };
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
    const data = await gql(token, `query($ids: [ID!]) { boards(ids: $ids, limit: 10) { id groups { id title color position } columns { id title type settings_str }
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
      // groups, columns and labels as Monday has them now (merged: what was added in Solver.ca stays)
      const mg = [...(mb.groups || [])].sort((x, y) => Number(x.position || 0) - Number(y.position || 0)).map(g => ({ id: g.id, name: g.title, color: g.color || '#579bfc' }));
      b.groups = mergeGroups(b.groups, mg);
      if (Array.isArray(mb.columns) && mb.columns.length) {
        b.mondayCols = convColumns(mb.columns);
        b.columns = mergeColumns(b.columns, b.mondayCols);
        const sid = subBoardId(mb.columns); if (sid) subIds.set(sid, b);
      }
    }
  }
  // the subitems boards' columns
  const sids = [...subIds.keys()];
  for (let k = 0; k < sids.length; k += 10) {
    const subs = (await gql(token, `query($ids: [ID!]) { boards(ids: $ids, limit: 10) { id columns { id title type settings_str } } }`, { ids: sids.slice(k, k + 10) })).boards || [];
    for (const sb of subs) { const b = subIds.get(String(sb.id)); if (!b || !Array.isArray(sb.columns)) continue; b.mondaySubCols = convColumns(sb.columns); b.subColumns = mergeColumns(b.subColumns, b.mondaySubCols); }
  }
  for (const b of boards) {
    const patch = { groups: b.groups, columns: b.columns, subColumns: b.subColumns };
    if (stable(patch) !== stable(b.stored)) store.saveBoardParts(b.bid, patch);
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
      // moved to another board in Monday: the Solver.ca comments, files and time go along with it
      let carried = null;
      for (const bid of origins) if (!target || target.bid !== bid) { const o = store.getItem(bid, id); if (o && target) carried = o; if (store.removeItem(bid, id)) removed++; }
      if (!target) continue;
      const here = store.getItem(target.bid, id), old = here || carried;
      // moved to another board in Solver.ca: Monday still has it on its old board, but it isn't copied back there
      if (!old && store.movedAway && store.movedAway(id)) continue;
      // Monday's own columns, when this pull read them. If it didn't (Monday returned none), values are read with the
      // stored columns but only the ones Monday sent are replaced: Solver.ca's own columns are never cleared.
      const cols = target.mondayCols || target.columns || [], subCols = target.mondaySubCols || target.subColumns || [];
      const doc = mergeItemDoc(old, itemDoc(i, cols, subCols), target.mondayCols || null, target.mondaySubCols || null);
      if (here && sameItem(here, doc)) continue;
      let activity = (old && old.activity) || [];
      if (old && activity[0] && activity[0].text === 'Updated from Monday') activity = activity.slice(1);
      const next = { ...doc, pos: here && here.pos != null ? here.pos : store.newPos(target.bid),
        activity: [{ at, by: 'import', text: old ? 'Updated from Monday' : 'Copied from Monday' }, ...activity].slice(0, 40) };
      store.saveItem(target.bid, id, next, !here);
      saved++;
    }
  }
  return { at: startedAt, boards: boards.length, checked: ids.length, saved, removed, gap };
}

module.exports = { syncFromMonday, pullFromMonday, convForm, convViews, convColumns, convValues, parseFiles, boardAccess, gql,
  mergeBoardDoc, mergeItemDoc, mergeColumns, mergeGroups, mergeUpdates, mergeSubitems, mergeValues, subBoardId, itemDoc };
