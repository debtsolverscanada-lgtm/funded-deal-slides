// Solver.ca extra board views (Timeline, Workload, Chart, Map, Files) and Dashboards.
// index.html calls KSViews.init(api) with its state and helpers; everything else lives here.
// Writes go through the page's own setValue/patchItem, so locks, automations and the server's checks all apply.
(() => {
  'use strict';
  let A = null;
  const TYPES = [['timeline', 'Timeline'], ['workload', 'Workload'], ['chart', 'Chart'], ['map', 'Map'], ['files', 'Files']];
  const has = v => TYPES.some(t => t[0] === v);
  // categorical order (dark-surface steps), used when a category has no colour of its own
  const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const STATUS = { good: '#0ca30c', warn: '#fab219', bad: '#d03b3b' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = s => document.querySelector(s);
  const narrow = () => window.matchMedia('(max-width: 780px)').matches;
  const fmtN = n => (Math.round(n * 100) / 100).toLocaleString('en-CA', { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 2 });

  // ---------- day numbers (timezone-free) ----------
  const dn = s => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null; };
  const ds = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const todayDn = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; };
  const weekStart = n => n - ((new Date(n * 864e5).getUTCDay() + 6) % 7);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const short = n => { const d = new Date(n * 864e5); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); };

  // ---------- columns ----------
  const colById = (b, id) => id && b.columns.find(c => c.id === id);
  const dateCols = b => b.columns.filter(c => c.type === 'date');
  const numCols = b => b.columns.filter(c => c.type === 'number' || c.type === 'formula');
  const personCols = b => b.columns.filter(c => c.type === 'person');
  const statusCols = b => b.columns.filter(c => c.type === 'status');
  const timelineCols = b => b.columns.filter(c => c.type === 'timeline' || /^timeline/.test(c.id) || (c.type === 'text' && !c.source && /timeline|date range/i.test(c.title)));
  const locCols = b => b.columns.filter(c => c.type === 'location' || /^location/.test(c.id) || (c.type === 'text' && !c.source && /address|location|city|province|region|town/i.test(c.title)) || ((c.type === 'dropdown' || c.type === 'status') && /city|province|region|town/i.test(c.title)));
  const pick = (cols, re) => cols.find(c => re.test(c.title));
  function numVal(b, item, c) {
    if (!c) return 0;
    if (c.type === 'formula') { try { const r = A.formulaResult(b, item, c); const n = Number(r.value); return r.error || r.value === '' || !isFinite(n) ? 0 : n; } catch (e) { return 0; } }
    const v = (item.values || {})[c.id]; if (v === '' || v == null) return 0; const n = Number(v); return isFinite(n) ? n : 0;
  }
  const fmtVal = (c, n) => c && c.format === 'currency' ? '$' + Math.round(n).toLocaleString('en-CA') : c && c.format === 'percent' ? fmtN(n) + '%' : fmtN(n);

  // ---------- per-view settings (saved views keep their own) ----------
  const mem = {};
  const savedView = () => { const b = A.board(); return b && A.S.viewId ? (b.views || []).find(v => v.id === A.S.viewId) : null; };
  const key = t => A.S.boardId + '|' + (A.S.viewId || '') + '|' + t;
  function cfg(t) {
    const k = key(t); if (mem[k]) return mem[k];
    const v = savedView(); let base = v && v.type === t ? v.settings : null;
    if (!base) try { base = JSON.parse(localStorage.getItem('ks-vx-' + A.S.boardId + '-' + t) || 'null'); } catch (e) {}
    return (mem[k] = JSON.parse(JSON.stringify(base || {})));
  }
  function setCfg(t, patch) {
    Object.assign(cfg(t), patch);
    if (!A.S.viewId) try { localStorage.setItem('ks-vx-' + A.S.boardId + '-' + t, JSON.stringify(cfg(t))); } catch (e) {}
    A.renderHead(); A.renderContent();
  }
  const dirty = t => { const v = savedView(); return !!(v && v.type === t && JSON.stringify(stripLocal(cfg(t))) !== JSON.stringify(stripLocal(v.settings || {}))); };
  const stripLocal = o => { const x = { ...o }; delete x.off; delete x.sel; delete x.q; return x; };

  // ---------- styles ----------
  const CSS = `
  .head select.kbd-select { max-width:220px; }
  @media (max-width: 780px) { .head select.kbd-select { max-width:100%; } }
  .head .tab { white-space:nowrap; }
  .head .tabs { flex-wrap:wrap; }
  .vx-opts { display:contents; }
  .vx-opts > summary { display:none; }
  @media (max-width: 780px) {
    .head .tabs { overflow-x:auto; max-width:100%; flex-wrap:nowrap; scrollbar-width:none; }
    .head .tabs::-webkit-scrollbar { display:none; }
    .head .tab { white-space:nowrap; flex:none; }
    .vx-opts { display:block; width:100%; }
    .vx-opts > summary { display:inline-flex; list-style:none; cursor:pointer; }
    .vx-opts > summary::-webkit-details-marker { display:none; }
    .vx-opts[open] > summary { margin-bottom:8px; }
    .vx-opts .vx-optrow { display:flex; flex-wrap:wrap; gap:8px; }
  }
  .vx-optrow { display:contents; }
  .vx-optrow .vx-note { white-space:nowrap; }
  @media (max-width: 780px) { .main:not(.head-up) .head.compact:has(.vx-opts[open]) { max-height:none; } }
  /* desktop up to very wide screens: the view's options open as a panel under "View options", so the toolbar stays
     two rows (tabs and search, then filters and board buttons) on Timeline, Workload, Chart and Map */
  @media (min-width: 781px) and (max-width: 1699px) {
    .vx-opts { display:block; position:relative; }
    .vx-opts > summary { display:inline-flex; list-style:none; cursor:pointer; }
    .vx-opts > summary::-webkit-details-marker { display:none; }
    .vx-opts[open] > summary { background:rgba(255,255,255,0.14); }
    .vx-opts[open] > .vx-optrow { position:absolute; top:calc(100% + 6px); left:0; z-index:30; display:flex; flex-wrap:wrap; gap:8px; align-items:center; width:max-content; max-width:min(760px, calc(100vw - 300px)); padding:12px; background:rgba(18,18,20,0.97); border:1px solid var(--line); border-radius:18px; box-shadow:var(--shadow); }
  }
  .vx-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:12px; }
  .vx-note { color:var(--muted); font-size:12.5px; }
  .vx-panel { background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); backdrop-filter:var(--blur); -webkit-backdrop-filter:var(--blur); box-shadow:var(--glow); }
  .vx-seg { display:inline-flex; gap:2px; background:var(--surface); border:1px solid var(--line); border-radius:999px; padding:2px; }
  .vx-seg button { border:0; background:none; color:var(--muted); padding:5px 11px; border-radius:999px; font-size:12.5px; }
  .vx-seg button[aria-pressed="true"] { background:rgba(255,255,255,.14); color:#fff; }
  /* timeline */
  .tl { overflow:auto; max-height:calc(100vh - 250px); position:relative; }
  .tl-in { position:relative; }
  .tl-headrow, .tl-row, .tl-grp { display:flex; }
  .tl-headrow { position:sticky; top:0; z-index:3; background:#0b0b0d; border-bottom:1px solid var(--line); }
  .tl-label { position:sticky; left:0; z-index:2; flex:none; background:#0b0b0d; border-right:1px solid var(--line); padding:0 10px; display:flex; align-items:center; gap:6px; min-width:0; }
  .tl-headrow .tl-label { z-index:4; color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; line-height:44px; }
  .tl-label button { border:0; background:none; color:#fff; text-align:left; padding:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; min-width:0; }
  .tl-ticks { position:relative; height:44px; flex:none; }
  .tl-tick { position:absolute; bottom:0; height:20px; border-left:1px solid rgba(255,255,255,.07); font-size:10.5px; color:var(--muted); padding:3px 0 0 4px; white-space:nowrap; font-family:var(--f-data); }
  .tl-top { position:absolute; top:4px; font-size:11.5px; color:#fff; font-weight:600; white-space:nowrap; padding-left:4px; border-left:1px solid rgba(255,255,255,.18); }
  .tl-row { height:34px; border-bottom:1px solid rgba(255,255,255,.045); }
  .tl-row:hover .tl-label, .tl-row:hover .tl-track { background-color:rgba(255,255,255,.03); }
  .tl-track { position:relative; flex:none; }
  .tl-grp { height:32px; align-items:center; }
  .tl-grp .tl-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:block; line-height:32px; font-weight:600; color:#fff; box-shadow:inset 3px 0 0 var(--gc); }
  .tl-grp .tl-track { height:32px; background:rgba(255,255,255,.02); }
  .tl-bar { --c:#8a8f98; position:absolute; top:6px; box-sizing:border-box; height:22px; border-radius:7px; background:color-mix(in srgb, var(--c) 55%, #111); border:1px solid color-mix(in srgb, var(--c) 80%, #fff 0%); color:#fff; font-size:11.5px; line-height:20px; padding:0 8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; touch-action:pan-y; user-select:none; box-shadow:0 2px 10px rgba(0,0,0,.35); }
  .tl-bar[data-edit="1"] { cursor:grab; touch-action:none; }
  .tl-bar.dragging { cursor:grabbing; outline:2px solid #fff; z-index:5; }
  .tl-h { position:absolute; top:0; bottom:0; width:8px; cursor:ew-resize; }
  .tl-h.l { left:0; } .tl-h.r { right:0; }
  .tl-today { position:absolute; top:0; bottom:0; width:2px; background:#fff; box-shadow:0 0 10px rgba(255,255,255,.6); z-index:1; pointer-events:none; }
  .tl-weekend { position:absolute; top:0; bottom:0; background:rgba(255,255,255,.025); pointer-events:none; }
  .tl-tip { position:fixed; z-index:60; background:rgba(18,18,20,.92); border:1px solid var(--line-2); color:#fff; border-radius:10px; padding:5px 9px; font-size:12px; font-family:var(--f-data); pointer-events:none; }
  .tl-more button { border:0; background:none; color:#fff; font-weight:600; padding:0; font-size:12.5px; }
  /* workload */
  .wl { overflow:auto; }
  .wl table { border-collapse:separate; border-spacing:3px; min-width:100%; }
  .wl th { font-size:11.5px; color:var(--muted); font-weight:500; padding:4px 6px; white-space:nowrap; text-align:center; }
  .wl th.who, .wl td.who { text-align:left; position:sticky; left:0; background:#0b0b0d; z-index:1; }
  .wl td.who { padding:0 10px; white-space:nowrap; font-weight:500; }
  .wl td.who .av { margin-right:8px; vertical-align:middle; }
  .wl-cell { width:100%; min-width:64px; height:40px; border:1px solid var(--line); border-radius:10px; color:#fff; font-family:var(--f-data); font-size:12.5px; background:rgba(255,255,255,.03); }
  .wl-cell[aria-pressed="true"] { outline:2px solid #fff; }
  .wl-cell.zero { color:rgba(255,255,255,.25); }
  .wl-tot { font-family:var(--f-data); color:var(--muted); text-align:center; font-size:12.5px; }
  .wl-key { display:inline-flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); }
  .wl-key i { width:12px; height:12px; border-radius:4px; display:inline-block; }
  .vx-list { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:8px; margin-top:12px; }
  /* charts */
  .vx-chart svg { display:block; width:100%; height:auto; overflow:visible; }
  .vx-chart text { fill:rgba(255,255,255,.62); font-size:12px; font-family:var(--f-body); }
  .vx-chart .val { fill:#fff; font-family:var(--f-data); font-size:11.5px; }
  .vx-chart .grid { stroke:rgba(255,255,255,.07); }
  .vx-chart .mark:hover { filter:brightness(1.25); }
  .vx-legend { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12.5px; color:rgba(255,255,255,.78); margin:4px 0 10px; }
  .vx-legend span { display:inline-flex; align-items:center; gap:6px; }
  .vx-legend i { width:10px; height:10px; border-radius:3px; display:inline-block; }
  .vx-chartbox { padding:18px; }
  /* map */
  .vx-map { display:grid; grid-template-columns:minmax(0, 1fr) 300px; gap:12px; align-items:start; }
  .vx-map svg { display:block; width:100%; height:auto; max-height:calc(100vh - 290px); }
  .vx-map .prov { stroke:rgba(255,255,255,.28); stroke-width:.8; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
  .vx-map .plabel { fill:rgba(255,255,255,.45); font-size:11px; font-weight:600; letter-spacing:.06em; pointer-events:none; }
  .vx-map .clu { cursor:pointer; }
  .vx-map .clu circle { fill:#fff; fill-opacity:.88; stroke:#000; stroke-opacity:.6; stroke-width:2px; vector-effect:non-scaling-stroke; }
  .vx-map .clu.sel circle { fill:#3987e5; fill-opacity:1; }
  .vx-map .clu text { fill:#000; font-weight:700; font-family:var(--f-data); pointer-events:none; }
  .vx-map .clu.sel text { fill:#fff; }
  .vx-side { padding:12px; display:flex; flex-direction:column; gap:8px; max-height:calc(100vh - 250px); overflow:auto; }
  .vx-side h4 { margin:0; font-size:15px; font-weight:600; }
  .vx-side .vx-note { white-space:normal; }
  .vx-map .clu circle.hit { fill:transparent; stroke:none; }
  @media (max-width: 780px) { .vx-map { grid-template-columns:minmax(0, 1fr); } .vx-side { max-height:none; } .tl { max-height:none; } }
  /* files */
  .vx-files { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:12px; }
  .vx-file { display:flex; flex-direction:column; overflow:hidden; border-radius:18px; }
  .vx-thumb { height:118px; display:grid; place-items:center; background:rgba(255,255,255,.035); border-bottom:1px solid var(--line); overflow:hidden; }
  .vx-thumb img { width:100%; height:100%; object-fit:cover; }
  .vx-ext { font-family:var(--f-data); font-size:15px; font-weight:600; letter-spacing:.06em; border:1px solid var(--line-2); border-radius:12px; padding:10px 12px; color:#fff; background:rgba(255,255,255,.06); }
  .vx-fmeta { padding:10px 12px 12px; display:flex; flex-direction:column; gap:4px; min-width:0; }
  .vx-fmeta b { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .vx-fmeta .vx-note { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .vx-fmeta .vx-note + .vx-note { white-space:normal; }
  .vx-fact { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; }
  .vx-fact a, .vx-fact button { font-size:12px; padding:4px 10px; text-decoration:none; }
  /* dashboards */
  .vx-dash { max-width:1240px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
  .vx-dash h1 { margin:0; font-family:var(--f-display); font-weight:600; font-size:28px; letter-spacing:-.03em; }
  .vx-dtabs { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .vx-grid { display:grid; align-items:start; grid-template-columns:repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap:14px; }
  .vx-w { padding:16px 18px; border-radius:24px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .vx-w.wide { grid-column:span 2; }
  @media (max-width: 760px) { .vx-w.wide { grid-column:auto; } }
  .vx-wh { display:flex; align-items:center; gap:6px; }
  @media (pointer: coarse) { .vx-wh .icon-btn { min-height:40px; min-width:40px; font-size:14px; } }
  @media (max-width: 760px) { .vx-wh { gap:8px; } .vx-wh .icon-btn { min-height:44px; min-width:44px; font-size:14px; } .vx-wh .vx-wmove { transform:rotate(90deg); } } /* widgets stack on a phone, so the arrows point up/down */
  .vx-wh .icon-btn:disabled { opacity:.35; cursor:default; }
  .vx-wh h3 { margin:0; font-size:15px; font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .vx-big { font-family:var(--f-display); font-weight:300; font-size:46px; letter-spacing:-.035em; line-height:1; font-variant-numeric:tabular-nums; }
  .vx-batt { display:flex; height:16px; border-radius:99px; overflow:hidden; gap:2px; background:rgba(255,255,255,.05); }
  .vx-batt span { height:100%; }
  .vx-lb { display:flex; flex-direction:column; gap:8px; }
  .vx-lbr { display:grid; grid-template-columns:22px 26px minmax(0, 1fr) auto; gap:8px; align-items:center; font-size:13px; }
  .vx-lbr .rank { color:var(--muted); font-family:var(--f-data); font-size:11.5px; }
  .vx-lbr .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .vx-lbr .track { grid-column:3 / 5; height:4px; border-radius:99px; background:rgba(255,255,255,.06); margin-top:-4px; }
  .vx-lbr .track span { display:block; height:100%; border-radius:99px; background:#fff; }
  .vx-tbl { width:100%; border-collapse:collapse; font-size:12.5px; }
  .vx-tbl th { color:var(--muted); font-weight:500; text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  .vx-tbl td:first-child { max-width:150px; }
  .vx-tbl td { padding:7px 8px; border-bottom:1px solid rgba(255,255,255,.05); white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
  .vx-tbl tr[data-open] { cursor:pointer; } .vx-tbl tr[data-open]:hover td { background:rgba(255,255,255,.04); }
  .vx-scroll { overflow:auto; max-height:360px; }
  .vx-wf { display:flex; flex-direction:column; gap:12px; }
  .vx-boards { display:flex; flex-wrap:wrap; gap:4px; max-height:180px; overflow:auto; border:1px solid var(--line); border-radius:14px; padding:6px; }
  `;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  // ---------- shared: grouping + charts ----------
  // rows: [{ b, item }]. by: { kind: status|group|person|date, col (title), unit }. measure: { kind: count|sum, col (title) }.
  const findCol = (b, title, types) => title ? b.columns.find(c => types.includes(c.type) && c.title.toLowerCase() === String(title).toLowerCase()) : null;
  function keysOf(r, by) {
    const { b, item } = r, v = item.values || {};
    if (by.kind === 'group') { const g = b.groups.find(x => x.id === item.group); return [g ? { key: g.name, label: g.name, color: g.color } : { key: '∅', label: 'No group', color: '#6b7280' }]; }
    if (by.kind === 'status') { const c = findCol(b, by.col, ['status']); const l = c && A.labelOf(c, v[c.id]); return [l ? { key: l.label.toLowerCase(), label: l.label, color: l.color, order: (c.labels || []).indexOf(l) } : { key: '∅', label: 'No status', color: '#6b7280', order: 999 }]; }
    if (by.kind === 'person') { const c = findCol(b, by.col, ['person']); const ps = c ? A.splitPeople(v[c.id]) : []; return ps.length ? ps.map(p => ({ key: p.toLowerCase(), label: p })) : [{ key: '∅', label: 'Unassigned', color: '#6b7280' }]; }
    if (by.kind === 'date') {
      const c = by.col === '__created' ? null : findCol(b, by.col, ['date']); const d = c ? dn(v[c.id]) : by.col === '__created' ? dn(String(item.createdAt || '').slice(0, 10)) : null;
      if (d == null) return [];
      if (by.unit === 'week') { const w = weekStart(d); return [{ key: ds(w), label: short(w), order: w }]; }
      const x = new Date(d * 864e5); return [{ key: ds(d).slice(0, 7), label: MON[x.getUTCMonth()] + ' ' + x.getUTCFullYear(), order: x.getUTCFullYear() * 12 + x.getUTCMonth() }];
    }
    return [{ key: 'all', label: 'All' }];
  }
  function aggregate(rows, by, measure, stack) {
    const cats = new Map(), stacks = new Map();
    for (const r of rows) {
      const mc = measure && measure.kind === 'sum' ? findCol(r.b, measure.col, ['number', 'formula']) : null;
      if (measure && measure.kind === 'sum' && !mc) continue;
      const val = mc ? numVal(r.b, r.item, mc) : 1;
      const sk = stack ? keysOf(r, stack)[0] : null;
      if (sk && !stacks.has(sk.key)) stacks.set(sk.key, { ...sk });
      for (const k of keysOf(r, by)) {
        let c = cats.get(k.key); if (!c) cats.set(k.key, c = { ...k, value: 0, n: 0, parts: {}, rows: [] });
        c.value += val; c.n++; c.rows.push(r); if (sk) c.parts[sk.key] = (c.parts[sk.key] || 0) + val;
      }
    }
    let list = [...cats.values()];
    if (by.kind === 'date') { list.sort((a, b) => a.order - b.order); const max = by.unit === 'week' ? 26 : 24; if (list.length > max) list = list.slice(-max); }
    else if (by.kind === 'status') list.sort((a, b) => a.order - b.order || b.value - a.value);
    else { list.sort((a, b) => b.value - a.value); if (list.length > 14) { const rest = list.slice(13); list = list.slice(0, 13); const o = { key: '__other', label: `Other (${rest.length})`, color: '#6b7280', value: 0, n: 0, parts: {}, rows: [] }; rest.forEach(x => { o.value += x.value; o.n += x.n; o.rows.push(...x.rows); Object.entries(x.parts).forEach(([k, v]) => { o.parts[k] = (o.parts[k] || 0) + v; }); }); list.push(o); } }
    let ci = 0; list.forEach(c => { if (!c.color) c.color = CAT[ci++ % CAT.length]; });
    const sl = [...stacks.values()]; let si = 0; sl.forEach(s => { if (!s.color) s.color = CAT[si++ % CAT.length]; });
    if (stack && stack.kind === 'status') sl.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    return { cats: list, stacks: sl, total: list.reduce((s, c) => s + c.value, 0) };
  }
  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const tick = max => { if (max <= 0) return 1; const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  // Draws an aggregate as SVG at width W (px). kind: bar | stacked | pie | line
  function chartSvg(agg, kind, W, fmt, opts = {}) {
    const cats = agg.cats; if (!cats.length) return '<p class="vx-note">Nothing to chart yet. No items match.</p>';
    const f = fmt || fmtN, timeAxis = opts.timeAxis;
    if (kind === 'pie') {
      if (cats.length > 8) { const top = cats.slice().sort((x, y) => y.value - x.value), rest = top.slice(7); agg = { ...agg, cats: [...top.slice(0, 7), { key: '__other', label: `Other (${rest.length})`, color: '#6b7280', value: rest.reduce((t, x) => t + x.value, 0) }] }; }
      const cats2 = agg.cats;
      const size = Math.min(W, 260), r = size / 2 - 6, ir = r * 0.62, cx = size / 2, cy = size / 2, tot = agg.total || 1;
      let a0 = -Math.PI / 2; const gap = cats.length > 1 ? 0.012 : 0;
      const arcs = cats2.filter(c => c.value > 0).map(c => {
        const a1 = a0 + (c.value / tot) * Math.PI * 2, s = a0 + gap, e = Math.max(s + 0.001, a1 - gap); a0 = a1;
        const big = e - s > Math.PI ? 1 : 0, P = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)].map(x => x.toFixed(2)).join(' ');
        const d = (e - s) >= Math.PI * 2 - 0.01 ? `M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}M${cx - ir} ${cy}A${ir} ${ir} 0 1 0 ${cx + ir} ${cy}A${ir} ${ir} 0 1 0 ${cx - ir} ${cy}Z`
          : `M${P(r, s)}A${r} ${r} 0 ${big} 1 ${P(r, e)}L${P(ir, e)}A${ir} ${ir} 0 ${big} 0 ${P(ir, s)}Z`;
        return `<path class="mark" d="${d}" fill="${esc(c.color)}" fill-rule="evenodd" data-vxcat="${esc(c.key)}"><title>${esc(c.label)}: ${esc(f(c.value))} (${Math.round(c.value / tot * 100)}%)</title></path>`;
      }).join('');
      const legend = cats2.map(c => `<span><i style="background:${esc(c.color)}"></i>${esc(trunc(c.label, 28))} <b style="font-family:var(--f-data);font-weight:500">${esc(f(c.value))}</b><span class="vx-note">${Math.round(c.value / tot * 100)}%</span></span>`).join('');
      return `<div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center"><svg viewBox="0 0 ${size} ${size}" style="width:${size}px;max-width:100%;flex:none" role="img" aria-label="Pie chart">${arcs}<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="val" style="font-size:20px">${esc(f(agg.total))}</text><text x="${cx}" y="${cy + 16}" text-anchor="middle">total</text></svg><div class="vx-legend" style="flex-direction:column;flex:1 1 180px">${legend}</div></div>`;
    }
    const stacked = kind === 'stacked' && agg.stacks.length;
    const legend = stacked ? `<div class="vx-legend">${agg.stacks.map(s => `<span><i style="background:${esc(s.color)}"></i>${esc(trunc(s.label, 26))}</span>`).join('')}</div>` : '';
    if (kind === 'line' || timeAxis) {
      // columns or a line along the x axis (dates read left to right)
      const max = Math.max(...cats.map(c => c.value), 0), step = tick(max), top = Math.ceil(max / step) * step || 1;
      // left padding fits the widest y-axis label (e.g. $1,500,000)
      const H = opts.height || 240, pl = Math.max(44, Math.ceil(String(f(top)).length * 6.6) + 14), pr = 10, pt = 16, pb = 30, iw = W - pl - pr, ih = H - pt - pb;
      const y = v => pt + ih - (v / top) * ih, bw = iw / cats.length;
      let grid = ''; for (let v = 0; v <= top + 1e-9; v += step) grid += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${esc(f(v))}</text>`;
      const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(iw / 58))));
      const xl = cats.map((c, i) => i % every ? '' : `<text x="${pl + bw * i + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(trunc(c.label, Math.max(10, Math.floor(bw * every / 6.6) - 1)))}</text>`).join('');
      let marks = '';
      if (kind === 'line') {
        const pts = cats.map((c, i) => [pl + bw * i + bw / 2, y(c.value)]);
        marks = `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('')} L${pts[pts.length - 1][0].toFixed(1)} ${y(0)} L${pts[0][0].toFixed(1)} ${y(0)}Z" fill="#3987e5" fill-opacity=".12"/>`
          + `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('')}" fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round"/>`
          + pts.map((p, i) => `<g class="mark" data-vxcat="${esc(cats[i].key)}"><rect x="${(p[0] - bw / 2).toFixed(1)}" y="${pt}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"/><circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="#3987e5" stroke="#000" stroke-width="2"/><title>${esc(cats[i].label)}: ${esc(f(cats[i].value))}</title></g>`).join('');
      } else {
        const w = Math.max(2, Math.min(46, bw - 4));
        marks = cats.map((c, i) => {
          const x = pl + bw * i + (bw - w) / 2;
          if (!stacked) return `<rect class="mark" data-vxcat="${esc(c.key)}" x="${x.toFixed(1)}" y="${y(c.value).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, y(0) - y(c.value)).toFixed(1)}" rx="3" fill="${opts.mono ? '#3987e5' : esc(c.color)}"><title>${esc(c.label)}: ${esc(f(c.value))}</title></rect>`;
          let acc = 0; return agg.stacks.map(s => { const v = c.parts[s.key] || 0; if (!v) return ''; const y1 = y(acc + v), y0 = y(acc); acc += v; return `<rect class="mark" data-vxcat="${esc(c.key)}" x="${x.toFixed(1)}" y="${(y1 + 1).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, y0 - y1 - 2).toFixed(1)}" rx="2" fill="${esc(s.color)}"><title>${esc(c.label)} · ${esc(s.label)}: ${esc(f(v))}</title></rect>`; }).join('');
        }).join('');
      }
      return legend + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${grid}${marks}${xl}</svg>`;
    }
    // horizontal bars: category labels on the left
    const lw = Math.min(170, Math.max(90, W * 0.32)), vw = 70, iw = Math.max(40, W - lw - vw), rh = 28, H = cats.length * rh + 6;
    const max = Math.max(...cats.map(c => c.value), 0) || 1, chars = Math.floor(lw / 7.2);
    const rowsSvg = cats.map((c, i) => {
      const yy = i * rh + 4, len = (c.value / max) * iw;
      let bar;
      if (stacked) { let acc = 0; bar = agg.stacks.map(s => { const v = c.parts[s.key] || 0; if (!v) return ''; const x = lw + (acc / max) * iw, w = (v / max) * iw; acc += v; return `<rect class="mark" data-vxcat="${esc(c.key)}" x="${(x + 1).toFixed(1)}" y="${yy + 3}" width="${Math.max(1, w - 2).toFixed(1)}" height="${rh - 12}" rx="2" fill="${esc(s.color)}"><title>${esc(c.label)} · ${esc(s.label)}: ${esc(f(v))}</title></rect>`; }).join(''); }
      else bar = `<rect class="mark" data-vxcat="${esc(c.key)}" x="${lw}" y="${yy + 3}" width="${Math.max(2, len).toFixed(1)}" height="${rh - 12}" rx="4" fill="${esc(c.color)}"><title>${esc(c.label)}: ${esc(f(c.value))}</title></rect>`;
      return `<text x="${lw - 8}" y="${yy + 15}" text-anchor="end">${esc(trunc(c.label, chars))}<title>${esc(c.label)}</title></text>${bar}<text class="val" x="${(lw + len + 6).toFixed(1)}" y="${yy + 15}">${esc(f(c.value))}</text>`;
    }).join('');
    return legend + `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${rowsSvg}</svg>`;
  }

  // ---------- head: tabs and per-view controls ----------
  function tabs(b) {
    // after the frame is laid out anyway (reading scrollWidth right after the header renders forced an extra layout)
    requestAnimationFrame(() => { const c = document.querySelector('.head .tabs'), t = c && c.querySelector('.tab[aria-pressed="true"]'); if (t && c.scrollWidth > c.clientWidth) c.scrollLeft = t.offsetLeft - c.clientWidth / 2 + t.offsetWidth / 2; });
    return TYPES.map(([k, l]) => `<button class="tab" data-act="view" data-v="${k}" aria-pressed="${A.S.view === k && !A.S.viewId}">${l}</button>`).join('');
  }
  const sel = (k, opts, cur, label) => `<select class="kbd-select" data-vxset="${k}" aria-label="${esc(label)}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const seg = (k, opts, cur) => `<span class="vx-seg">${opts.map(([v, l]) => `<button data-vx="set" data-k="${k}" data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}">${esc(l)}</button>`).join('')}</span>`;
  function head(b) {
    const t = A.S.view; if (!has(t)) return '';
    let h = '';
    if (t === 'timeline') {
      const sp = tlSpec(b); const c = cfg(t);
      const modes = [...(timelineCols(b).length ? [['timeline', 'Timeline column']] : []), ['dates', 'Start / end dates']];
      if (modes.length > 1) h += sel('mode', modes, sp.mode, 'Bars from');
      if (sp.mode === 'timeline') { if (timelineCols(b).length > 1) h += sel('tlCol', timelineCols(b).map(x => [x.id, x.title]), sp.tl && sp.tl.id, 'Timeline column'); }
      else if (dateCols(b).length) {
        h += sel('start', dateCols(b).map(x => [x.id, 'Start: ' + x.title]), sp.start && sp.start.id, 'Start date');
        h += sel('end', [['_none', 'End: same day'], ...dateCols(b).map(x => [x.id, 'End: ' + x.title])], sp.end ? sp.end.id : '_none', 'End date');
      }
      h += seg('zoom', [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']], c.zoom || 'week');
      h += sel('color', [['group', 'Colour: group'], ...statusCols(b).map(x => [x.id, 'Colour: ' + x.title])], c.color || (statusCols(b)[0] || {}).id || 'group', 'Bar colour');
    }
    if (t === 'workload') {
      const sp = wlSpec(b);
      if (personCols(b).length > 1) h += sel('person', personCols(b).map(x => [x.id, 'People: ' + x.title]), sp.person && sp.person.id, 'Person column');
      if (dateCols(b).length) h += sel('date', dateCols(b).map(x => [x.id, 'By ' + x.title]), sp.date && sp.date.id, 'Date column');
      h += sel('num', [['', 'Count items'], ...numCols(b).map(x => [x.id, 'Sum ' + x.title])], sp.num ? sp.num.id : '', 'Measure');
      h += sel('weeks', [[4, '4 weeks'], [8, '8 weeks'], [12, '12 weeks']], sp.weeks, 'Weeks shown');
      h += `<label class="vx-note">Capacity / week <input class="search" style="width:80px" inputmode="decimal" data-vxset="cap" value="${esc(sp.cap)}" placeholder="auto" aria-label="Capacity per person per week"></label>`;
    }
    if (t === 'chart') {
      const sp = chSpec(b);
      h += seg('kind', [['bar', 'Bar'], ['stacked', 'Stacked'], ['pie', 'Pie'], ['line', 'Line']], sp.kind);
      h += sel('by', byOptions(b), sp.by, 'Group by');
      h += sel('measure', [['count', 'Count items'], ...numCols(b).map(x => ['sum:' + x.id, 'Sum ' + x.title])], sp.measure, 'Measure');
      if (sp.kind === 'stacked') h += sel('stack', [['group', 'Stack: group'], ...statusCols(b).map(x => ['status:' + x.id, 'Stack: ' + x.title])], sp.stack, 'Stack by');
    }
    if (t === 'map') {
      const sp = mapSpec(b);
      if (locCols(b).length) h += sel('loc', locCols(b).map(x => [x.id, 'Place: ' + x.title]), sp.loc && sp.loc.id, 'Location column');
      h += sel('region', REGIONS.map(r => [r[0], r[1]]), cfg('map').region || 'all', 'Region');
    }
    if (t === 'files') h += '';
    const v = savedView();
    if (A.S.canWrite && !v) h += `<button class="btn" data-act="save-view">Save as view</button>`;
    if (A.S.canWrite && v && v.type === t && dirty(t)) h += `<button class="btn primary" data-vx="update-view">Update view</button>`;
    if (h) h = `<details class="vx-opts" ${optsOpen || wideOpts() ? 'open' : ''}><summary class="btn">View options</summary><div class="vx-optrow">${h}</div></details>`;
    if (h && optsOpen) requestAnimationFrame(fitOpts);
    return h;
  }
  let optsOpen = false;
  const wideOpts = () => window.matchMedia('(min-width: 1700px)').matches;
  // the options panel closes on a click outside it or Escape (it stays open while you change its settings)
  const panelMode = () => window.matchMedia('(min-width: 781px) and (max-width: 1699px)').matches;
  document.addEventListener('click', e => { const d = document.querySelector('.vx-opts[open]'); if (d && panelMode() && !d.contains(e.target)) { d.open = false; optsOpen = false; } }, true);
  document.addEventListener('keydown', e => { const d = document.querySelector('.vx-opts[open]'); if (e.key === 'Escape' && d && panelMode()) { d.open = false; optsOpen = false; e.stopPropagation(); } }, true);
  document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('vx-opts')) { optsOpen = e.target.open; fitOpts(); } }, true);
  // the panel opens under its button; slide it left when it would run past the right edge of the window
  function fitOpts() {
    const r = document.querySelector('.vx-opts[open] > .vx-optrow'); if (!r) return;
    r.style.left = ''; if (!panelMode()) return;
    const rc = r.getBoundingClientRect(), over = rc.right - (document.documentElement.clientWidth - 12);
    if (over > 0) r.style.left = -Math.min(over, Math.max(0, rc.left - 12)) + 'px';
  }
  function byOptions(b) {
    return [...statusCols(b).map(x => ['status:' + x.id, 'By ' + x.title]), ['group', 'By group'], ...personCols(b).map(x => ['person:' + x.id, 'By ' + x.title]),
      ...dateCols(b).flatMap(x => [['date:' + x.id + ':month', `By ${x.title} (month)`], ['date:' + x.id + ':week', `By ${x.title} (week)`]]), ['date:__created:month', 'By created (month)']];
  }

  // ---------- Timeline ----------
  const ZOOM = { day: { ppd: 30, days: 56 }, week: { ppd: 9, days: 196 }, month: { ppd: 2.4, days: 760 } };
  function tlSpec(b) {
    const c = cfg('timeline'), tls = timelineCols(b), dates = dateCols(b);
    const mode = c.mode === 'dates' || !tls.length ? 'dates' : c.mode === 'timeline' || tls.length ? 'timeline' : 'dates';
    const tl = colById(b, c.tlCol) || tls[0];
    const start = colById(b, c.start) || pick(dates, /start|begin|from|entered|created|first|booked/i) || dates[0];
    const end = c.end === '_none' ? null : colById(b, c.end) || (c.end === undefined ? pick(dates.filter(d => d !== start), /end|due|clos|deadline|finish|paid|until/i) : null) || null;
    return { mode, tl, start, end: end && end !== start ? end : null };
  }
  function tlRange(b, item, sp) {
    const v = item.values || {};
    if (sp.mode === 'timeline') { const m = /(\d{4}-\d\d-\d\d)\D+(\d{4}-\d\d-\d\d)/.exec(String(v[sp.tl && sp.tl.id] || '')); if (!m) { const one = dn(v[sp.tl && sp.tl.id]); return one == null ? null : { s: one, e: one }; } return { s: dn(m[1]), e: Math.max(dn(m[1]), dn(m[2])) }; }
    let s = sp.start ? dn(v[sp.start.id]) : null, e = sp.end ? dn(v[sp.end.id]) : null;
    if (s == null && e == null) return null; if (s == null) s = e; if (e == null) e = s; if (e < s) e = s;
    return { s, e, hasEnd: sp.end && v[sp.end.id] };
  }
  function tlEditable(b, sp) {
    if (!A.S.canWrite) return false;
    const cols = sp.mode === 'timeline' ? [sp.tl] : [sp.start, sp.end].filter(Boolean);
    return cols.length && cols.every(c => c && !c.readonly && A.colEditable(c, b));
  }
  let tlJump = false;
  function renderTimeline(b) {
    const sp = tlSpec(b), c = cfg('timeline');
    if (sp.mode === 'timeline' ? !sp.tl : !sp.start) return `<div class="empty"><h3>Timeline needs dates</h3>Add a Date column (or a timeline column) with “+ Column”, then items show as bars across the calendar.</div>`;
    const z = ZOOM[c.zoom || 'week'], ppd = z.ppd, today = todayDn();
    const from = today + (c.off || 0) - Math.floor(z.days * 0.25), to = from + z.days, W = Math.round(z.days * ppd), LW = narrow() ? 132 : 230;
    // keep the scroll position on a re-render of the same range; otherwise (first open, ‹ Today ›, zoom) bring the focus day (today + offset) into view
    const tlKey = `${A.S.boardId}:${from}:${c.zoom || 'week'}`, prevTl = document.getElementById('vx-tl'), keepTl = !tlJump && prevTl && prevTl.dataset.k === tlKey ? [prevTl.scrollLeft, prevTl.scrollTop] : null;
    tlJump = false;
    pending.push(() => { const p = document.getElementById('vx-tl'); if (!p) return; p.dataset.k = tlKey; if (keepTl) { p.scrollLeft = keepTl[0]; p.scrollTop = keepTl[1]; } else p.scrollLeft = Math.max(0, (today + (c.off || 0) - from) * ppd - (p.clientWidth - LW) / 2); });
    const editable = tlEditable(b, sp), colorCol = colById(b, c.color === undefined ? (statusCols(b)[0] || {}).id : c.color);
    const items = A.visibleItems(); let outside = 0, undated = 0;
    const rowsBy = new Map();
    for (const it of items) { const r = tlRange(b, it, sp); if (!r) { undated++; continue; } if (r.e < from || r.s > to) { outside++; continue; } (rowsBy.get(it.group) || rowsBy.set(it.group, []).get(it.group)).push({ it, r }); }
    // header ticks
    let top = '', ticks = '', bg = '';
    for (let d = from; d <= to; d++) {
      const x = (d - from) * ppd, dt = new Date(d * 864e5), dom = dt.getUTCDate(), mo = dt.getUTCMonth(), dow = dt.getUTCDay();
      // the range's first month only gets a label when there's room before the next month's label
      // …and a month starting right at the end of the range is left out rather than cut off ("Jan 202")
      const lead = (dom === 1 || (d === from && (new Date(Date.UTC(dt.getUTCFullYear(), mo + 1, 0)).getUTCDate() - dom + 1) * ppd >= 100)) && (to - d + 1) * ppd >= 70;
      if (c.zoom === 'month') { if (dom === 1) { ticks += `<span class="tl-tick" style="left:${x}px">${MON[mo]}</span>`; if (mo === 0) top += `<span class="tl-top" style="left:${x}px">${dt.getUTCFullYear()}</span>`; } }
      else if (c.zoom === 'day') { ticks += `<span class="tl-tick" style="left:${x}px;width:${ppd}px">${dom}</span>`; if (lead) top += `<span class="tl-top" style="left:${x}px">${MON[mo]} ${dt.getUTCFullYear()}</span>`; if (dow === 0 || dow === 6) bg += `<div class="tl-weekend" style="left:${LW + x}px;width:${ppd}px"></div>`; }
      else { if (dow === 1) ticks += `<span class="tl-tick" style="left:${x}px">${dom}</span>`; if (lead) top += `<span class="tl-top" style="left:${x}px">${MON[mo]}${mo === 0 || !top ? ' ' + dt.getUTCFullYear() : ''}</span>`; }
    }
    const lim = c.lim || {};
    const groups = [...b.groups, { id: '__none', name: 'No group', color: '#6b7280' }].map(g => {
      const list = (g.id === '__none' ? [...rowsBy.entries()].filter(([k]) => !b.groups.some(x => x.id === k)).flatMap(([, v]) => v) : rowsBy.get(g.id) || []).sort((x, y) => x.r.s - y.r.s);
      if (!list.length) return '';
      const n = lim[g.id] || 60;
      const rows = list.slice(0, n).map(({ it, r }) => {
        const x = (Math.max(r.s, from) - from) * ppd, w = Math.max(8, (Math.min(r.e, to) - Math.max(r.s, from) + 1) * ppd), hd = editable && w >= 28;
        const l = colorCol && colorCol.type === 'status' ? A.labelOf(colorCol, (it.values || {})[colorCol.id]) : null, col = l ? l.color : g.color;
        const tip = `${it.name}: ${ds(r.s)}${r.e !== r.s ? ' → ' + ds(r.e) : ''}${l ? ' · ' + l.label : ''}`;
        return `<div class="tl-row"><div class="tl-label" style="width:${LW}px"><button data-act="open" data-item="${esc(it.id)}" title="${A.cardName ? A.cardName(b, it) : esc(it.name)}">${A.cardName ? A.cardName(b, it) : esc(it.name)}</button></div>
          <div class="tl-track" style="width:${W}px"><div class="tl-bar" ${editable ? `data-edit="1"` : `data-act="open" data-item="${esc(it.id)}"`} data-tlbar="${esc(it.id)}" data-s="${r.s}" data-e="${r.e}" data-ppd="${ppd}" style="left:${x}px;width:${w}px${col ? `;--c:${esc(col)}` : ''}${w > 36 ? '' : ';padding:0'}" title="${esc(tip)}">${hd ? '<span class="tl-h l" data-h="l"></span>' : ''}${w > 36 ? esc(it.name) : ''}${hd ? '<span class="tl-h r" data-h="r"></span>' : ''}</div></div></div>`;
      }).join('');
      const more = list.length > n ? `<div class="tl-row tl-more"><div class="tl-label" style="width:${LW}px"><button data-vx="tl-more" data-g="${esc(g.id)}">Show ${Math.min(60, list.length - n)} more · ${list.length - n} hidden</button></div><div class="tl-track" style="width:${W}px"></div></div>` : '';
      return `<div class="tl-grp" style="--gc:${esc(g.color)}"><div class="tl-label" style="width:${LW}px">${esc(g.name)} <span class="group-count">${list.length}</span></div><div class="tl-track" style="width:${W}px"></div></div>${rows}${more}`;
    }).join('');
    const tx = LW + (today - from) * ppd + (c.zoom === 'day' ? ppd / 2 : 0);
    return `<div class="vx-bar"><button class="btn" data-vx="tl-nav" data-d="-1" aria-label="Earlier">‹</button><button class="btn" data-vx="tl-nav" data-d="0">Today</button><button class="btn" data-vx="tl-nav" data-d="1" aria-label="Later">›</button>
      <span class="vx-note">${esc(short(from))} ${new Date(from * 864e5).getUTCFullYear()} – ${esc(short(to))} ${new Date(to * 864e5).getUTCFullYear()}${outside ? ` · ${outside} outside this range` : ''}${undated ? ` · ${undated} without dates` : ''}${editable ? ' · drag a bar to move it, drag its ends to change the dates' : A.S.canWrite ? ' · these dates are locked for you' : ''}</span></div>
      <div class="tl vx-panel" id="vx-tl"><div class="tl-in" style="width:${LW + W}px">${bg}
        <div class="tl-headrow"><div class="tl-label" style="width:${LW}px">${esc(sp.mode === 'timeline' ? sp.tl.title : sp.start.title + (sp.end ? ' → ' + sp.end.title : ''))}</div><div class="tl-ticks" style="width:${W}px">${top}${ticks}</div></div>
        ${groups || `<div class="tl-row"><div class="tl-label" style="width:${LW}px"><span class="vx-note">No items in this range.</span></div><div class="tl-track" style="width:${W}px"></div></div>`}
        ${today >= from && today <= to ? `<div class="tl-today" style="left:${tx}px" title="Today"></div>` : ''}
      </div></div>`;
  }
  // dragging a bar (mouse, pen or touch)
  let drag = null, suppressClick = false, tip = null;
  const showTip = (x, y, text) => { if (!tip) { tip = document.createElement('div'); tip.className = 'tl-tip'; document.body.appendChild(tip); } tip.textContent = text; tip.style.left = Math.min(x + 12, innerWidth - 220) + 'px'; tip.style.top = (y - 34) + 'px'; };
  const hideTip = () => { if (tip) { tip.remove(); tip = null; } };
  document.addEventListener('pointerdown', e => {
    const bar = e.target.closest && e.target.closest('[data-tlbar]'); if (!bar || bar.dataset.edit !== '1' || (e.button && e.button !== 0)) return;
    const h = e.target.closest('.tl-h');
    drag = { bar, id: bar.dataset.tlbar, mode: h ? h.dataset.h : 'move', x0: e.clientX, y0: e.clientY, ppd: Number(bar.dataset.ppd), s: Number(bar.dataset.s), e: Number(bar.dataset.e), left0: bar.offsetLeft, w0: bar.offsetWidth, moved: false, d: 0 };
    try { bar.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0; if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.bar.classList.add('dragging'); }
    const P = drag.ppd; let d = Math.round(dx / P);
    if (drag.mode === 'l') d = Math.min(d, drag.e - drag.s); if (drag.mode === 'r') d = Math.max(d, drag.s - drag.e);
    drag.d = d;
    const s = drag.mode === 'r' ? drag.s : drag.s + d, en = drag.mode === 'l' ? drag.e : drag.e + d;
    if (drag.mode === 'move') drag.bar.style.left = (drag.left0 + d * P) + 'px';
    if (drag.mode === 'l') { drag.bar.style.left = (drag.left0 + d * P) + 'px'; drag.bar.style.width = Math.max(P, drag.w0 - d * P) + 'px'; }
    if (drag.mode === 'r') drag.bar.style.width = Math.max(P, drag.w0 + d * P) + 'px';
    showTip(e.clientX, e.clientY, ds(s) + (en !== s ? ' → ' + ds(en) : ''));
  });
  const endDrag = (e, cancel) => {
    if (!drag) return; const g = drag; drag = null; hideTip(); g.bar.classList.remove('dragging');
    if (!g.moved) { if (!cancel) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); openItem(g.id); } return; }
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    if (cancel || !g.d) { A.renderContent(); return; }
    const s = g.mode === 'r' ? g.s : g.s + g.d, en = g.mode === 'l' ? g.e : g.e + g.d;
    commitDates(g.id, g.s, g.e, s, en, g.mode);
  };
  document.addEventListener('pointerup', e => endDrag(e, false));
  document.addEventListener('pointercancel', e => endDrag(e, true));
  document.addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  function openItem(id) { const S = A.S; S.draftFiles = []; S.openItem = id; S.drawerTab = (A.board() && A.board().form) ? 'fact' : 'updates'; A.renderLayer(); }
  function shiftDt(item, col, days) {
    const k = col.id + '__dt', v = (item.values || {})[k]; if (!v) return;
    const t = Date.parse(v); if (isNaN(t)) return;
    const iso = new Date(t + days * 864e5).toISOString().replace('.000Z', 'Z');
    item.values = { ...item.values, [k]: iso }; A.patchItem(item.id, { values: { [k]: iso } });
  }
  function commitDates(id, s0, e0, s, e, mode) {
    const b = A.board(), item = A.itemById(id); if (!b || !item) return;
    const sp = tlSpec(b); if (!tlEditable(b, sp)) { A.toast('You can’t change these dates.'); A.renderContent(); return; }
    if (sp.mode === 'timeline') { A.setValue(id, sp.tl.id, `${ds(s)} - ${ds(e)}`); }
    else {
      const v = item.values || {}, hadEnd = sp.end && v[sp.end.id], hadStart = sp.start && v[sp.start.id];
      if (s !== s0 && sp.start && (hadStart || !hadEnd)) { shiftDt(item, sp.start, s - s0); A.setValue(id, sp.start.id, ds(s)); }
      if (e !== e0 && sp.end && (hadEnd || mode === 'r')) { shiftDt(item, sp.end, e - e0); A.setValue(id, sp.end.id, ds(e)); }
      if (s !== s0 && !hadStart && hadEnd && mode !== 'r') { shiftDt(item, sp.end, e - e0); A.setValue(id, sp.end.id, ds(e)); }
    }
    A.toast(`${item.name}: ${ds(s)}${e !== s ? ' → ' + ds(e) : ''}`);
    A.render();
  }

  // ---------- Workload ----------
  function wlSpec(b) {
    const c = cfg('workload');
    const person = colById(b, c.person) || personCols(b)[0], date = colById(b, c.date) || pick(dateCols(b), /follow|due|next|callback|start/i) || dateCols(b)[0];
    const num = c.num ? colById(b, c.num) : null;
    return { person, date, num, weeks: Number(c.weeks) || (narrow() ? 4 : 8), cap: c.cap ?? '' };
  }
  function renderWorkload(b) {
    const sp = wlSpec(b), c = cfg('workload');
    if (!sp.person) return `<div class="empty"><h3>Workload needs a person column</h3>Add a Person column, then each person’s items per week show here.</div>`;
    if (!sp.date) return `<div class="empty"><h3>Workload needs a date column</h3>Add a Date column so items fall into weeks.</div>`;
    const w0 = weekStart(todayDn()) + 7 * (c.off || 0), weeks = Array.from({ length: sp.weeks }, (_, k) => w0 + 7 * k), end = w0 + 7 * sp.weeks;
    const cells = new Map(); let undated = 0;
    for (const it of A.visibleItems()) {
      const d = dn((it.values || {})[sp.date.id]); if (d == null) { undated++; continue; } if (d < w0 || d >= end) continue;
      const wk = weekStart(d), val = sp.num ? numVal(b, it, sp.num) : 1;
      const ps = A.splitPeople((it.values || {})[sp.person.id]); (ps.length ? ps : ['Unassigned']).forEach(p => { const k = p + '|' + wk; const x = cells.get(k) || { v: 0, items: [] }; x.v += val; x.items.push(it); cells.set(k, x); });
    }
    const people = [...new Set([...cells.keys()].map(k => k.split('|')[0]))].sort((x, y) => x === 'Unassigned' ? 1 : y === 'Unassigned' ? -1 : x.localeCompare(y));
    const vals = [...cells.values()].map(x => x.v).filter(v => v > 0);
    const cap = Number(sp.cap) > 0 ? Number(sp.cap) : Math.max(1, Math.ceil((vals.reduce((s, v) => s + v, 0) / (vals.length || 1)) * 1.2));
    const shade = v => { if (!v) return ''; const r = v / cap, col = r > 1 ? STATUS.bad : r > 0.8 ? STATUS.warn : STATUS.good; return `background:color-mix(in srgb, ${col} ${Math.round(18 + Math.min(1.2, r) * 30)}%, transparent);border-color:color-mix(in srgb, ${col} 55%, transparent)`; };
    const fv = v => sp.num ? fmtVal(sp.num, v) : String(v);
    const selK = c.sel || '';
    const rows = people.map(p => `<tr><td class="who">${p === 'Unassigned' ? '' : `<span class="av" style="background:${A.hue(p)}">${esc(A.initials(p))}</span>`}${esc(p)}</td>${weeks.map(wk => { const x = cells.get(p + '|' + wk), v = x ? x.v : 0, k = p + '|' + wk; return `<td><button class="wl-cell ${v ? '' : 'zero'}" style="${shade(v)}" data-vx="wl-cell" data-k="${esc(k)}" aria-pressed="${selK === k}" title="${esc(p)}, week of ${esc(short(wk))}: ${esc(fv(v))}${v > cap ? ' (over capacity)' : ''}">${v ? esc(fv(v)) + (v > cap ? ' ▲' : '') : '·'}</button></td>`; }).join('')}<td class="wl-tot">${esc(fv(weeks.reduce((s, wk) => s + ((cells.get(p + '|' + wk) || {}).v || 0), 0)))}</td></tr>`).join('');
    const picked = selK && cells.get(selK);
    const list = picked ? `<div class="sec" style="margin:14px 4px 0"><h2 style="font-size:15px">${esc(selK.split('|')[0])} · week of ${esc(short(Number(selK.split('|')[1])))} · ${picked.items.length} item${picked.items.length === 1 ? '' : 's'}</h2></div><div class="vx-list">${picked.items.map(it => itemCard(b, it, [sp.date, sp.num].filter(Boolean))).join('')}</div>` : '';
    return `<div class="vx-bar"><button class="btn" data-vx="wl-nav" data-d="-1" aria-label="Earlier weeks">‹</button><button class="btn" data-vx="wl-nav" data-d="0">This week</button><button class="btn" data-vx="wl-nav" data-d="1" aria-label="Later weeks">›</button>
      <span class="vx-note">${sp.num ? 'Sum of ' + esc(sp.num.title) : 'Items'} per person per week by ${esc(sp.date.title)}. Capacity ${esc(fv(cap))}${Number(sp.cap) > 0 ? '' : ' (from the average; set your own above)'}${undated ? ` · ${undated} without a date` : ''}</span>
      <span class="wl-key"><i style="background:${STATUS.good}"></i>Under</span><span class="wl-key"><i style="background:${STATUS.warn}"></i>Near</span><span class="wl-key"><i style="background:${STATUS.bad}"></i>Over ▲</span></div>
      <div class="wl vx-panel" style="padding:8px"><table><thead><tr><th class="who">Person</th>${weeks.map(wk => `<th>${esc(short(wk))}</th>`).join('')}<th>Total</th></tr></thead><tbody>${rows || `<tr><td class="who vx-note" colspan="${weeks.length + 2}">Nobody has items in these weeks.</td></tr>`}</tbody></table></div>${list}`;
  }
  function itemCard(b, it, cols) {
    const sc = statusCols(b)[0], l = sc && A.labelOf(sc, (it.values || {})[sc.id]);
    return `<button class="card" data-act="open" data-item="${esc(it.id)}" style="cursor:pointer"><span class="card-name">${A.cardName ? A.cardName(b, it) : esc(it.name)}</span><span class="card-meta">${l ? `<span class="pill" style="--c:${esc(l.color)}">${esc(l.label)}</span>` : ''}${cols.map(c => { const v = c.type === 'formula' ? '' : (it.values || {})[c.id]; return v === '' || v == null ? '' : `<span>${esc(c.title)}: ${esc(A.describe(c, v))}</span>`; }).join('')}</span></button>`;
  }

  // ---------- Chart ----------
  function chSpec(b) {
    const c = cfg('chart');
    const byOk = byOptions(b).some(o => o[0] === c.by);
    return { kind: c.kind || 'bar', by: byOk ? c.by : byOptions(b)[0][0], measure: c.measure && (c.measure === 'count' || colById(b, c.measure.slice(4))) ? c.measure : 'count', stack: c.stack || (statusCols(b)[0] ? 'status:' + statusCols(b)[0].id : 'group') };
  }
  function parseBy(b, s) {
    const [kind, id, unit] = String(s).split(':');
    if (kind === 'group') return { kind: 'group' };
    if (kind === 'date' && id === '__created') return { kind: 'date', col: '__created', unit };
    const c = colById(b, id); return { kind, col: c ? c.title : '', unit };
  }
  function renderChart(b) {
    const sp = chSpec(b), by = parseBy(b, sp.by), mc = sp.measure !== 'count' ? colById(b, sp.measure.slice(4)) : null;
    const rows = A.visibleItems().map(item => ({ b, item }));
    const agg = aggregate(rows, by, mc ? { kind: 'sum', col: mc.title } : { kind: 'count' }, sp.kind === 'stacked' ? parseBy(b, sp.stack) : null);
    const c = cfg('chart'), picked = c.sel && agg.cats.find(x => x.key === c.sel);
    pending.push(() => { const el = $('#vx-chart'); if (!el) return; el.innerHTML = chartSvg(agg, sp.kind, Math.max(280, el.clientWidth), mc ? v => fmtVal(mc, v) : null, { timeAxis: by.kind === 'date', mono: by.kind === 'date' }); });
    const list = picked ? `<div class="sec" style="margin:14px 4px 0"><h2 style="font-size:15px">${esc(picked.label)} · ${picked.n} item${picked.n === 1 ? '' : 's'}</h2></div><div class="vx-list">${picked.rows.slice(0, 120).map(r => itemCard(b, r.item, mc ? [mc] : [])).join('')}</div>` : '';
    return `<div class="vx-bar"><span class="vx-note">${mc ? 'Sum of ' + esc(mc.title) : 'Number of items'} ${esc((byOptions(b).find(o => o[0] === sp.by) || ['', ''])[1].toLowerCase())} · total ${esc(mc ? fmtVal(mc, agg.total) : fmtN(agg.total))} · click a bar to list its items</span></div>
      <div class="vx-panel vx-chartbox"><div class="vx-chart" id="vx-chart" data-vx-chartclick="1"></div></div>${list}`;
  }

  // ---------- Map (self-made SVG of Canada; no outside tiles) ----------
  // Coarse outlines, [lng, lat]. Good enough to place clusters by province and city.
  const PROV = {
    BC: { n: 'British Columbia', c: [-123.5, 54], p: [[[-139, 60], [-120, 60], [-120, 53.8], [-118, 52.5], [-114.05, 49], [-123.1, 49], [-123.9, 48.3], [-125.5, 48.9], [-128.4, 50.8], [-127.5, 52], [-129.5, 53.3], [-130.6, 54.7], [-130, 56], [-131.8, 57], [-133.5, 58.5], [-135.5, 59.6], [-137.6, 59.2]]] },
    AB: { n: 'Alberta', c: [-114.8, 55], p: [[[-120, 60], [-110, 60], [-110, 49], [-114.05, 49], [-118, 52.5], [-120, 53.8]]] },
    SK: { n: 'Saskatchewan', c: [-105.8, 55], p: [[[-110, 60], [-102, 60], [-101.4, 49], [-110, 49]]] },
    MB: { n: 'Manitoba', c: [-97.7, 55], p: [[[-102, 60], [-94.8, 60], [-94.2, 58.7], [-92.5, 57], [-90.8, 57.2], [-89, 56.85], [-95.15, 52.8], [-95.15, 49], [-101.4, 49]]] },
    ON: { n: 'Ontario', c: [-86, 50.5], p: [[[-95.15, 49], [-95.15, 52.8], [-89, 56.85], [-87.5, 56], [-85, 55.3], [-82.3, 55.1], [-82.2, 53.2], [-80.6, 51.6], [-79.5, 51.5], [-79.5, 47.4], [-79, 46.7], [-77.5, 46], [-75.5, 45.6], [-74.4, 45.5], [-74.7, 45], [-76.4, 44.1], [-79.2, 43.6], [-79, 43.2], [-79.8, 42.6], [-82.6, 41.7], [-83, 42.2], [-82.4, 43], [-81.7, 44.4], [-80.9, 44.7], [-82, 45.3], [-83.4, 45.9], [-84.5, 46.5], [-84.8, 47.5], [-88.2, 48.8], [-89.5, 48.3], [-91, 48.2], [-93, 48.6], [-94.6, 48.7]]] },
    QC: { n: 'Quebec', c: [-72.5, 52], p: [[[-79.5, 47.4], [-79.5, 51.5], [-78.9, 52.8], [-79.7, 54.5], [-77.2, 55.6], [-76.7, 56], [-77.6, 57.5], [-78.5, 58.6], [-77.8, 60], [-77.5, 62.4], [-75, 62.3], [-73, 62.5], [-71, 61.2], [-69.6, 61], [-69.4, 59], [-67.6, 58.2], [-66, 58.8], [-64.6, 60.3], [-64.4, 58.5], [-65.5, 56.2], [-67.5, 55], [-67, 54.2], [-66.5, 52.8], [-63.6, 52], [-57.1, 51.4], [-60, 50.2], [-64, 50.3], [-66.5, 50.2], [-68.6, 49.2], [-69.7, 48.2], [-69.5, 47.7], [-68, 48.5], [-66, 49.1], [-64.3, 48.9], [-64.5, 48.3], [-65.8, 48.1], [-66.4, 48.1], [-67.6, 48], [-68.3, 47.9], [-69.2, 47.4], [-70, 46.4], [-70.8, 45.4], [-71.5, 45], [-74.7, 45], [-74.4, 45.5], [-75.5, 45.6], [-77.5, 46], [-79, 46.7]]] },
    NB: { n: 'New Brunswick', c: [-66.3, 46.6], p: [[[-67.8, 45.7], [-67.8, 47.1], [-68.3, 47.4], [-68.3, 47.9], [-67.6, 48], [-66.4, 48.1], [-65, 47.9], [-64.8, 47.1], [-64.5, 46.2], [-64.1, 45.9], [-64.4, 45.8], [-65.9, 45.3], [-67.1, 45.1]]] },
    NS: { n: 'Nova Scotia', c: [-63.4, 45], p: [[[-64.4, 45.8], [-63.5, 45.9], [-62, 45.7], [-61.3, 45.6], [-61, 46.6], [-60.5, 47], [-59.8, 46.2], [-60.9, 45.4], [-63.5, 44.6], [-65.6, 43.5], [-66.2, 44.4], [-64.8, 45.2], [-64.4, 45.4]]] },
    PE: { n: 'Prince Edward Island', c: [-63.3, 46.4], p: [[[-64.4, 46.6], [-64, 47], [-62, 46.5], [-62.5, 46], [-63.8, 46.2]]] },
    NL: { n: 'Newfoundland and Labrador', c: [-56.5, 48.8], p: [[[-59.3, 47.6], [-58.2, 49], [-57.6, 50], [-55.5, 51.6], [-55.9, 49.9], [-53.6, 49.6], [-53, 48.5], [-52.7, 47.6], [-53.1, 46.6], [-55.9, 46.9]], [[-57.1, 51.4], [-63.6, 52], [-66.5, 52.8], [-67, 54.2], [-67.5, 55], [-65.5, 56.2], [-64.4, 58.5], [-64.6, 60.3], [-62.8, 58.5], [-61.5, 56.5], [-59, 55], [-56, 53.5], [-55.7, 52]]] },
    YT: { n: 'Yukon', c: [-135.5, 63.5], p: [[[-141, 60], [-141, 69.6], [-136.5, 68.9], [-136, 67], [-132.5, 65.5], [-132.5, 64], [-129, 62], [-128, 61], [-124, 60]]] },
    NT: { n: 'Northwest Territories', c: [-118, 64], p: [[[-124, 60], [-102, 60], [-102, 64.2], [-109.4, 65.5], [-120.7, 67.8], [-120.7, 69.6], [-125, 69.4], [-129, 70], [-133, 69.6], [-136.5, 68.9], [-136, 67], [-132.5, 65.5], [-132.5, 64], [-129, 62], [-128, 61]]] },
    NU: { n: 'Nunavut', c: [-95, 65], p: [[[-102, 60], [-94.8, 60], [-93.3, 61.5], [-90.7, 63], [-88, 64], [-86.6, 66.5], [-89.5, 68.5], [-97, 68.6], [-108, 68], [-114, 68.5], [-120.7, 69.6], [-120.7, 67.8], [-109.4, 65.5], [-102, 64.2]],
      [[-64.9, 62.3], [-61.9, 66.7], [-68, 70.5], [-80.4, 73.6], [-86.5, 72.2], [-87, 70.3], [-81.6, 69.4], [-81.4, 67.2], [-84.3, 65.7], [-81.5, 64.3], [-76.9, 63.7], [-73, 63.3], [-71, 62.3], [-67, 62]],
      [[-118, 69], [-118, 71], [-111, 73], [-101, 72], [-101.5, 69.5], [-106, 68.5], [-114, 69]],
      [[-84, 63.5], [-80.5, 64], [-81, 65.5], [-86, 65.8], [-87, 64.5]]] },
  };
  const PNAMES = [['AB', /\balberta\b|\balta\b/], ['BC', /british columbia|\bb\.c\.?/], ['SK', /saskatchewan|\bsask\b/], ['MB', /manitoba/], ['ON', /ontario|\bont\b/], ['QC', /qu[eé]bec(?! city)|\bpq\b/],
    ['NB', /new brunswick/], ['NS', /nova scotia/], ['PE', /prince edward|\bpei\b/], ['NL', /newfoundland|labrador/], ['YT', /yukon/], ['NT', /northwest territories|\bnwt\b/], ['NU', /nunavut/]];
  // Major cities and towns: [name, lat, lng, province]
  const CITIES = (`Toronto,43.65,-79.38,ON;Ottawa,45.42,-75.70,ON;Mississauga,43.59,-79.64,ON;Brampton,43.73,-79.76,ON;Hamilton,43.26,-79.87,ON;London,42.98,-81.25,ON;Kitchener,43.45,-80.49,ON;Waterloo,43.46,-80.52,ON;Windsor,42.31,-83.04,ON;Oshawa,43.90,-78.86,ON;Barrie,44.39,-79.69,ON;Sudbury,46.49,-80.99,ON;Thunder Bay,48.38,-89.25,ON;Kingston,44.23,-76.49,ON;Guelph,43.55,-80.25,ON;St. Catharines,43.16,-79.24,ON;Niagara Falls,43.09,-79.08,ON;Markham,43.86,-79.34,ON;Vaughan,43.84,-79.50,ON;Richmond Hill,43.88,-79.44,ON;Burlington,43.33,-79.80,ON;Oakville,43.47,-79.69,ON;Peterborough,44.30,-78.32,ON;Sault Ste. Marie,46.52,-84.33,ON;North Bay,46.31,-79.46,ON;Timmins,48.48,-81.33,ON;Brantford,43.14,-80.26,ON;Sarnia,42.97,-82.40,ON;Scarborough,43.77,-79.26,ON;Etobicoke,43.65,-79.51,ON;Pickering,43.84,-79.09,ON;Ajax,43.85,-79.02,ON;Whitby,43.88,-78.94,ON;Cambridge,43.36,-80.31,ON;Milton,43.52,-79.88,ON;Newmarket,44.06,-79.46,ON;Belleville,44.16,-77.38,ON;Cornwall,45.02,-74.73,ON;`
    + `Montreal,45.50,-73.57,QC;Montréal,45.50,-73.57,QC;Quebec City,46.81,-71.21,QC;Laval,45.61,-73.71,QC;Gatineau,45.48,-75.70,QC;Longueuil,45.53,-73.52,QC;Sherbrooke,45.40,-71.89,QC;Trois-Rivières,46.34,-72.54,QC;Trois-Rivieres,46.34,-72.54,QC;Saguenay,48.43,-71.07,QC;Lévis,46.80,-71.18,QC;Levis,46.80,-71.18,QC;`
    + `Calgary,51.05,-114.07,AB;Edmonton,53.55,-113.49,AB;Red Deer,52.27,-113.81,AB;Lethbridge,49.69,-112.84,AB;Medicine Hat,50.04,-110.68,AB;Grande Prairie,55.17,-118.79,AB;Fort McMurray,56.73,-111.38,AB;Airdrie,51.29,-114.01,AB;St. Albert,53.63,-113.63,AB;St Albert,53.63,-113.63,AB;Spruce Grove,53.54,-113.91,AB;Leduc,53.26,-113.55,AB;Lloydminster,53.28,-110.0,AB;Okotoks,50.73,-113.98,AB;Cochrane,51.19,-114.47,AB;Camrose,53.02,-112.83,AB;Sherwood Park,53.54,-113.32,AB;Fort Saskatchewan,53.71,-113.21,AB;Lacombe,52.47,-113.73,AB;Brooks,50.56,-111.90,AB;Canmore,51.09,-115.36,AB;Cold Lake,54.46,-110.18,AB;Wetaskiwin,52.97,-113.37,AB;Stony Plain,53.53,-114.0,AB;Chestermere,51.05,-113.82,AB;Strathmore,51.04,-113.40,AB;High River,50.58,-113.87,AB;Sylvan Lake,52.31,-114.10,AB;Olds,51.79,-114.11,AB;Whitecourt,54.14,-115.68,AB;Hinton,53.40,-117.59,AB;Beaumont,53.36,-113.41,AB;Morinville,53.80,-113.65,AB;Drumheller,51.46,-112.71,AB;Taber,49.78,-112.15,AB;Hanna,51.64,-111.94,AB;Peace River,56.23,-117.29,AB;Slave Lake,55.28,-114.77,AB;Athabasca,54.72,-113.29,AB;Vegreville,53.49,-112.05,AB;Redcliff,50.08,-110.78,AB;Rocky View,51.2,-114.2,AB;Strathcona,53.5,-113.1,AB;Parkland County,53.55,-114.3,AB;Ponoka,52.68,-113.58,AB;Innisfail,52.03,-113.95,AB;Didsbury,51.66,-114.13,AB;Carstairs,51.56,-114.09,AB;Devon,53.36,-113.73,AB;Bonnyville,54.27,-110.74,AB;St. Paul,53.99,-111.29,AB;Edson,53.58,-116.44,AB;Grande Cache,53.89,-119.12,AB;Barrhead,54.12,-114.40,AB;Westlock,54.15,-113.86,AB;Rimbey,52.64,-114.24,AB;Wainwright,52.84,-110.86,AB;Vermilion,53.35,-110.85,AB;Pincher Creek,49.49,-113.95,AB;Claresholm,50.03,-113.58,AB;Raymond,49.46,-112.65,AB;Coaldale,49.72,-112.62,AB;Blackfalds,52.38,-113.80,AB;Penhold,52.13,-113.87,AB;Crossfield,51.43,-114.03,AB;Black Diamond,50.69,-114.23,AB;Turner Valley,50.67,-114.28,AB;Diamond Valley,50.69,-114.25,AB;Bruderheim,53.80,-112.93,AB;Gibbons,53.83,-113.33,AB;Sundre,51.80,-114.64,AB;Three Hills,51.70,-113.26,AB;Stettler,52.32,-112.71,AB;Forestburg,52.58,-112.07,AB;Vulcan,50.40,-113.25,AB;Nanton,50.35,-113.77,AB;Fort Macleod,49.72,-113.41,AB;Cardston,49.20,-113.30,AB;Bow Island,49.87,-111.37,AB;Oyen,51.35,-110.47,AB;Provost,52.35,-110.27,AB;Tofield,53.37,-112.67,AB;Millet,53.10,-113.47,AB;Calmar,53.26,-113.82,AB;Drayton Valley,53.22,-114.98,AB;Mayerthorpe,53.95,-115.13,AB;Valleyview,55.07,-117.28,AB;High Level,58.52,-117.14,AB;Lac La Biche,54.77,-111.96,AB;Smoky Lake,54.11,-112.47,AB;Two Hills,53.71,-111.75,AB;Wabamun,53.56,-114.47,AB;Onoway,53.70,-114.20,AB;Redwater,53.95,-113.11,AB;Lamont,53.76,-112.78,AB;Rocky Mountain House,52.38,-114.92,AB;Jasper,52.87,-118.08,AB;Banff,51.18,-115.57,AB;`
    + `Vancouver,49.28,-123.12,BC;Surrey,49.19,-122.85,BC;Burnaby,49.25,-122.98,BC;Richmond,49.17,-123.14,BC;Abbotsford,49.05,-122.31,BC;Coquitlam,49.28,-122.79,BC;Langley,49.10,-122.66,BC;Kelowna,49.89,-119.50,BC;Victoria,48.43,-123.37,BC;Nanaimo,49.17,-123.94,BC;Kamloops,50.67,-120.33,BC;Prince George,53.92,-122.75,BC;Chilliwack,49.16,-121.95,BC;Vernon,50.27,-119.27,BC;Penticton,49.49,-119.59,BC;Maple Ridge,49.22,-122.60,BC;New Westminster,49.21,-122.91,BC;North Vancouver,49.32,-123.07,BC;Fort St. John,56.25,-120.85,BC;Courtenay,49.69,-125.0,BC;Cranbrook,49.51,-115.77,BC;Prince Rupert,54.31,-130.32,BC;Dawson Creek,55.76,-120.24,BC;`
    + `Saskatoon,52.13,-106.67,SK;Regina,50.45,-104.61,SK;Prince Albert,53.20,-105.75,SK;Moose Jaw,50.39,-105.53,SK;Swift Current,50.29,-107.79,SK;Yorkton,51.21,-102.46,SK;North Battleford,52.76,-108.29,SK;Estevan,49.14,-102.99,SK;Weyburn,49.66,-103.85,SK;`
    + `Winnipeg,49.90,-97.14,MB;Brandon,49.85,-99.95,MB;Steinbach,49.53,-96.68,MB;Thompson,55.74,-97.86,MB;Portage la Prairie,49.97,-98.29,MB;Selkirk,50.14,-96.88,MB;`
    + `Halifax,44.65,-63.58,NS;Dartmouth,44.67,-63.57,NS;Sydney,46.14,-60.19,NS;Truro,45.37,-63.28,NS;Moncton,46.09,-64.78,NB;Saint John,45.27,-66.06,NB;Fredericton,45.96,-66.64,NB;Dieppe,46.10,-64.72,NB;Charlottetown,46.24,-63.13,PE;Summerside,46.39,-63.79,PE;St. John's,47.56,-52.71,NL;Mount Pearl,47.52,-52.81,NL;Corner Brook,48.95,-57.95,NL;Gander,48.95,-54.61,NL;Goose Bay,53.30,-60.33,NL;Whitehorse,60.72,-135.06,YT;Yellowknife,62.45,-114.37,NT;Iqaluit,63.75,-68.52,NU`)
    .split(';').map(r => { const [n, la, lo, p] = r.split(','); const k = fold(n); return { n, k, m: k.replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim(), lat: +la, lng: +lo, p }; });
  function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\bst\.?\s/g, 'st ').replace(/\s+/g, ' ').trim(); }
  const geoCache = new Map();
  function provOf(text) {
    const raw = String(text || ''), f = fold(raw);
    const code = /\b(AB|BC|SK|MB|ON|QC|NB|NS|PE|PEI|NL|YT|NT|NU)\b/.exec(raw);
    if (code) return code[1] === 'PEI' ? 'PE' : code[1];
    if (/^(ab|bc|sk|mb|on|qc|nb|ns|pe|nl|yt|nt|nu)$/i.test(raw.trim())) return raw.trim().toUpperCase();
    for (const [p, re] of PNAMES) if (re.test(f)) return p;
    return null;
  }
  // -> { lat, lng, p, exact } or null
  function geocode(text) {
    const t = String(text || '').trim(); if (!t) return null;
    if (geoCache.has(t)) return geoCache.get(t);
    const f = ' ' + fold(t).replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ') + ' ', prov = provOf(t);
    let hit = null, at = -1, len = 0;
    // the city named last wins ("123 Edmonton Trail, Calgary, AB" is in Calgary)
    for (const c of CITIES) { const i = f.lastIndexOf(' ' + c.m + ' '); if ((i > at || (i === at && i >= 0 && c.m.length > len)) && (!prov || prov === c.p)) { at = i; len = c.m.length; hit = { lat: c.lat, lng: c.lng, p: c.p, exact: true, city: c.n }; } }
    if (!hit && prov) { const P = PROV[prov]; hit = { lat: P.c[1], lng: P.c[0], p: prov, exact: false }; }
    geoCache.set(t, hit); return hit;
  }
  // a simple conic projection centred on Canada
  const proj = (lng, lat) => { const th = (lng + 96) * 0.8 * Math.PI / 180, r = (95 - lat) * 10; return [r * Math.sin(th), r * Math.cos(th)]; };
  const REGIONS = [['all', 'All of Canada', null], ['west', 'Western Canada', [-139, 48, -95, 60]], ['central', 'Ontario & Quebec', [-95.5, 41.5, -66, 52]], ['atlantic', 'Atlantic', [-68.5, 43.3, -52.5, 49.6]], ['ab', 'Alberta', [-120.2, 48.8, -109.8, 60.1]], ['south', 'Southern cities', [-125, 42, -63, 54.5]]];
  function viewBox(region) {
    const rg = REGIONS.find(r => r[0] === region); let pts = [];
    if (rg && rg[2]) { const [a, b2, c, d] = rg[2]; for (let x = a; x <= c; x += (c - a) / 6) for (let y = b2; y <= d; y += (d - b2) / 4) pts.push(proj(x, y)); }
    else Object.values(PROV).forEach(P => P.p.forEach(poly => poly.forEach(([x, y]) => pts.push(proj(x, y)))));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), pad = 8;
    return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2];
  }
  function mapSpec(b) {
    const c = cfg('map'), lc = locCols(b);
    const loc = colById(b, c.loc) || lc.find(x => /^location/.test(x.id)) || pick(lc, /address|city|location/i) || lc[0];
    const prov = lc.find(x => x !== loc && /province|region|state/i.test(x.title)) || lc.find(x => x !== loc);
    return { loc, prov };
  }
  const mapUpp = {};
  function renderMap(b) {
    const sp = mapSpec(b), c = cfg('map');
    if (!sp.loc) return `<div class="empty"><h3>Map needs a location</h3>Add a text column with an address, city or province (for example “Property Address” or “Province”). Items are placed by the Canadian city or province in it.</div>`;
    const placed = [], provCount = {}; let none = 0;
    for (const it of A.visibleItems()) {
      const v = it.values || {}; let g = geocode(v[sp.loc.id]);
      if ((!g || !g.exact) && sp.prov) { const g2 = geocode(v[sp.prov.id]); if (g2 && (!g || g2.exact)) g = g2; }
      if (!g) { none++; continue; }
      placed.push({ it, g }); provCount[g.p] = (provCount[g.p] || 0) + 1;
    }
    // scale = map units per on-screen pixel, measured after the map is drawn so markers keep their size on phones and zoomed regions
    const vb = viewBox(c.region || 'all'), scale = mapUpp[c.region || 'all'] || vb[2] / 900;
    pending.push(() => { const svg = document.querySelector('.vx-map svg'); if (!svg) return; const r = svg.getBoundingClientRect(); if (!r.width || !r.height) return;
      const u = Math.max(vb[2] / r.width, vb[3] / r.height), k = c.region || 'all'; if (Math.abs(u - scale) / scale > 0.05) { mapUpp[k] = u; A.renderContent(); } });
    const maxP = Math.max(1, ...Object.values(provCount));
    const shapes = Object.entries(PROV).map(([k, P]) => { const n = provCount[k] || 0, a = n ? 0.08 + 0.32 * (n / maxP) : 0.03;
      return `<path class="prov" d="${P.p.map(poly => 'M' + poly.map(([x, y]) => proj(x, y).map(z => z.toFixed(1)).join(' ')).join('L') + 'Z').join('')}" fill="rgba(57,135,229,${a.toFixed(3)})"><title>${esc(P.n)}: ${n} item${n === 1 ? '' : 's'}</title></path>`; }).join('');
    const labels = Object.entries(PROV).map(([k, P]) => { const [x, y] = proj(P.c[0], P.c[1] + (k === 'NL' ? 4.5 : 0)); return `<text class="plabel" x="${x.toFixed(1)}" y="${(y - 14 * scale).toFixed(1)}" text-anchor="middle" style="font-size:${(11 * scale).toFixed(2)}px">${k}</text>`; }).join('');
    // clusters: same spot first, then neighbours within a radius (in screen terms)
    const spots = new Map(); placed.forEach(p => { const k = p.g.lat + ',' + p.g.lng; (spots.get(k) || spots.set(k, { g: p.g, list: [] }).get(k)).list.push(p.it); });
    const R = 26 * scale, clusters = [];
    [...spots.values()].sort((a, b2) => b2.list.length - a.list.length).forEach(s => { const [x, y] = proj(s.g.lng, s.g.lat); const near = clusters.find(cl => Math.hypot(cl.x - x, cl.y - y) < R); if (near) { near.items.push(...s.list); near.places.add(s.g.city || PROV[s.g.p].n); } else clusters.push({ x, y, items: [...s.list], places: new Set([s.g.city || PROV[s.g.p].n]), key: s.g.lat + ',' + s.g.lng }); });
    const selC = clusters.find(cl => cl.key === c.sel);
    const dots = clusters.map(cl => { const n = cl.items.length, r = (7 + Math.min(18, Math.sqrt(n) * 2.4)) * scale;
      return `<g class="clu ${cl === selC ? 'sel' : ''}" data-vx="map-clu" data-k="${esc(cl.key)}" tabindex="0" role="button" aria-label="${esc([...cl.places].join(', '))}: ${n} items"><circle class="hit" cx="${cl.x.toFixed(1)}" cy="${cl.y.toFixed(1)}" r="${Math.max(r, 22 * scale).toFixed(1)}"/><circle cx="${cl.x.toFixed(1)}" cy="${cl.y.toFixed(1)}" r="${r.toFixed(1)}"/><text x="${cl.x.toFixed(1)}" y="${(cl.y + 4 * scale).toFixed(1)}" text-anchor="middle" style="font-size:${(11 * scale).toFixed(2)}px">${n}</text><title>${esc([...cl.places].slice(0, 6).join(', '))}: ${n}</title></g>`; }).join('');
    const top = Object.entries(provCount).sort((a, b2) => b2[1] - a[1]);
    const side = selC ? `<h4>${esc([...selC.places].slice(0, 3).join(', '))}${selC.places.size > 3 ? ' and more' : ''}</h4><span class="vx-note">${selC.items.length} item${selC.items.length === 1 ? '' : 's'}</span>${selC.items.slice(0, 150).map(it => itemCard(b, it, [sp.loc])).join('')}`
      : `<h4>By province</h4><span class="vx-note">${placed.length} placed${none ? ` · ${none} without a place we recognise` : ''}. Click a circle to list its items.</span>${top.map(([k, n]) => `<div class="ov-rows"><span><span>${esc(PROV[k].n)}</span><b>${n}</b></span></div>`).join('')}`;
    return `<div class="vx-map"><div class="vx-panel" style="padding:10px"><svg viewBox="${vb.map(x => x.toFixed(1)).join(' ')}" role="img" aria-label="Map of Canada with items">${shapes}${labels}${dots}</svg></div><div class="vx-panel vx-side">${side}</div></div>`;
  }

  // ---------- Files ----------
  const extOf = n => { const m = /\.([a-z0-9]{1,5})(?:$|\?)/i.exec(String(n || '')); return m ? m[1].toLowerCase() : ''; };
  const KIND = e => /^(png|jpe?g|gif|webp|heic|svg)$/.test(e) ? 'image' : e === 'pdf' ? 'pdf' : /^(docx?|xlsx?|csv|txt|pptx?|rtf|odt)$/.test(e) ? 'doc' : 'other';
  // only web links and our own uploads become links (never javascript: or data:)
  const SAFE = u => { const x = String(u || '').trim(); return /^https?:\/\/\S+$/i.test(x) || /^\/api\/files\/\S*$/.test(x) ? x : ''; };
  function collectFiles(b, items) {
    const out = [];
    for (const it of items) {
      for (const c of b.columns) if (A.isFileCol(c)) A.fileList((it.values || {})[c.id]).forEach(f => out.push({ name: f.name || f.url, url: f.url, it, src: c.title, at: '' }));
      (it.updates || []).forEach(u => (u.files || []).forEach(f => out.push({ name: f.name || f.url, url: SAFE(f.url), it, src: 'Update', at: u.at, by: u.byName })));
    }
    return out;
  }
  function renderFiles(b) {
    const c = cfg('files'), all = collectFiles(b, A.visibleItems());
    const srcs = [...new Set(all.map(f => f.src))];
    const html = `<div class="vx-bar"><input class="search" id="vx-fq" type="search" placeholder="Find a file or item" value="${esc(c.q || '')}" aria-label="Find a file or item">
      ${sel('group', [['', 'All groups'], ...b.groups.map(g => [g.id, g.name])], c.group || '', 'Group')}
      ${sel('src', [['', 'From anywhere'], ...srcs.map(s => [s, s === 'Update' ? 'Update attachments' : 'Column: ' + s])], c.src || '', 'Where the file is')}
      ${sel('kind', [['', 'All types'], ['image', 'Images'], ['pdf', 'PDFs'], ['doc', 'Documents'], ['other', 'Other']], c.kind || '', 'File type')}
      <span class="vx-note" id="vx-fcount"></span></div><div class="vx-files" id="vx-fgrid"></div>`;
    pending.push(() => fillFiles(b, all));
    return html;
  }
  function fillFiles(b, all) {
    const el = $('#vx-fgrid'); if (!el) return;
    const c = cfg('files'), q = String(c.q || '').toLowerCase();
    const list = all.filter(f => (!c.group || f.it.group === c.group) && (!c.src || f.src === c.src) && (!c.kind || KIND(extOf(f.name) || extOf(f.url)) === c.kind) && (!q || f.name.toLowerCase().includes(q) || String(f.it.name).toLowerCase().includes(q)));
    $('#vx-fcount').textContent = `${list.length} of ${all.length} file${all.length === 1 ? '' : 's'}`;
    el.innerHTML = list.slice(0, 400).map(f => {
      const e = extOf(f.name) || extOf(f.url), k = KIND(e), local = String(f.url).startsWith('/api/files/'), safe = /^(png|jpe?g|gif|webp|pdf|txt)$/.test(e);
      const open = local && safe ? f.url + '?inline=1' : f.url, g = b.groups.find(x => x.id === f.it.group);
      const thumb = local && k === 'image' && safe ? `<img src="${esc(f.url)}?inline=1" alt="" loading="lazy">` : `<span class="vx-ext">${esc((e || 'file').toUpperCase())}</span>`;
      return `<div class="vx-file glass"><div class="vx-thumb">${thumb}</div><div class="vx-fmeta"><b title="${esc(f.name)}">${esc(f.name)}</b>
        <span class="vx-note" title="${esc(f.it.name)}">${esc(f.it.name)}${g ? ' · ' + esc(g.name) : ''}</span><span class="vx-note">${f.src === 'Update' ? 'Update' + (f.by ? ' by ' + esc(f.by) : '') : esc(f.src)}${f.at ? ' · ' + esc(new Date(f.at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })) : ''}</span>
        <div class="vx-fact">${f.url ? `<a class="btn" href="${esc(open)}" target="_blank" rel="noopener">Open</a><a class="btn" href="${esc(f.url)}" ${local ? 'download' : 'target="_blank" rel="noopener"'}>Download</a>` : ''}<button class="btn" data-act="open" data-item="${esc(f.it.id)}">Item</button></div></div></div>`;
    }).join('') || `<div class="empty" style="grid-column:1/-1"><h3>No files${all.length ? ' match' : ' yet'}</h3>${all.length ? 'Try another filter.' : 'Files added to file columns and attached to updates show up here.'}</div>`;
  }

  // ---------- board view entry ----------
  const pending = [];
  const flush = () => { while (pending.length) { try { pending.shift()(); } catch (e) { console.error(e); } } };
  function render(b) {
    pending.length = 0;
    const t = A.S.view;
    const html = t === 'timeline' ? renderTimeline(b) : t === 'workload' ? renderWorkload(b) : t === 'chart' ? renderChart(b) : t === 'map' ? renderMap(b) : renderFiles(b);
    queueMicrotask(flush);
    return html;
  }

  // ================= Dashboards =================
  const D = { list: null, cur: null, err: '', cache: {}, modal: null, confirm: null, loading: false };
  try { D.cur = localStorage.getItem('ks-dash') || null; } catch (e) {}
  const WT = [['number', 'Number'], ['chart', 'Chart'], ['table', 'Table of items'], ['battery', 'Progress by status'], ['leaderboard', 'Leaderboard by person']];
  async function loadDashes() {
    if (D.loading) return; D.loading = true;
    try { D.list = await KS.api('GET', '/api/dashboards'); D.err = ''; } catch (e) { D.list = D.list || []; D.err = e.message || 'Couldn’t load dashboards.'; }
    D.loading = false;
    if (!D.list.some(d => d.id === D.cur)) D.cur = (D.list[0] || {}).id || null;
    if (A.S.page === 'dash') A.renderContent();
  }
  const curDash = () => (D.list || []).find(d => d.id === D.cur);
  const mine = d => d && (d.owner === A.S.uid || A.S.isOwner);
  async function saveDash(d) {
    try { const r = await KS.api('PUT', '/api/dashboards/' + d.id, { name: d.name, shared: d.shared, widgets: d.widgets }); const i = D.list.findIndex(x => x.id === d.id); if (i >= 0) D.list[i] = r; else D.list.push(r); }
    catch (e) { A.toast(e.message || 'That didn’t save.'); }
    A.renderContent();
  }
  // items of a board the viewer can see (the server refuses boards that aren't shared with them)
  async function boardItems(bid) {
    const hit = D.cache[bid]; if (hit && (hit.items || hit.err) && Date.now() - hit.at < 60000) return hit;
    if (hit && hit.p) return hit.p;
    const p = KS.api('GET', '/api/col?path=' + encodeURIComponent('boards/' + bid + '/items')).then(rows => ({ at: Date.now(), items: rows.map(r => ({ id: r.id, ...r.data })) })).catch(e => ({ at: Date.now(), err: e.message || 'not available' }));
    D.cache[bid] = { at: Date.now(), p };
    const r = await p; D.cache[bid] = r; return r;
  }
  function widgetRows(w) {
    const out = { rows: [], hidden: 0, loading: false, boards: [] };
    for (const bid of w.boards || []) {
      const b = A.S.boards.find(x => x.id === bid);
      if (!b) { out.hidden++; continue; }
      const hit = D.cache[bid];
      if (!hit || hit.p) { out.loading = true; boardItems(bid).then(() => mountWidgets()); continue; }
      if (hit.err) { out.hidden++; continue; }
      out.boards.push(b);
      const fc = w.filter && w.filter.col ? findCol(b, w.filter.col, ['status']) : null;
      for (const item of hit.items) {
        if (fc) { const l = A.labelOf(fc, (item.values || {})[fc.id]); if (!(w.filter.labels || []).map(x => x.toLowerCase()).includes(String(l ? l.label : '').toLowerCase())) continue; }
        else if (w.filter && w.filter.col) continue;
        out.rows.push({ b, item });
      }
    }
    return out;
  }
  // the boards a widget uses, in the order they were picked (the first one decides default columns)
  const selBoards = w => (w.boards || []).map(id => A.S.boards.find(b => b.id === id)).filter(Boolean);
  function colTitles(boards, types) { const m = new Map(); boards.forEach(b => b.columns.filter(c => types.includes(c.type)).forEach(c => { const k = c.title.toLowerCase(); if (!m.has(k)) m.set(k, { title: c.title, n: 0 }); m.get(k).n++; })); return [...m.values()].sort((a, b) => b.n - a.n); }
  function widgetBody(w, W) {
    const R = widgetRows(w);
    if (R.loading) return '<p class="vx-note">Loading…</p>';
    const note = R.hidden ? `<p class="vx-note">${R.hidden} board${R.hidden === 1 ? ' isn’t' : 's aren’t'} shared with you, so ${R.hidden === 1 ? 'it’s' : 'they’re'} left out.</p>` : '';
    if (!R.boards.length) return note || '<p class="vx-note">Pick at least one board.</p>';
    const mc = w.measure && w.measure.kind === 'sum' ? R.boards.map(b => findCol(b, w.measure.col, ['number', 'formula'])).find(Boolean) : null;
    const f = mc ? v => fmtVal(mc, v) : fmtN;
    const measure = mc ? { kind: 'sum', col: w.measure.col } : { kind: 'count' };
    if (w.type === 'number') { const agg = aggregate(R.rows, { kind: 'all' }, measure); return `<div class="vx-big">${esc(f(agg.total))}</div><span class="vx-note">${mc ? 'Sum of ' + esc(mc.title) + ' · ' : ''}${R.rows.length.toLocaleString('en-CA')} item${R.rows.length === 1 ? '' : 's'} on ${R.boards.length} board${R.boards.length === 1 ? '' : 's'}</span>${note}`; }
    if (w.type === 'chart') { const by = w.by || { kind: 'group' }; const agg = aggregate(R.rows, by, measure, w.chart === 'stacked' ? (w.stack || { kind: 'group' }) : null); return chartSvg(agg, w.chart || 'bar', W, f, { timeAxis: by.kind === 'date', mono: by.kind === 'date', height: 200 }) + note; }
    if (w.type === 'battery') {
      const agg = aggregate(R.rows, { kind: 'status', col: w.statusCol }, { kind: 'count' }); const tot = agg.total || 1;
      const done = agg.cats.filter(c => /done|funded|closed|complete|won|paid|signed|approved/i.test(c.label)).reduce((s, c) => s + c.value, 0);
      return `<div style="display:flex;align-items:baseline;gap:10px"><div class="vx-big" style="font-size:38px">${Math.round(done / tot * 100)}%</div><span class="vx-note">done (${esc(fmtN(done))} of ${esc(fmtN(agg.total))})</span></div>
        <div class="vx-batt">${agg.cats.map(c => `<span style="width:${(c.value / tot * 100).toFixed(2)}%;background:${esc(c.color)}" title="${esc(c.label)}: ${c.value}"></span>`).join('')}</div>
        <div class="vx-legend">${agg.cats.map(c => `<span><i style="background:${esc(c.color)}"></i>${esc(trunc(c.label, 22))} <span class="vx-note">${Math.round(c.value / tot * 100)}%</span></span>`).join('')}</div>${note}`;
    }
    if (w.type === 'leaderboard') {
      const agg = aggregate(R.rows, { kind: 'person', col: w.personCol }, measure); const list = agg.cats.filter(c => c.key !== '∅' && c.key !== '__other').slice(0, 10), max = Math.max(1, ...list.map(c => c.value));
      return `<div class="vx-lb">${list.map((c, i) => `<div class="vx-lbr"><span class="rank">${i + 1}</span><span class="av" style="background:${A.hue(c.label)};margin:0">${esc(A.initials(c.label))}</span><span class="nm">${esc(c.label)}</span><b style="font-family:var(--f-data);font-weight:500">${esc(f(c.value))}</b><span></span><span></span><span class="track"><span style="width:${(c.value / max * 100).toFixed(1)}%"></span></span></div>`).join('') || '<p class="vx-note">No one is assigned yet.</p>'}</div>${note}`;
    }
    if (w.type === 'table') {
      const dateT = w.sortCol; const sorted = R.rows.slice().sort((x, y) => { const k = r => { const c = dateT && findCol(r.b, dateT, ['date']); return String((c ? (r.item.values || {})[c.id] : r.item.createdAt) || ''); }; return k(y).localeCompare(k(x)); }).slice(0, Number(w.limit) || 25);
      return `<div class="vx-scroll"><table class="vx-tbl"><thead><tr><th>Item</th>${R.boards.length > 1 ? '<th>Board</th>' : ''}${w.statusCol ? `<th>${esc(w.statusCol)}</th>` : ''}${w.personCol ? `<th>${esc(w.personCol)}</th>` : ''}<th>${esc(dateT || 'Created')}</th></tr></thead><tbody>${sorted.map(({ b, item }) => {
        const sc = w.statusCol && findCol(b, w.statusCol, ['status']), l = sc && A.labelOf(sc, (item.values || {})[sc.id]), pc = w.personCol && findCol(b, w.personCol, ['person']), dc = dateT && findCol(b, dateT, ['date']);
        return `<tr data-open="${esc(b.id)}|${esc(item.id)}"><td title="${esc(item.name)}">${esc(item.name)}</td>${R.boards.length > 1 ? `<td>${esc(b.name)}</td>` : ''}${w.statusCol ? `<td>${l ? `<span class="pill" style="--c:${esc(l.color)}">${esc(l.label)}</span>` : ''}</td>` : ''}${w.personCol ? `<td>${esc(pc ? (item.values || {})[pc.id] || '' : '')}</td>` : ''}<td style="font-family:var(--f-data)">${esc(dc ? (item.values || {})[dc.id] || '' : String(item.createdAt || '').slice(0, 10))}</td></tr>`; }).join('')}</tbody></table></div>
        <span class="vx-note">${Math.min(sorted.length, R.rows.length)} of ${R.rows.length.toLocaleString('en-CA')} items, newest first</span>${note}`;
    }
    return '';
  }
  function mountWidgets() {
    if (A.S.page !== 'dash') return;
    const d = curDash(); if (!d) return;
    document.querySelectorAll('[data-wbody]').forEach(el => { const w = d.widgets.find(x => x.id === el.dataset.wbody); if (w) el.innerHTML = widgetBody(w, Math.max(240, el.clientWidth)); });
  }
  function renderDash() {
    if (!D.list) { loadDashes(); return '<div class="vx-dash"><h1>Dashboards</h1><p class="vx-note">Loading…</p></div>'; }
    if (A.S.isGuest) return '<div class="vx-dash"><h1>Dashboards</h1><p class="vx-note">Dashboards aren’t available to guests.</p></div>';
    const d = curDash(), own = mine(d);
    const chips = D.list.map(x => `<button class="tab" data-vx="dash-pick" data-id="${esc(x.id)}" aria-pressed="${x.id === D.cur}">${esc(x.name)}${x.shared ? ' · shared' : ''}</button>`).join('');
    const top = `<div class="home-top"><div><p class="eyebrow">Numbers across your boards</p><h1>Dashboards</h1></div></div>
      <div class="vx-dtabs">${chips ? `<div class="tabs" style="flex-wrap:wrap">${chips}</div>` : ''}<button class="btn primary" data-vx="dash-new">+ New dashboard</button></div>${D.err ? `<p class="vx-note">${esc(D.err)}</p>` : ''}`;
    if (!d) return `<div class="vx-dash">${top}<div class="empty"><h3>No dashboards yet</h3>Make one, then add numbers, charts, tables, progress bars and leaderboards from any boards you can see.</div></div>`;
    pending.length = 0; pending.push(mountWidgets); queueMicrotask(flush);
    const tools = own ? `<input class="search" data-vx-dname value="${esc(d.name)}" aria-label="Dashboard name" style="width:220px;font-weight:600">
      <button class="toggle" data-vx="dash-share" aria-pressed="${!!d.shared}" title="Shared dashboards are visible to the whole team; each person only sees numbers from boards they can open">${d.shared ? 'Shared with the team' : 'Only me'}</button>
      <button class="btn primary" data-vx="w-add">+ Add widget</button><button class="btn" data-vx="dash-refresh">Refresh</button><span class="spacer"></span>
      <button class="btn danger" data-vx="dash-del">${D.confirm === 'd:' + d.id ? 'Click again to delete' : 'Delete dashboard'}</button>`
      : `<b>${esc(d.name)}</b><span class="vx-note">by ${esc(d.ownerName || 'a teammate')} · shared</span><button class="btn" data-vx="dash-refresh">Refresh</button>`;
    const ws = (d.widgets || []).map((w, i) => `<section class="vx-w glass ${w.size === 'wide' ? 'wide' : ''}" aria-label="${esc(w.title || 'Widget')}"><div class="vx-wh"><h3 title="${esc(w.title)}">${esc(w.title || WT.find(t => t[0] === w.type)[1])}</h3>
        ${own ? `<button class="icon-btn vx-wmove" data-vx="w-move" data-i="${i}" data-d="-1" aria-label="Move earlier" title="Move earlier" ${i === 0 ? 'disabled' : ''}>‹</button><button class="icon-btn vx-wmove" data-vx="w-move" data-i="${i}" data-d="1" aria-label="Move later" title="Move later" ${i === (d.widgets || []).length - 1 ? 'disabled' : ''}>›</button><button class="icon-btn" data-vx="w-edit" data-i="${i}">Edit</button><button class="icon-btn" data-vx="w-del" data-i="${i}">${D.confirm === 'w:' + w.id ? 'Sure?' : 'Remove'}</button>` : ''}</div>
        <div class="vx-chart" data-wbody="${esc(w.id)}"><p class="vx-note">Loading…</p></div>
        <span class="vx-note">${esc((w.boards || []).map(id => (A.S.boards.find(x => x.id === id) || {}).name).filter(Boolean).slice(0, 3).join(', '))}${(w.boards || []).length > 3 ? ' and more' : ''}</span></section>`).join('');
    return `<div class="vx-dash">${top}<div class="form-row">${tools}</div>
      <div class="vx-grid">${ws || `<div class="empty" style="grid-column:1/-1"><h3>Empty dashboard</h3>${own ? 'Press “+ Add widget” to add a number, chart, table, progress bar or leaderboard.' : 'Nothing here yet.'}</div>`}</div></div>`;
  }
  // ---- widget editor (own overlay so the page's re-renders don't close it) ----
  const layer = document.createElement('div'); layer.id = 'vx-layer'; document.body.appendChild(layer);
  function renderModal() {
    const m = D.modal; if (!m) { const had = layer.contains(document.activeElement) || document.activeElement === document.body; layer.innerHTML = ''; const r = D.ret; D.ret = null; if (had && r) setTimeout(() => { const el = document.querySelector(r) || document.querySelector('[data-vx="w-add"]'); if (el) el.focus(); }); return; } // focus goes back to the button that opened it
    const w = m.w, boards = selBoards(w);
    const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
    const colSel = (k, types, cur, none) => `<select class="field-input" data-wf="${k}">${none ? opt('', none, cur) : ''}${colTitles(boards, types).map(c => opt(c.title, c.title + (c.n < boards.length ? ` (${c.n} of ${boards.length} boards)` : ''), cur)).join('')}</select>`;
    const measure = `<div class="form-row"><label>Measure</label><select class="field-input" data-wf="measure">${opt('count', 'Count items', w.measure && w.measure.kind === 'sum' ? 'x' : 'count')}${colTitles(boards, ['number', 'formula']).map(c => opt('sum:' + c.title, 'Sum of ' + c.title, w.measure && w.measure.kind === 'sum' ? 'sum:' + w.measure.col : '')).join('')}</select></div>`;
    const byVal = w.by ? (w.by.kind === 'group' ? 'group' : w.by.kind + ':' + (w.by.col || '') + (w.by.unit ? ':' + w.by.unit : '')) : 'group';
    const byOpts = [...colTitles(boards, ['status']).map(c => ['status:' + c.title, 'By ' + c.title]), ['group', 'By group'], ...colTitles(boards, ['person']).map(c => ['person:' + c.title, 'By ' + c.title]),
      ...colTitles(boards, ['date']).flatMap(c => [['date:' + c.title + ':month', `By ${c.title} (month)`], ['date:' + c.title + ':week', `By ${c.title} (week)`]]), ['date:__created:month', 'By created (month)']];
    const flabels = w.filter && w.filter.col ? [...new Set(boards.flatMap(b => { const c = findCol(b, w.filter.col, ['status']); return c ? (c.labels || []).map(l => l.label) : []; }))] : [];
    const q = (m.q || '').toLowerCase();
    const fa = layer.contains(document.activeElement) ? document.activeElement : null, fsel = fa && fa.dataset && fa.dataset.wf ? `[data-wf="${fa.dataset.wf}"]${fa.value && fa.type === 'checkbox' ? `[value="${window.CSS.escape(fa.value)}"]` : ''}` : '';
    queueMicrotask(() => { if (!D.modal || layer.contains(document.activeElement)) return; const el = (fsel && layer.querySelector(fsel)) || layer.querySelector('.modal select, .modal input'); if (el) el.focus(); });
    layer.innerHTML = `<div class="modal-wrap" data-vx="m-close-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Widget">
      <h3>${m.i == null ? 'Add a widget' : 'Edit widget'}</h3>
      <div class="vx-wf">
        <div class="form-row"><label>Type</label><select class="field-input" data-wf="type">${WT.map(([v, l]) => opt(v, l, w.type)).join('')}</select><label>Title</label><input class="field-input" data-wf="title" value="${esc(w.title || '')}" placeholder="e.g. Funded this month" style="flex:1 1 180px"></div>
        <div><div class="form-row" style="margin-bottom:6px"><label>Boards (${(w.boards || []).length})</label><input class="field-input" data-wf-q value="${esc(m.q || '')}" placeholder="Find a board" style="flex:1 1 160px"></div>
          <div class="vx-boards">${A.S.boards.filter(b => !q || b.name.toLowerCase().includes(q) || (w.boards || []).includes(b.id)).map(b => `<label class="pop-check" style="padding:3px 8px"><input type="checkbox" data-wf="board" value="${esc(b.id)}" ${(w.boards || []).includes(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`).join('')}</div>
          <p class="vx-note" style="margin-top:6px">Everyone who opens this dashboard only sees numbers from the boards they’re allowed to see.</p></div>
        ${boards.length ? `
        ${['number', 'chart', 'leaderboard'].includes(w.type) ? measure : ''}
        ${w.type === 'chart' ? `<div class="form-row"><label>Chart</label><select class="field-input" data-wf="chart">${[['bar', 'Bar'], ['stacked', 'Stacked bar'], ['pie', 'Pie'], ['line', 'Line']].map(([v, l]) => opt(v, l, w.chart || 'bar')).join('')}</select>
          <select class="field-input" data-wf="by">${byOpts.map(([v, l]) => opt(v, l, byVal)).join('')}</select>
          ${w.chart === 'stacked' ? `<select class="field-input" data-wf="stack">${opt('group', 'Stack by group', w.stack && w.stack.kind === 'status' ? 'x' : 'group')}${colTitles(boards, ['status']).map(c => opt('status:' + c.title, 'Stack by ' + c.title, w.stack && w.stack.kind === 'status' ? 'status:' + w.stack.col : '')).join('')}</select>` : ''}</div>` : ''}
        ${w.type === 'battery' || w.type === 'table' ? `<div class="form-row"><label>Status column</label>${colSel('statusCol', ['status'], w.statusCol, w.type === 'table' ? 'None' : '')}</div>` : ''}
        ${w.type === 'leaderboard' || w.type === 'table' ? `<div class="form-row"><label>Person column</label>${colSel('personCol', ['person'], w.personCol, w.type === 'table' ? 'None' : '')}</div>` : ''}
        ${w.type === 'table' ? `<div class="form-row"><label>Newest by</label>${colSel('sortCol', ['date'], w.sortCol, 'Created date')}<label>Rows</label><select class="field-input" data-wf="limit">${[10, 25, 50, 100].map(n => opt(n, n, w.limit || 25)).join('')}</select></div>` : ''}
        <div class="form-row"><label>Only items where</label>${colSel('fcol', ['status'], w.filter && w.filter.col, 'Every item (no filter)')}</div>
        ${flabels.length ? `<div class="form-row">${flabels.map(l => `<label class="pop-check" style="padding:2px 6px"><input type="checkbox" data-wf="flabel" value="${esc(l)}" ${(w.filter.labels || []).includes(l) ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>` : ''}
        <div class="form-row"><label>Size</label><select class="field-input" data-wf="size">${opt('normal', 'Normal', w.size || 'normal')}${opt('wide', 'Wide', w.size)}</select></div>` : ''}
      </div>
      <div class="form-row"><button class="btn primary" data-vx="w-save">${m.i == null ? 'Add widget' : 'Save widget'}</button><button class="btn" data-vx="m-close">Cancel</button></div>
    </div></div>`;
  }
  function readWf(t) {
    const w = D.modal.w, f = t.dataset.wf, v = t.value;
    if (f === 'type') { w.type = v; if (WT.some(x => x[1] === w.title)) w.title = ''; }
    else if (f === 'title') w.title = v;
    else if (f === 'board') { const s = new Set(w.boards || []); t.checked ? s.add(v) : s.delete(v); w.boards = [...s]; }
    else if (f === 'measure') w.measure = v === 'count' ? { kind: 'count' } : { kind: 'sum', col: v.slice(4) };
    else if (f === 'chart') w.chart = v;
    else if (f === 'by') { const [kind, col, unit] = v.split(':'); w.by = kind === 'group' ? { kind } : { kind, col, unit }; }
    else if (f === 'stack') { w.stack = v === 'group' ? { kind: 'group' } : { kind: 'status', col: v.slice(7) }; }
    else if (f === 'fcol') w.filter = v ? { col: v, labels: [] } : null;
    else if (f === 'flabel') { const s = new Set(w.filter.labels || []); t.checked ? s.add(v) : s.delete(v); w.filter.labels = [...s]; }
    else if (f === 'limit') w.limit = Number(v);
    else w[f] = v;
  }
  function defaults(w) {
    const boards = selBoards(w);
    const first = types => (colTitles(boards, types)[0] || {}).title;
    if (w.type === 'chart' && !w.by) { const s = first(['status']); w.by = s ? { kind: 'status', col: s } : { kind: 'group' }; }
    if ((w.type === 'battery') && !w.statusCol) w.statusCol = first(['status']);
    if (w.type === 'leaderboard' && !w.personCol) w.personCol = first(['person']);
    if (!w.title) w.title = (WT.find(t => t[0] === w.type) || [, 'Widget'])[1];
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    if (!A) return;
    const t = e.target.closest('[data-vx], [data-open], [data-vxcat], [data-act="go-dash"]'); if (!t) return;
    if (t.dataset.act === 'go-dash') { A.S.page = 'dash'; A.S.modal = null; A.S.openItem = null; A.savePage(); D.list = null; D.cache = {}; A.render(); return; }
    if (t.dataset.open) { const [bid, iid] = t.dataset.open.split('|'); if (window.SolverOpen) window.SolverOpen(bid, iid); return; }
    if (t.dataset.vxcat !== undefined && t.closest('#vx-chart')) { const c = cfg('chart'); setCfg('chart', { sel: c.sel === t.dataset.vxcat ? '' : t.dataset.vxcat }); return; }
    const a = t.dataset.vx, b = A.board();
    switch (a) {
      case 'set': setCfg(A.S.view, { [t.dataset.k]: t.dataset.v }); break;
      case 'tl-nav': { const c = cfg('timeline'), z = ZOOM[c.zoom || 'week'], d = Number(t.dataset.d); tlJump = true; setCfg('timeline', { off: d === 0 ? 0 : (c.off || 0) + d * Math.round(z.days / 2) }); break; }
      case 'tl-more': { const c = cfg('timeline'); setCfg('timeline', { lim: { ...(c.lim || {}), [t.dataset.g]: ((c.lim || {})[t.dataset.g] || 60) + 60 } }); break; }
      case 'wl-nav': { const c = cfg('workload'), d = Number(t.dataset.d); setCfg('workload', { off: d === 0 ? 0 : (c.off || 0) + d * (wlSpec(b).weeks), sel: '' }); break; }
      case 'wl-cell': { const c = cfg('workload'); setCfg('workload', { sel: c.sel === t.dataset.k ? '' : t.dataset.k }); break; }
      case 'map-clu': { const c = cfg('map'); setCfg('map', { sel: c.sel === t.dataset.k ? '' : t.dataset.k }); const k = t.dataset.k; if (e.detail === 0) setTimeout(() => { const g = [...document.querySelectorAll('.vx-map .clu')].find(x => x.dataset.k === k); if (g) g.focus(); }); break; }
      case 'update-view': { const v = savedView(); if (!v || !b) return; const views = (b.views || []).map(x => x.id === v.id ? { ...x, settings: stripLocal(cfg(A.S.view)) } : x); A.patchBoard({ views }); A.localBoard({ views }); A.toast(`Updated view “${v.name}”`); break; }
      // dashboards
      case 'dash-pick': D.cur = t.dataset.id; try { localStorage.setItem('ks-dash', D.cur); } catch (x) {} D.confirm = null; A.renderContent(); break;
      case 'dash-new': { const d = { id: 'd' + Math.random().toString(36).slice(2, 12), name: 'New dashboard', shared: false, widgets: [] }; D.list.push({ ...d, owner: A.S.uid }); D.cur = d.id; try { localStorage.setItem('ks-dash', d.id); } catch (x) {} saveDash(d); setTimeout(() => { const el = document.querySelector('[data-vx-dname]'); if (el) { el.focus(); el.select(); } }, 60); break; }
      case 'dash-share': { const d = curDash(); if (!d) return; d.shared = !d.shared; saveDash(d); A.toast(d.shared ? 'Shared with the team. Each person sees only the boards they can open.' : 'Only you see this dashboard now.'); break; }
      case 'dash-refresh': D.cache = {}; A.renderContent(); break;
      case 'dash-del': { const d = curDash(); if (!d) return; if (D.confirm !== 'd:' + d.id) { D.confirm = 'd:' + d.id; A.renderContent(); return; } D.confirm = null; KS.api('DELETE', '/api/dashboards/' + d.id).then(() => { D.list = D.list.filter(x => x.id !== d.id); D.cur = (D.list[0] || {}).id || null; A.renderContent(); }).catch(err => A.toast(err.message)); break; }
      case 'w-add': D.ret = '[data-vx="w-add"]'; D.modal = { i: null, w: { id: 'w' + Math.random().toString(36).slice(2, 10), type: 'number', boards: A.S.boardId && A.S.boards.some(x => x.id === A.S.boardId) ? [A.S.boardId] : [], measure: { kind: 'count' } } }; renderModal(); break;
      case 'w-edit': { const d = curDash(); const w = d && d.widgets[Number(t.dataset.i)]; if (!w) return; D.ret = `[data-vx="w-edit"][data-i="${Number(t.dataset.i)}"]`; D.modal = { i: Number(t.dataset.i), w: JSON.parse(JSON.stringify(w)) }; renderModal(); break; }
      case 'w-del': { const d = curDash(); const w = d && d.widgets[Number(t.dataset.i)]; if (!w) return; if (D.confirm !== 'w:' + w.id) { D.confirm = 'w:' + w.id; A.renderContent(); return; } D.confirm = null; d.widgets.splice(Number(t.dataset.i), 1); saveDash(d); break; }
      case 'w-move': { const d = curDash(), i = Number(t.dataset.i), j = i + Number(t.dataset.d); if (!d || j < 0 || j >= d.widgets.length) return; [d.widgets[i], d.widgets[j]] = [d.widgets[j], d.widgets[i]]; saveDash(d); break; }
      case 'w-save': { const d = curDash(), m = D.modal; if (!d || !m) return; if (!(m.w.boards || []).length) { A.toast('Pick at least one board.'); return; } defaults(m.w); if (m.i == null) d.widgets.push(m.w); else d.widgets[m.i] = m.w; D.modal = null; renderModal(); saveDash(d); break; }
      case 'm-close': D.modal = null; renderModal(); break;
      case 'm-close-bg': if (e.target === t) { D.modal = null; renderModal(); } break;
    }
  });
  document.addEventListener('change', e => {
    if (!A) return; const t = e.target;
    if (t.dataset && t.dataset.vxset !== undefined) { const k = t.dataset.vxset, v = t.value; const patch = { [k]: k === 'cap' ? (v.trim() === '' ? '' : Number(String(v).replace(/[^0-9.]/g, '')) || '') : v }; if (A.S.view === 'files') { Object.assign(cfg('files'), patch); A.renderContent(); return; } setCfg(A.S.view, patch); return; }
    if (t.dataset && t.dataset.wf !== undefined && D.modal) { readWf(t); if (t.dataset.wf !== 'title') { defaults(D.modal.w); renderModal(); } return; }
    if (t.matches && t.matches('[data-vx-dname]')) { const d = curDash(); const v = t.value.trim(); if (d && v && v !== d.name) { d.name = v; saveDash(d); } else if (d && !v) { t.value = d.name; A.toast('A dashboard needs a name.'); } }
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'vx-fq') { cfg('files').q = t.value; const b = A.board(); if (b) fillFiles(b, collectFiles(b, A.visibleItems())); }
    if (t.matches && t.matches('[data-wf-q]') && D.modal) { D.modal.q = t.value; const pos = t.selectionStart; renderModal(); const el = layer.querySelector('[data-wf-q]'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
    if (t.matches && t.matches('[data-wf="title"]') && D.modal) D.modal.w.title = t.value;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && D.modal) { D.modal = null; renderModal(); e.stopPropagation(); }
    if (e.key === 'Tab' && D.modal) { const fs = [...layer.querySelectorAll('.modal button, .modal input, .modal select, .modal textarea')].filter(x => !x.disabled && x.offsetParent); if (!fs.length) return; const i = fs.indexOf(document.activeElement); if (i < 0 || (e.shiftKey && i === 0) || (!e.shiftKey && i === fs.length - 1)) { e.preventDefault(); fs[e.shiftKey ? fs.length - 1 : 0].focus(); } }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.clu')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  }, true);
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!A) return; if (A.S.page === 'dash') mountWidgets(); else if (A.S.page === 'board' && (A.S.view === 'chart' || A.S.view === 'map')) A.renderContent(); }, 150); });

  window.KSViews = {
    init(api) { A = api; },
    has, tabs, head, render,
    busy: () => !!drag,
    settings: t => stripLocal(cfg(t)),
    renderDash,
    railLink: () => `<button class="rl-link" data-act="go-dash" aria-current="${A.S.page === 'dash'}"><svg class="rl-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z"/></svg>Dashboards</button>`,
    // exposed for tests
    _geocode: geocode, _aggregate: aggregate,
  };
})();
