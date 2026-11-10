// Solver.ca saved views: matching items against a view's filters (browser and server), and turning Monday's
// board-view settings into a Solver.ca view (server, during a copy from Monday).
//
// A stored view: { id, name, rules: [{ col, op, values }], match: 'and'|'or', groups: [{ match, rules }], sort: { col, dir }, columns, source }
// - `rules` must all match (the original shape, made by "Save as view").
// - `groups` (from Monday's newer filters) are combined with `match`; each group's rules with its own `match`.
// ops: any, not_any, empty, not_empty, contains, not_contains, starts, ends, gt, gte, lt, lte, between, search
// values: strings; '@me' is the signed-in person; dates may be tokens like TODAY, THIS_WEEK, OVERDUE, PAST, FUTURE.
(function (root) {
  'use strict';
  const low = v => String(v ?? '').toLowerCase();
  const splitPeople = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isEmpty = v => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length);
  const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return String(v ?? '').trim() === '' ? NaN : n; };

  // A date token -> [from, to] (inclusive YYYY-MM-DD), relative to today.
  function dateRange(tok, today = new Date()) {
    const t = String(tok || '').toUpperCase(), d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const wk = d => add(d, -d.getDay());
    const r = (a, b) => [ymd(a), ymd(b)];
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return [t.slice(0, 10), t.slice(0, 10)];
    switch (t) {
      case 'TODAY': return r(d0, d0);
      case 'TOMORROW': return r(add(d0, 1), add(d0, 1));
      case 'YESTERDAY': return r(add(d0, -1), add(d0, -1));
      case 'THIS_WEEK': case 'CURRENT_WEEK': return r(wk(d0), add(wk(d0), 6));
      case 'LAST_WEEK': case 'PAST_WEEK': return r(add(wk(d0), -7), add(wk(d0), -1));
      case 'NEXT_WEEK': return r(add(wk(d0), 7), add(wk(d0), 13));
      case 'THIS_MONTH': case 'CURRENT_MONTH': return r(new Date(d0.getFullYear(), d0.getMonth(), 1), new Date(d0.getFullYear(), d0.getMonth() + 1, 0));
      case 'LAST_MONTH': case 'PAST_MONTH': return r(new Date(d0.getFullYear(), d0.getMonth() - 1, 1), new Date(d0.getFullYear(), d0.getMonth(), 0));
      case 'NEXT_MONTH': return r(new Date(d0.getFullYear(), d0.getMonth() + 1, 1), new Date(d0.getFullYear(), d0.getMonth() + 2, 0));
      case 'THIS_YEAR': return r(new Date(d0.getFullYear(), 0, 1), new Date(d0.getFullYear(), 11, 31));
      case 'PAST': case 'PAST_DATETIME': case 'OVERDUE': return ['0000-01-01', ymd(add(d0, -1))];
      case 'FUTURE': case 'FUTURE_DATETIME': case 'UPCOMING': return [ymd(add(d0, 1)), '9999-12-31'];
      default: return null;
    }
  }

  // ctx: { me: { name, email }, today: Date }
  function ruleMatch(b, item, r, ctx = {}) {
    const cols = (b && b.columns) || [];
    const meName = low(ctx.me && ctx.me.name);
    const vals = (r.values || []).map(v => v === '@me' ? meName : low(v));
    if (r.col === '__group') { const g = String(item.group || ''); const hit = (r.values || []).map(String).includes(g); return r.op === 'not_any' ? !hit : hit; }
    if (r.op === 'search') { const q = vals[0] || ''; if (!q) return true; if (low(item.name).includes(q)) return true; return Object.values(item.values || {}).some(v => typeof v !== 'object' && low(v).includes(q)); }
    const c = r.col === 'name' ? { id: 'name', type: 'text' } : cols.find(x => x.id === r.col);
    const raw = r.col === 'name' ? item.name : (item.values || {})[r.col];
    const empty = isEmpty(raw);
    switch (r.op) {
      case 'empty': return empty;
      case 'not_empty': return !empty;
    }
    if (!c) return false; // a filter on a column this board no longer has matches nothing (like Monday)
    const text = c.type === 'status' ? low(((c.labels || []).find(l => l.id === String(raw)) || {}).label) : low(raw);
    if (['contains', 'not_contains', 'starts', 'ends'].includes(r.op)) {
      const hit = vals.some(v => r.op === 'starts' ? text.startsWith(v) : r.op === 'ends' ? text.endsWith(v) : text.includes(v));
      return r.op === 'not_contains' ? !hit : hit;
    }
    if (['gt', 'gte', 'lt', 'lte', 'between'].includes(r.op)) {
      if (empty) return false;
      if (c.type === 'date') {
        const v = String(raw).slice(0, 10), rg = vals.map(x => dateRange(x, ctx.today) || [x, x]);
        if (r.op === 'between') return rg.length >= 2 ? v >= rg[0][0] && v <= rg[1][1] : false;
        const x = rg[0]; if (!x) return false;
        return r.op === 'gt' ? v > x[1] : r.op === 'gte' ? v >= x[0] : r.op === 'lt' ? v < x[0] : v <= x[1];
      }
      const n = num(raw), ns = vals.map(num);
      if (!Number.isFinite(n)) return false;
      if (r.op === 'between') return ns.length >= 2 && n >= Math.min(ns[0], ns[1]) && n <= Math.max(ns[0], ns[1]);
      return r.op === 'gt' ? n > ns[0] : r.op === 'gte' ? n >= ns[0] : r.op === 'lt' ? n < ns[0] : n <= ns[0];
    }
    // any / not_any (default)
    let hit;
    if (c.type === 'person') {
      const ps = splitPeople(raw).map(low);
      hit = vals.some(v => ps.includes(v) || (v && ps.some(p => p.split(' ')[0] === v.split(' ')[0] && v === meName)));
    } else if (c.type === 'status') hit = vals.includes(low(raw)) || (!!text && vals.includes(text));
    else if (c.type === 'dropdown') { const ds = splitPeople(raw).map(low); hit = vals.some(v => ds.includes(v)); }
    else if (c.type === 'checkbox') hit = vals.some(v => (['true', '1', 'checked', 'v', 'yes'].includes(v)) === !empty);
    else if (c.type === 'date') { const v = String(raw || '').slice(0, 10); hit = !!v && vals.some(x => { const rg = dateRange(x, ctx.today); return rg ? v >= rg[0] && v <= rg[1] : v === x; }); }
    else hit = vals.includes(low(raw));
    return r.op === 'not_any' ? !hit : hit;
  }
  function matches(view, b, item, ctx = {}) {
    if (!view) return true;
    if (!(view.rules || []).every(r => ruleMatch(b, item, r, ctx))) return false;
    const groups = (view.groups || []).filter(g => g && (g.rules || []).length);
    if (!groups.length) return true;
    const res = groups.map(g => g.match === 'or' ? g.rules.some(r => ruleMatch(b, item, r, ctx)) : g.rules.every(r => ruleMatch(b, item, r, ctx)));
    return view.match === 'or' ? res.some(Boolean) : res.every(Boolean);
  }

  // ---------- Monday board view -> Solver.ca view (server side, during a copy) ----------
  const OPS = { any_of: 'any', is: 'any', equals: 'any', not_any_of: 'not_any', is_not: 'not_any', is_empty: 'empty', is_not_empty: 'not_empty',
    contains_text: 'contains', contains_terms: 'contains', not_contains_text: 'not_contains', starts_with: 'starts', ends_with: 'ends',
    greater_than: 'gt', greater_than_or_equals: 'gte', lower_than: 'lt', lower_than_or_equal: 'lte', less_than: 'lt', less_than_or_equals: 'lte', between: 'between',
    within_the_next: 'within_next', within_the_last: 'within_last' };
  // One Monday compare value -> our value(s). people: Map/obj of Monday user id -> name. groups: board groups (ids kept).
  function convValue(v, col, people) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('EXACT' in v || 'exact' in v) return [String(v.EXACT || v.exact).slice(0, 10)];
      if (v.date) return [String(v.date).slice(0, 10)];
      if (v.id != null && v.kind === 'person') v = 'person-' + v.id; else if (v.value != null) v = v.value; else return [];
    }
    const s = String(v);
    if (/^(assigned_to_me|me|__me__|current_user)$/i.test(s)) return ['@me'];
    const pm = /^person-(\d+)$/.exec(s);
    if (pm) { const n = people && (people.get ? people.get(pm[1]) : people[pm[1]]); return n ? [n] : null; }
    if (/^team-\d+$/.test(s)) return null;
    if (col && col.type === 'status' && /^\d+$/.test(s)) return [s];
    if (col && col.type === 'checkbox') return [/^(true|1|v|checked)$/i.test(s) ? 'true' : 'false'];
    return [s];
  }
  // A Monday rule -> { col, op, values } or null (and a note).
  function convRule(r, cols, people, notes) {
    const cid = String(r.column_id || r.columnId || r.column || '');
    let op = OPS[low(r.operator || r.compare_operator || 'any_of')];
    if (!cid || !op) { notes.push(`filter “${r.operator || '?'}” on ${cid || 'a column'}`); return null; }
    const col = cid === 'name' ? { id: 'name', type: 'text' } : cid === 'group' ? { id: '__group', type: 'group' } : cols.find(c => c.id === cid);
    if (!col) { notes.push(`a column that wasn't copied (${cid})`); return null; }
    const raw = Array.isArray(r.compare_value) ? r.compare_value : r.compare_value == null ? [] : [r.compare_value];
    if (op === 'empty' || op === 'not_empty') return { col: col.id, op, values: [] };
    if (op === 'within_next' || op === 'within_last') { // "within the next/last N days"
      const n = Number(raw[0] && typeof raw[0] === 'object' ? raw[0].value : raw[0]) || 7, d = new Date(), e = new Date(); op === 'within_next' ? e.setDate(d.getDate() + n) : d.setDate(d.getDate() - n);
      notes.push(`“${op === 'within_next' ? 'within the next' : 'within the last'} ${n} days” uses the dates on the day it was copied`);
      return { col: col.id, op: 'between', values: [ymd(d), ymd(e)] };
    }
    const values = []; let lost = 0;
    for (const v of raw) { const x = convValue(v, col, people); if (x === null) lost++; else values.push(...x); }
    if (lost) notes.push(`${lost} person or team value${lost === 1 ? '' : 's'} in ${col.title || col.id}`);
    if (!values.length && raw.length) return { col: col.id, op, values: raw.map(v => String(v && typeof v === 'object' ? JSON.stringify(v) : v)) }; // kept as-is: matches no one rather than everyone
    return { col: col.id, op, values };
  }
  function convGroup(g, cols, people, notes) {
    const out = { match: low(g.operator) === 'or' ? 'or' : 'and', rules: [] };
    for (const r of g.rules || []) { const x = convRule(r, cols, people, notes); if (x) out.rules.push(x); }
    for (const sub of g.groups || []) { // nested groups: flattened into this one when they use the same operator
      const s = convGroup(sub, cols, people, notes);
      if (s.match === out.match || s.rules.length === 1) out.rules.push(...s.rules); else notes.push('a nested filter group');
    }
    return out;
  }
  // mv: { id, name, type, settings_str | settings } -> view or null. opts: { people, keep: board views kept (same ids) }
  function convView(mv, cols, opts = {}) {
    const type = String(mv.type || '');
    if (type && !/^(TableBoardView|BoardView|table)$/i.test(type)) return null; // forms, charts, kanban… aren't table views
    // Older API versions put everything in settings_str; newer ones also return filter, sort and settings as fields.
    let st = {}; if (mv.settings_str) { try { st = JSON.parse(mv.settings_str) || {}; } catch (e) { st = {}; } }
    st = { ...st, ...(mv.settings && typeof mv.settings === 'object' ? mv.settings : {}) };
    if (mv.filter) st.filter = mv.filter; if (mv.sort) st.sort = mv.sort;
    const people = opts.people || {}, notes = [];
    const view = { id: 'mv_' + mv.id, name: String(mv.name || 'View').slice(0, 80), rules: [], sort: null, columns: null, source: 'monday', mondayId: String(mv.id) };
    const f = st.filter || st.filters || st.filter_v2 || null;
    if (f && typeof f === 'object' && !Array.isArray(f)) {
      if (Array.isArray(f.groups) && f.groups.length) {
        view.match = low(f.operator) === 'or' ? 'or' : 'and';
        view.groups = f.groups.map(g => convGroup(g, cols, people, notes)).filter(g => g.rules.length);
        if (Array.isArray(f.rules) && f.rules.length) view.groups.push(convGroup({ operator: f.operator, rules: f.rules }, cols, people, notes));
        if (view.match === 'and' && view.groups.every(g => g.match === 'and')) { view.rules = view.groups.flatMap(g => g.rules); delete view.groups; delete view.match; }
      } else if (Array.isArray(f.rules)) {
        const g = convGroup(f, cols, people, notes);
        if (g.match === 'and') view.rules = g.rules; else { view.match = 'and'; view.groups = [g]; }
      } else { // older shape: { colId: [values] }
        for (const [cid, vs] of Object.entries(f)) { const x = convRule({ column_id: cid, compare_value: vs, operator: 'any_of' }, cols, people, notes); if (x) view.rules.push(x); }
      }
    } else if (Array.isArray(f)) { const g = convGroup({ operator: 'and', rules: f }, cols, people, notes); view.rules = g.rules; }
    for (const [cid, vs] of Object.entries(st.filter_data || st.filterData || {})) { const x = convRule({ column_id: cid, compare_value: vs, operator: 'any_of' }, cols, people, notes); if (x) view.rules.push(x); }
    const pf = st.filter_by_person || st.filterByPerson || st.person_filter || st.filterUserId;
    if (pf != null && pf !== '') {
      const pid = typeof pf === 'object' ? (pf.value ?? pf.id ?? pf.userId) : pf, vs = convValue(/^\d+$/.test(String(pid)) ? 'person-' + pid : pid, null, people);
      const pc = cols.filter(c => c.type === 'person');
      if (vs && pc.length) { view.groups = [...(view.groups || []), { match: 'or', rules: pc.map(c => ({ col: c.id, op: 'any', values: vs })) }]; if (!view.match) view.match = 'and'; }
      else notes.push('the person filter');
    }
    const term = st.term || st.search || st.filter_term;
    if (term && typeof term === 'string') view.rules.push({ col: '*', op: 'search', values: [term] });
    // sort: [{ column_id, direction }] or { column_id, direction } or sort_by
    const s0 = Array.isArray(st.sort) ? st.sort[0] : st.sort || st.sort_by || st.sortBy;
    if (s0 && typeof s0 === 'object') { const sc = String(s0.column_id || s0.columnId || s0.column || ''); if (sc && (sc === 'name' || cols.some(c => c.id === sc))) view.sort = { col: sc, dir: /desc/i.test(String(s0.direction || s0.dir || 'asc')) ? 'desc' : 'asc' }; }
    // columns: order, minus the ones hidden in this view
    const cs = st.columns || {}, order = Array.isArray(cs.column_order) ? cs.column_order : Array.isArray(cs) ? cs : null;
    const hidden = new Set(); const props = cs.column_properties || cs.columnProperties;
    if (Array.isArray(props)) props.forEach(p => { if (p && p.visible === false) hidden.add(String(p.column_id || p.id)); });
    else if (props && typeof props === 'object') Object.entries(props).forEach(([k, p]) => { if (p && p.visible === false) hidden.add(k); });
    if (order || hidden.size) view.columns = (order || ['name', ...cols.map(c => c.id)]).map(String).filter(id => !hidden.has(id) && (id === 'name' || cols.some(c => c.id === id)));
    if (st.group_by || st.groupBy) notes.push('grouping by a column');
    if (notes.length) view.note = 'Not copied from Monday: ' + [...new Set(notes)].join('; ') + '.';
    return view;
  }
  function convViews(views, cols, opts) { const out = []; for (const v of views || []) { try { const x = convView(v, cols, opts); if (x) out.push(x); } catch (e) { /* one odd view never stops a copy */ } } return out; }

  root.KSViewFilters = { matches, ruleMatch, dateRange, convView, convViews };
  if (typeof module !== 'undefined') module.exports = root.KSViewFilters;
})(typeof window !== 'undefined' ? window : globalThis);
