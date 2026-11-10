// Solver.ca client features: global search, item history + board activity, undo, recycle bin,
// duplicate board / templates, public forms, connected-board + mirror columns, time tracking.
// The page (index.html) calls in through window.SolverFeatures; this file reaches the page through window.SolverApp.
(() => {
  'use strict';
  const A = () => window.SolverApp;
  const S = () => A().S;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (m, u, b) => window.KS.api(m, u, b);
  const toast = m => A().toast(m);
  const canWrite = () => { const s = S(); return !!(s.canWrite && !s.isGuest); };
  const isAdmin = () => !!S().isOwner;
  const narrow = () => window.matchMedia('(max-width: 780px)').matches;
  const fmtWhen = iso => { try { const d = new Date(iso), t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const fmtDur = ms => { if (ms > 0 && ms < 60000) return '<1m'; const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60); return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
  const ICON = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  };

  // ---------- styles (match the glass look; phone friendly) ----------
  const css = document.createElement('style');
  css.textContent = `
  .fx-searchbox { width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,0.05); color: var(--muted); text-align: left; }
  .fx-searchbox:hover { background: rgba(255,255,255,0.08); color: #fff; }
  .fx-searchbox svg, .fx-ic svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; flex: none; }
  .fx-searchbox kbd { margin-left: auto; font-family: var(--f-data); font-size: 11px; border: 1px solid var(--line); border-radius: 6px; padding: 0 5px; }
  .fx-ic { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .fx-search-wrap { position: fixed; inset: 0; z-index: 45; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); display: flex; justify-content: center; align-items: flex-start; padding: max(8vh, 16px) 16px 16px; }
  .fx-search { width: min(680px, 100%); max-height: 80vh; display: flex; flex-direction: column; background: rgba(16,16,18,0.9); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); border: 1px solid var(--line); border-radius: 22px; box-shadow: var(--shadow); overflow: hidden; }
  .fx-search-top { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .fx-search-top svg { width: 18px; height: 18px; stroke: var(--muted); fill: none; stroke-width: 1.8; flex: none; }
  .fx-search-top input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: 17px; color: #fff; outline: none; padding: 6px 0; }
  .fx-results { overflow-y: auto; padding: 6px; }
  .fx-res-board { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 600; padding: 10px 10px 4px; display: flex; justify-content: space-between; gap: 8px; }
  .fx-res { width: 100%; display: flex; flex-direction: column; gap: 2px; text-align: left; border: 0; background: none; color: #fff; padding: 9px 10px; border-radius: 12px; }
  .fx-res b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-res span { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-res[aria-selected="true"], .fx-res:hover { background: rgba(255,255,255,0.08); }
  .fx-res mark { background: rgba(255,255,255,0.22); color: #fff; border-radius: 3px; }
  .fx-empty { color: var(--muted); padding: 18px 12px; text-align: center; }
  .fx-hint { color: var(--muted); font-size: 12px; padding: 8px 14px; border-top: 1px solid var(--line); display: flex; gap: 14px; flex-wrap: wrap; }
  .fx-toast { display: flex; align-items: center; gap: 12px; padding-right: 8px; }
  .fx-toast button { border: 0; background: #000; color: #fff; border-radius: 999px; padding: 4px 12px; font-weight: 600; font-size: 12.5px; }
  .fx-hist { display: flex; flex-direction: column; gap: 8px; }
  .fx-h { border: 1px solid var(--line); background: rgba(255,255,255,0.035); border-radius: var(--r-md); padding: 9px 12px; display: flex; gap: 10px; align-items: flex-start; }
  .fx-h-main { flex: 1; min-width: 0; line-height: 1.45; overflow-wrap: anywhere; }
  .fx-h-meta { color: var(--muted); font-size: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  .fx-h .was { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(255,255,255,0.3); }
  .fx-h .arrow { color: var(--muted); padding: 0 4px; }
  .fx-h.undone { opacity: .55; }
  .fx-h .src { border: 1px solid var(--line); border-radius: 99px; padding: 0 7px; font-size: 11px; }
  .fx-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
  .fx-sessions summary { cursor: pointer; color: var(--muted); font-size: 12.5px; padding: 2px 0; }
  .fx-sessions[open] summary { margin-bottom: 8px; }
  .fx-filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .fx-menu { position: fixed; z-index: 46; width: 240px; }
  .fx-cell { display: flex; align-items: center; gap: 4px; min-height: 37px; padding: 0 6px; overflow: hidden; }
  .fx-link { display: inline-flex; align-items: center; max-width: 160px; border: 1px solid var(--line); background: rgba(255,255,255,0.06); border-radius: 999px; padding: 2px 9px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; flex: none; }
  .fx-link:hover { background: rgba(255,255,255,0.12); }
  .fx-mute { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .fx-timer { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: rgba(255,255,255,0.06); border-radius: 999px; padding: 3px 10px 3px 6px; font-family: var(--f-data); font-size: 12px; color: #fff; }
  .fx-timer svg { width: 14px; height: 14px; fill: currentColor; stroke: none; }
  .fx-timer.on { background: rgba(255,255,255,0.9); color: #000; }
  .fx-total { font-family: var(--f-data); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .fx-run-dot { width: 7px; height: 7px; border-radius: 50%; background: #9fe3b4; box-shadow: 0 0 8px #9fe3b4; flex: none; }
  .fx-sess { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; }
  .fx-sess input { width: 100%; }
  .fx-row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .fx-q { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; }
  .fx-q .field-input { width: 100%; }
  .fx-q .sub { grid-column: 2 / 4; }
  .fx-link-out { word-break: break-all; user-select: all; font-family: var(--f-data); font-size: 12px; }
  .fx-pick { display: flex; flex-direction: column; gap: 2px; max-height: 50vh; overflow-y: auto; }
  @media (max-width: 780px) { .fx-search-wrap { padding: 0; align-items: stretch; } .fx-search { border-radius: 0; max-height: none; height: 100%; width: 100%; } .fx-search-top { padding-top: max(12px, env(safe-area-inset-top)); } .fx-q { grid-template-columns: auto minmax(0, 1fr); } .fx-q .req { grid-column: 2; } }
  `;
  document.head.appendChild(css);
  const layer = document.createElement('div'); layer.id = 'fx-layer'; document.body.appendChild(layer);

  // ---------- small UI kit: modal, menu, toast with an action ----------
  let M = null; // { type, ... } the open modal
  function openModal(m) { M = m; renderModal(); }
  function closeModal() { M = null; layer.innerHTML = ''; }
  function renderModal() {
    if (!M) { layer.innerHTML = ''; return; }
    const keep = document.activeElement && layer.contains(document.activeElement) && document.activeElement.id ? { id: document.activeElement.id, s: document.activeElement.selectionStart } : null;
    const html = MODALS[M.type] ? MODALS[M.type](M) : '';
    layer.innerHTML = M.type === 'search' ? html : `<div class="modal-wrap" data-fx="close-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(M.title || '')}">${html}</div></div>`;
    if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.s); } catch (e) {} } }
  }
  function toastAction(msg, label, fn, ms = 8000) {
    const box = document.getElementById('toasts'); if (!box) return;
    const t = document.createElement('div'); t.className = 'toast fx-toast'; t.setAttribute('role', 'status');
    t.innerHTML = `<span>${esc(msg)}</span><button type="button">${esc(label)}</button>`;
    let used = false;
    t.querySelector('button').addEventListener('click', () => { if (used) return; used = true; t.remove(); fn(); });
    box.appendChild(t); setTimeout(() => t.remove(), ms);
  }
  let menu = null; // { x, y, items: [[act, label, danger?]] }
  function showMenu(btn, items) {
    const r = btn.getBoundingClientRect();
    menu = { items, x: Math.max(8, Math.min(r.left, innerWidth - 248)), y: r.bottom + 4 };
    const el = document.createElement('div'); el.className = 'pop fx-menu'; el.dataset.fxMenu = '1'; el.style.left = menu.x + 'px'; el.style.top = menu.y + 'px';
    el.innerHTML = items.map(([a, l, d]) => `<button class="pop-btn" data-fx="${a}" ${d ? 'style="color:var(--danger)"' : ''}>${esc(l)}</button>`).join('');
    const m0 = menu; closeMenu(); menu = m0; document.body.appendChild(el);
    // measure it: it stays on the screen (above the phone's bottom bar) and scrolls if it's taller than the room left
    const bot = innerHeight - (matchMedia('(max-width: 780px)').matches ? 92 : 8), room = bot - 8;
    el.style.maxHeight = room + 'px'; el.style.overflowY = 'auto';
    const h = Math.min(el.getBoundingClientRect().height, room);
    let top = menu.y; if (top + h > bot) top = r.top - 4 - h >= 8 ? r.top - 4 - h : Math.max(8, bot - h);
    el.style.top = top + 'px'; const w = el.getBoundingClientRect().width; if (menu.x + w > innerWidth - 8) el.style.left = Math.max(8, innerWidth - 8 - w) + 'px';
  }
  function closeMenu() { document.querySelectorAll('[data-fx-menu]').forEach(x => x.remove()); menu = null; }

  // ---------- links (connected boards) and mirrors: fetched per board, kept fresh by live updates ----------
  const L = { board: null, items: {}, loading: false, timer: null, targets: new Set() };
  function relCols(b) { return ((b && b.columns) || []).filter(c => c.type === 'board_relation' || c.type === 'mirror'); }
  function loadLinks(force) {
    const b = A().board(); if (!b || !window.KS) return;
    if (!relCols(b).length) { L.board = b.id; L.items = {}; return; }
    if (!force && (L.board === b.id || L.loading)) return;
    L.loading = true; const bid = b.id;
    api('GET', '/api/x/links?board=' + encodeURIComponent(bid)).then(r => {
      L.loading = false; if (A().S.boardId !== bid) return;
      const changed = JSON.stringify(r.items) !== JSON.stringify(L.items) || L.board !== bid;
      L.board = bid; L.items = r.items || {};
      L.targets = new Set(((b.columns || []).filter(c => c.type === 'board_relation').flatMap(c => c.boards || [])));
      if (changed) A().scheduleRender();
    }).catch(() => { L.loading = false; L.board = bid; });
  }
  const refreshLinks = () => { clearTimeout(L.timer); L.timer = setTimeout(() => loadLinks(true), 400); };

  // ---------- cells for the new column types ----------
  const at = (item, col) => `data-item="${esc(item.id)}" data-col="${esc(col.id)}"`;
  function cell(col, item, inDrawer) {
    if (col.type === 'board_relation') {
      const b = A().board(); if (L.board !== (b && b.id)) loadLinks();
      const canEd = A().colEditable(col, b) && !A().S.isGuest;
      if (!(col.boards || []).length) return `<div class="fx-cell">${canEd ? `<button class="icon-btn" data-fx="setup-col" data-col="${esc(col.id)}">Set up</button>` : '<span class="fx-mute">Not set up</span>'}</div>`;
      const v = Array.isArray((item.values || {})[col.id]) ? item.values[col.id] : [];
      const got = (L.items[item.id] || {})[col.id];
      const chips = got ? got.links.map(l => `<button class="fx-link" data-fx="open-link" data-b="${esc(l.b)}" data-i="${esc(l.i)}" title="${esc(l.name)}">${esc(l.name || 'Item')}</button>`).join('') + (got.hidden ? `<span class="fx-mute" title="On a board you can’t open">+${got.hidden} hidden</span>` : '') : v.length ? `<span class="fx-mute">${v.length} linked</span>` : '';
      return `<div class="fx-cell" ${inDrawer ? 'style="flex-wrap:wrap;padding:4px 0"' : ''}>${chips}${canEd ? `<button class="icon-btn" data-fx="pick-links" ${at(item, col)} aria-label="Link items in ${esc(col.title)}" title="Link items">${inDrawer && !v.length ? '+ Link an item' : '+'}</button>` : ''}</div>`;
    }
    if (col.type === 'mirror') {
      const b = A().board(); if (L.board !== (b && b.id)) loadLinks();
      if (!col.relation || !col.mirror) return `<div class="fx-cell">${A().colEditable(col, b) && !A().S.isGuest ? `<button class="icon-btn" data-fx="setup-col" data-col="${esc(col.id)}">Set up</button>` : '<span class="fx-mute">Not set up</span>'}</div>`;
      const got = (L.items[item.id] || {})[col.id];
      return `<div class="ro" title="${esc(got ? got.text : '')}" style="padding:0 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(got ? got.text : '')}</div>`;
    }
    if (col.type === 'time_tracking') {
      const v = (item.values || {})[col.id], ss = (v && v.sessions) || [], s = A().S;
      const done = ss.filter(x => x.end).reduce((t, x) => t + (Date.parse(x.end) - Date.parse(x.start)), 0), runs = ss.filter(x => !x.end);
      const mine = runs.find(x => x.by === s.uid), canEd = A().colEditable(col);
      const total = `<span class="fx-total" data-fx-tick="${done}" data-fx-runs="${runs.map(x => Date.parse(x.start)).join(',')}">${fmtDur(done + runs.reduce((t, x) => t + (Date.now() - Date.parse(x.start)), 0))}</span>`;
      const btn = canEd ? `<button class="fx-timer ${mine ? 'on' : ''}" data-fx="timer" data-act-t="${mine ? 'stop' : 'start'}" ${at(item, col)} aria-label="${mine ? 'Stop' : 'Start'} timer">${mine ? ICON.stop + 'Stop' : ICON.play + 'Start'}</button>` : '';
      const head = `<div class="fx-cell">${btn}${runs.length ? '<span class="fx-run-dot" title="A timer is running"></span>' : ''}${ss.length ? total : canEd ? '' : '<span class="fx-mute">—</span>'}</div>`;
      if (!inDrawer) return head;
      const rows = ss.slice().reverse().map(x => {
        const own = x.by === s.uid || s.isOwner;
        const local = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
        return `<div class="fx-h"><div class="fx-h-main"><b>${esc(x.name || 'Someone')}</b> · ${x.end ? fmtDur(Date.parse(x.end) - Date.parse(x.start)) : 'running'}<div class="fx-h-meta">${esc(fmtWhen(x.start))}${x.end ? ' – ' + esc(fmtWhen(x.end)) : ''}</div>
          ${own && canEd && editSess === x.id ? `<div class="fx-sess" style="margin-top:8px"><input class="field-input" type="datetime-local" id="fx-ts-${esc(x.id)}" value="${local(x.start)}" aria-label="Start"><span class="fx-mute">start</span>${x.end ? `<input class="field-input" type="datetime-local" id="fx-te-${esc(x.id)}" value="${local(x.end)}" aria-label="End"><span class="fx-mute">end</span>` : ''}</div>
            <div class="fx-row-actions" style="margin-top:8px"><button class="btn primary" data-fx="sess-save" data-s="${esc(x.id)}" ${at(item, col)}>Save</button><button class="btn" data-fx="sess-cancel">Cancel</button></div>` : ''}</div>
          ${own && canEd && editSess !== x.id ? `<div class="fx-row-actions"><button class="icon-btn" data-fx="sess-edit" data-s="${esc(x.id)}">Edit</button><button class="icon-btn" data-fx="sess-del" data-s="${esc(x.id)}" ${at(item, col)}>Delete</button></div>` : ''}</div>`;
      }).join('');
      return `<div style="display:flex;flex-direction:column;gap:6px;width:100%">${head}${rows ? `<details class="fx-sessions" ${sessOpen || editSess || runs.length ? 'open' : ''}><summary>${ss.length} session${ss.length === 1 ? '' : 's'} · by person and time</summary><div class="fx-hist">${rows}</div></details>` : ''}${canEd ? `<div><button class="icon-btn" data-fx="sess-add" ${at(item, col)}>+ Add time by hand</button></div>` : ''}</div>`;
    }
    return undefined;
  }
  let editSess = null, sessOpen = false;
  document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('fx-sessions')) sessOpen = e.target.open; }, true);
  setInterval(() => { document.querySelectorAll('[data-fx-tick]').forEach(el => { const base = Number(el.dataset.fxTick) || 0, runs = (el.dataset.fxRuns || '').split(',').filter(Boolean).map(Number); if (runs.length) el.textContent = fmtDur(base + runs.reduce((t, s) => t + (Date.now() - s), 0)); }); }, 15000);
  function describe(col, v) {
    if (col.type === 'time_tracking') { const ss = (v && v.sessions) || []; return ss.length ? fmtDur(ss.reduce((t, x) => t + ((x.end ? Date.parse(x.end) : Date.now()) - Date.parse(x.start)), 0)) : 'empty'; }
    if (col.type === 'board_relation') return Array.isArray(v) && v.length ? `${v.length} linked` : 'empty';
    if (col.type === 'mirror') return '';
    return undefined;
  }

  // ---------- search ----------
  const SR = { q: '', res: null, sel: 0, timer: null, seq: 0 };
  function openSearch() { openModal({ type: 'search' }); setTimeout(() => { const i = document.getElementById('fx-q'); if (i) { i.focus(); i.select(); } }, 0); }
  function flatResults() { const out = []; if (!SR.res) return out; (SR.res.boardHits || []).forEach(b => out.push({ b: b.id })); (SR.res.boards || []).forEach(g => g.items.forEach(i => out.push({ b: g.id, i: i.id }))); return out; }
  function mark(text, q) { const t = String(text || ''), i = t.toLowerCase().indexOf(q.toLowerCase()); if (!q || i < 0) return esc(t); return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length)); }
  // second line of a result: board · group · status · phone/email (group and the rest when the board is open here,
  // or when the server sends them along as i.group / i.status / i.contact)
  function resMeta(g, i) {
    const s = S(), b = (s.boards || []).find(x => x.id === g.id), it = s.boardId === g.id ? (s.items || []).find(x => x.id === i.id) : null;
    const parts = [g.name];
    const gid = (it && it.group) || i.group, grp = b && gid && (b.groups || []).find(x => x.id === gid); if (grp) parts.push(grp.name); else if (i.groupName) parts.push(i.groupName);
    if (it && b) {
      const v = it.values || {}, st = (b.columns || []).find(c => c.type === 'status' && v[c.id]); if (st) { const l = (st.labels || []).find(x => x.id === v[st.id]); if (l) parts.push(l.label); }
      const ct = (b.columns || []).find(c => (c.type === 'phone' || c.type === 'email') && v[c.id]); if (ct) parts.push(String(v[ct.id]));
    } else { if (i.status) parts.push(i.status); if (i.contact) parts.push(i.contact); }
    return parts.filter(Boolean).join(' · ');
  }
  function resultsHtml() {
    if (SR.q.trim().length < 2) return '<div class="fx-empty">Type at least two letters. Names, phone numbers, emails, notes and updates on every board you can open.</div>';
    if (!SR.res) return '<div class="fx-empty">Searching…</div>';
    if (!SR.res.total && !(SR.res.boardHits || []).length) return `<div class="fx-empty">Nothing matches “${esc(SR.q)}”.</div>`;
    let k = -1; const q = SR.res.q;
    const bh = (SR.res.boardHits || []).length ? `<div class="fx-res-board">Boards</div>` + SR.res.boardHits.map(b => { k++; return `<button class="fx-res" role="option" data-fx="open-res" data-k="${k}" aria-selected="${k === SR.sel}"><b>${mark(b.name, q)}</b><span>Open board</span></button>`; }).join('') : '';
    return bh + SR.res.boards.map(g => `<div class="fx-res-board"><span>${esc(g.name)}</span><span>${g.count > g.items.length ? `${g.items.length} of ${g.count}` : g.count}</span></div>` + g.items.map(i => { k++; return `<button class="fx-res" role="option" data-fx="open-res" data-k="${k}" aria-selected="${k === SR.sel}"><b>${mark(i.name, q)}</b>${i.where ? `<span>${esc(i.where)}: ${mark(i.snip, q)}</span>` : ''}<span>${esc(resMeta(g, i))}</span></button>`; }).join('')).join('');
  }
  function paintResults() { const el = document.getElementById('fx-results'); if (el) { el.innerHTML = resultsHtml(); const s = el.querySelector('[aria-selected="true"]'); if (s) s.scrollIntoView({ block: 'nearest' }); } }
  function runSearch() {
    clearTimeout(SR.timer); const q = SR.q.trim(); SR.sel = 0;
    if (q.length < 2) { SR.res = null; paintResults(); return; }
    SR.timer = setTimeout(() => { const n = ++SR.seq; api('GET', '/api/x/search?q=' + encodeURIComponent(q)).then(r => { if (n !== SR.seq) return; SR.res = r; paintResults(); }).catch(e => { SR.res = { q, boards: [], total: 0 }; paintResults(); toast(e.message || 'Search failed.'); }); }, 160);
  }
  function openResult(k) {
    const r = flatResults()[k]; if (!r) return;
    closeModal();
    if (window.SolverOpen) window.SolverOpen(r.b, r.i || null);
  }

  // ---------- history ----------
  const HC = new Map(); // item id -> { sig, html }
  const histSig = i => JSON.stringify([i.name, i.group, i.values, (i.updates || []).length, (i.subitems || []).length]);
  function histRow(r, opts = {}) {
    const what = r.kind === 'created' ? 'Created the item' : r.kind === 'deleted' ? 'Deleted the item' : r.kind === 'restored' ? 'Restored from the recycle bin' : r.kind === 'moved' ? `Moved to ${esc(r.after || 'another board')}`
      : r.kind === 'update' ? `Posted an update: <span class="fx-mute">“${esc(String(r.after || '').slice(0, 160))}”</span>` : r.kind === 'board' ? esc(r.after || '')
      : r.col === '__subitems' ? 'Changed subitems'
      : `<b>${esc(r.colName)}</b>: ${r.before ? `<span class="was">${esc(r.before)}</span>` : '<span class="fx-mute">empty</span>'}<span class="arrow">→</span>${r.after ? esc(r.after) : '<span class="fx-mute">empty</span>'}`;
    const src = r.source === 'monday' ? '<span class="src">From Monday</span>' : r.source === 'undo' ? '<span class="src">Via undo</span>' : r.source === 'restore' ? '' : ['api', 'link', 'form', 'automation'].includes(r.source) ? `<span class="src">${esc(r.source === 'form' ? 'Form' : r.source === 'link' ? 'Lead link' : r.source === 'api' ? 'API' : 'Automation')}</span>` : '';
    const item = opts.board && r.item ? `<button class="icon-btn" style="padding:0;color:#fff" data-fx="open-link" data-b="${esc(opts.board)}" data-i="${esc(r.item)}">${esc(r.itemName || 'Item')}</button> · ` : '';
    const undo = r.canUndo && canWrite() ? `<button class="icon-btn" data-fx="revert" data-id="${r.id}" title="Put the old value back">Undo</button>` : r.undone ? '<span class="fx-mute">Undone</span>' : '';
    return `<div class="fx-h ${r.undone ? 'undone' : ''}"><div class="fx-h-main">${item}${what}<div class="fx-h-meta"><span>${esc(r.byName || 'Someone')}</span><span>${esc(fmtWhen(r.at))}</span>${src}</div></div>${undo}</div>`;
  }
  function historyTab(b, i) {
    const c = HC.get(i.id), sig = histSig(i);
    if (!c || c.sig !== sig || c.stale) loadItemHistory(b, i, sig);
    return `<div id="fx-hist" data-item="${esc(i.id)}"><p class="rail-note" style="margin:0 0 10px">Every change to this item, newest first, kept for good. ${canWrite() ? 'Undo puts a cell back the way it was.' : ''}</p>${c ? c.html : '<p class="rail-note">Loading the history…</p>'}</div>`;
  }
  function loadItemHistory(b, i, sig) {
    const key = i.id; if ((HC.get(key) || {}).loading) return;
    HC.set(key, { ...(HC.get(key) || {}), loading: true, sig: (HC.get(key) || {}).sig });
    api('GET', `/api/x/history?board=${encodeURIComponent(b.id)}&item=${encodeURIComponent(i.id)}&limit=150`).then(r => {
      const html = `<div class="fx-hist">${r.rows.map(x => histRow(x)).join('') || '<p class="rail-note">No changes recorded yet. Changes made from now on show up here.</p>'}</div>${r.more ? '<p class="rail-note">Older changes: see Board activity.</p>' : ''}`;
      HC.set(key, { sig, html, loading: false });
      const el = document.getElementById('fx-hist'); if (el && el.dataset.item === key) el.innerHTML = el.firstElementChild.outerHTML + html;
    }).catch(() => HC.set(key, { sig, html: '<p class="rail-note">The history couldn’t be loaded.</p>', loading: false }));
  }
  function revert(id) {
    api('POST', '/api/x/history/revert', { id: Number(id) }).then(r => {
      toast(r.cells ? 'Put back the old value' : r.skipped && r.skipped.length ? `Not undone: ${r.skipped.join(', ')}` : 'Nothing to undo');
      HC.forEach(v => { v.stale = true; }); if (M && M.type === 'activity') loadActivity(true); A().scheduleRender();
    }).catch(e => toast(e.message));
  }

  // ---------- board activity ----------
  function openActivity(b) { openModal({ type: 'activity', title: 'Board activity', board: b.id, f: { by: '', col: '', from: '', to: '' }, rows: null, facets: null }); loadActivity(true); api('GET', '/api/x/history/facets?board=' + encodeURIComponent(b.id)).then(f => { if (M && M.type === 'activity') { M.facets = f; renderModal(); } }).catch(() => {}); }
  function loadActivity(reset) {
    const m = M; if (!m || m.type !== 'activity') return;
    const qs = new URLSearchParams({ board: m.board, limit: '80' }); for (const [k, v] of Object.entries(m.f)) if (v) qs.set(k, v);
    if (!reset && m.next) qs.set('before', m.next);
    m.busy = true; renderModal();
    api('GET', '/api/x/history?' + qs).then(r => { if (M !== m) return; m.busy = false; m.rows = reset ? r.rows : [...(m.rows || []), ...r.rows]; m.next = r.next; m.more = r.more; renderModal(); }).catch(e => { m.busy = false; m.err = e.message; renderModal(); });
  }

  // ---------- undo after deletes and bulk edits ----------
  function deleted(paths, msg) {
    if (!canWrite()) { toast(msg); return true; }
    toastAction(msg, 'Undo', () => {
      const go = (tries) => api('POST', '/api/x/bin/restore', { paths }).then(r => { if (r.restored < paths.length && tries) return setTimeout(() => go(tries - 1), 700); toast(r.restored ? `Restored ${r.restored === 1 ? 'it' : r.restored + ' items'}` : 'It was already restored.'); }).catch(e => toast(e.message));
      go(2);
    });
    return true;
  }
  function bulkEdited(b, ids, t0, msg) {
    toastAction(msg, 'Undo', () => api('POST', '/api/x/undo', { board: b.id, items: ids, withinMs: Date.now() - t0 + 3000 }).then(r => toast(r.cells ? `Undone (${r.cells} change${r.cells === 1 ? '' : 's'})` : 'Nothing to undo')).catch(e => toast(e.message)));
    return true;
  }
  function deleteGroup(b, gid) {
    const g = (b.groups || []).find(x => x.id === gid);
    api('POST', '/api/x/group/delete', { board: b.id, group: gid }).then(r => {
      toastAction(`Deleted “${g ? g.name : 'group'}”${r.items ? ` and ${r.items} item${r.items === 1 ? '' : 's'}` : ''}`, 'Undo', () => api('POST', '/api/x/bin/restore', { id: r.bin }).then(() => toast('Group restored')).catch(e => toast(e.message)));
    }).catch(e => toast(e.message));
    return true;
  }
  function undoLast() {
    const b = A().board(); if (!b || !canWrite()) return;
    api('POST', '/api/x/undo-last', { board: b.id }).then(r => toast(r.none ? 'Nothing of yours to undo on this board in the last hour.' : r.cells ? `Undid ${r.what}` : `Couldn’t undo${r.skipped && r.skipped.length ? ': ' + r.skipped.join(', ') : ''}`)).catch(e => toast(e.message));
  }

  // ---------- recycle bin ----------
  function openBin() { openModal({ type: 'bin', title: 'Recycle bin', items: null }); api('GET', '/api/x/bin').then(r => { if (M && M.type === 'bin') { M.items = r.items; M.days = r.days; renderModal(); } }).catch(e => { if (M) { M.err = e.message; renderModal(); } }); }

  // ---------- modals ----------
  const boardOptions = (sel, skip) => A().workspaces().map(w => `<optgroup label="${esc(w.name)}">${S().boards.filter(x => A().wsOf(x).id === w.id && x.id !== skip).map(x => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  const MODALS = {
    search: () => `<div class="fx-search-wrap" data-fx="close-bg"><div class="fx-search" role="dialog" aria-modal="true" aria-label="Search everything">
      <div class="fx-search-top">${ICON.search}<input id="fx-q" type="search" placeholder="Search every board" value="${esc(SR.q)}" autocomplete="off" aria-label="Search every board" aria-controls="fx-results"><button class="btn" data-fx="close">${narrow() ? 'Cancel' : 'Esc'}</button></div>
      <div class="fx-results" id="fx-results" role="listbox">${resultsHtml()}</div>
      ${narrow() ? '' : '<div class="fx-hint"><span>↑ ↓ to move</span><span>Enter to open</span><span>Esc to close</span></div>'}</div></div>`,
    activity: m => {
      const b = S().boards.find(x => x.id === m.board) || {}, f = m.facets || { people: [], cols: [] };
      return `<h3>Board activity · ${esc(b.name || '')}</h3><p>Every change on this board: who, when, which column, before and after. Changes copied from Monday are marked.</p>
        <div class="fx-filters">
          <label>Person<select class="field-input" id="fx-f-by"><option value="">Everyone</option>${f.people.map(p => `<option value="${esc(p.id)}" ${m.f.by === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label>Column<select class="field-input" id="fx-f-col"><option value="">Every column</option>${f.cols.map(c => `<option value="${esc(c.id)}" ${m.f.col === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label>From<input class="field-input" type="date" id="fx-f-from" value="${esc(m.f.from)}"></label>
          <label>To<input class="field-input" type="date" id="fx-f-to" value="${esc(m.f.to)}"></label>
        </div>
        ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
        <div class="fx-hist">${m.rows ? m.rows.map(r => histRow(r, { board: m.board })).join('') || '<p class="rail-note">No changes match.</p>' : '<p class="rail-note">Loading…</p>'}</div>
        <div class="form-row">${m.more ? `<button class="btn" data-fx="act-more" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Loading…' : 'Load older changes'}</button>` : ''}<button class="btn" data-fx="close">Close</button></div>`;
    },
    bin: m => {
      const days = d => Math.max(0, Math.ceil((Date.parse(d) - Date.now()) / 864e5));
      const rows = (m.items || []).map(x => `<div class="rule"><div class="rule-text"><b>${esc(x.name)}</b> <span class="pill">${x.kind === 'board' ? 'Board' : x.kind === 'group' ? 'Group' : 'Item'}</span>${x.count != null ? ` <span class="fx-mute">${x.count} item${x.count === 1 ? '' : 's'}</span>` : ''}
          <div class="card-meta"><span>${x.kind === 'board' ? '' : esc(x.boardName) + (x.boardGone ? ' (deleted)' : '')}</span><span>Deleted ${esc(fmtWhen(x.at))} by ${esc(x.mine ? 'you' : x.by || 'someone')}</span><span>Gone for good in ${days(x.expires)} day${days(x.expires) === 1 ? '' : 's'}</span></div></div>
          <button class="btn primary" data-fx="restore" data-id="${esc(x.id)}">Restore</button>${isAdmin() ? `<button class="icon-btn" data-fx="forget" data-id="${esc(x.id)}">${m.confirm === x.id ? 'Click again to delete forever' : 'Delete forever'}</button>` : ''}</div>`).join('');
      return `<h3>Recycle bin</h3><p>Deleted items, groups and boards stay here for ${m.days || 30} days, then they’re removed for good. Restore puts them back exactly as they were.${isAdmin() ? ' As an admin you see everything.' : ' You see what you deleted and what was deleted on boards you can open.'}</p>
        ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
        ${m.items ? rows || '<p class="rail-note">The recycle bin is empty.</p>' : '<p class="rail-note">Loading…</p>'}
        <div><button class="btn" data-fx="close">Close</button></div>`;
    },
    duplicate: m => `<h3>Duplicate ${esc(m.name)}</h3><p>Makes a new board with the same columns, groups, automations and saved views. New boards belong to Solver.ca: the copy from Monday never changes them.</p>
      <div class="form-row"><label for="fx-dup-name">Name</label><input class="field-input" id="fx-dup-name" value="${esc(m.name + ' (copy)')}" style="flex:1 1 220px"></div>
      <div class="form-row"><label class="pop-check"><input type="radio" name="fx-dup-items" value="0" ${m.withItems ? '' : 'checked'}>Structure only</label><label class="pop-check"><input type="radio" name="fx-dup-items" value="1" ${m.withItems ? 'checked' : ''}>With items (${m.count.toLocaleString('en-CA')})</label></div>
      ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      <div class="form-row"><button class="btn primary" data-fx="dup-go" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Copying…' : 'Duplicate'}</button><button class="btn" data-fx="close">Cancel</button></div>`,
    'save-template': m => `<h3>Save as template</h3><p>Saves this board’s columns, groups, automations and saved views (no items) so anyone on the team can start a new board from it.</p>
      <div class="form-row"><label for="fx-tp-name">Template name</label><input class="field-input" id="fx-tp-name" value="${esc(m.name)}" style="flex:1 1 220px"></div>
      ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      <div class="form-row"><button class="btn primary" data-fx="tp-save">Save template</button><button class="btn" data-fx="close">Cancel</button></div>`,
    templates: m => `<h3>New board from a template</h3>
      ${m.list ? (m.list.length ? m.list.map(t => `<div class="rule ${m.pick === t.id ? '' : 'off'}" style="${m.pick === t.id ? 'border-color:#fff' : ''}"><div class="rule-text"><b>${esc(t.name)}</b><div class="card-meta"><span>${t.columns} columns</span><span>${t.groups} groups</span><span>${t.automations} automations</span><span>${t.views} views</span><span>by ${esc(t.by || 'someone')}</span></div></div>
          <button class="btn ${m.pick === t.id ? 'primary' : ''}" data-fx="tp-pick" data-id="${esc(t.id)}">${m.pick === t.id ? 'Picked' : 'Use'}</button>${t.mine || isAdmin() ? `<button class="icon-btn" data-fx="tp-del" data-id="${esc(t.id)}">${m.confirm === t.id ? 'Click again' : 'Delete'}</button>` : ''}</div>`).join('') : '<p class="rail-note">No templates yet. Open a board, then More → Save as template.</p>') : '<p class="rail-note">Loading…</p>'}
      ${m.pick ? `<div class="form-row"><label for="fx-tp-new">New board name</label><input class="field-input" id="fx-tp-new" value="${esc((m.list.find(t => t.id === m.pick) || {}).name || '')}" style="flex:1 1 220px"><button class="btn primary" data-fx="tp-use">Create board</button></div>` : ''}
      ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      <div><button class="btn" data-fx="close">Close</button></div>`,
    forms: m => {
      const b = S().boards.find(x => x.id === m.board) || { columns: [], groups: [] };
      if (m.edit) return formEditor(b, m);
      const rows = (m.list || []).map(f => { const link = location.origin + '/f/' + f.token; return `<div class="rule ${f.active ? '' : 'off'}"><div class="rule-text"><b>${esc(f.title)}</b><div class="card-meta"><span>${f.questions.length} questions</span><span>${f.submissions} answer${f.submissions === 1 ? '' : 's'}${f.lastAt ? ', last ' + esc(fmtWhen(f.lastAt)) : ''}</span><span>Into ${esc(((b.groups || []).find(g => g.id === f.group) || {}).name || 'first group')}</span></div><div class="fx-link-out">${esc(link)}</div></div>
        <button class="icon-btn" data-fx="form-copy" data-link="${esc(link)}">Copy link</button><a class="icon-btn" href="${esc(link)}" target="_blank" rel="noopener" style="text-decoration:none">Open</a><button class="toggle" data-fx="form-toggle" data-id="${esc(f.id)}" aria-pressed="${f.active}">${f.active ? 'On' : 'Off'}</button><button class="icon-btn" data-fx="form-edit" data-id="${esc(f.id)}">Edit</button><button class="icon-btn" data-fx="form-del" data-id="${esc(f.id)}">${m.confirm === f.id ? 'Click again' : 'Delete'}</button></div>`; }).join('');
      return `<h3>Forms · ${esc(b.name)}</h3><p>A public page anyone with the link can fill in, no sign-in. Each answer becomes an item on this board and runs the board’s automations and webhooks. Turn a form off to close it.</p>
        ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
        ${m.list ? rows || '<p class="rail-note">No forms yet.</p>' : '<p class="rail-note">Loading…</p>'}
        <div class="form-row"><button class="btn primary" data-fx="form-new">New form</button>${b.form ? '<button class="btn" data-fx="form-monday">Start from the Monday form</button>' : ''}<button class="btn" data-fx="close">Close</button></div>`;
    },
    links: m => {
      const b = S().boards.find(x => x.id === m.board) || { columns: [] };
      const rels = b.columns.filter(c => c.type === 'board_relation'), mirs = b.columns.filter(c => c.type === 'mirror');
      const bname = id => (S().boards.find(x => x.id === id) || {}).name || 'a board you can’t open';
      const tb = S().boards.find(x => x.id === m.mirRelBoard);
      return `<h3>Connect boards</h3><p>A connect column links items here to items on another board. A mirror column then shows one column of the linked items, always current. People only see linked items on boards they can open.</p>
        ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
        ${rels.map(c => `<div class="rule"><div class="rule-text"><b>${esc(c.title)}</b> → ${(c.boards || []).length ? esc((c.boards || []).map(bname).join(', ')) : '<span class="fx-mute">not set up</span>'}</div></div>`).join('')}
        ${mirs.map(c => { const rc = rels.find(r => r.id === c.relation), t = rc && S().boards.find(x => x.id === (rc.boards || [])[0]); return `<div class="rule"><div class="rule-text"><b>${esc(c.title)}</b> mirrors ${rc ? `“${esc(((t && t.columns.find(x => x.id === c.mirror)) || {}).title || '?')}” through ${esc(rc.title)}` : '<span class="fx-mute">not set up</span>'}</div></div>`; }).join('')}
        <h3 style="font-size:16px">${m.col && rels.some(c => c.id === m.col) ? 'Set up ' + esc((rels.find(c => c.id === m.col) || {}).title) : 'Add a connect column'}</h3>
        <div class="form-row">${m.col && rels.some(c => c.id === m.col) ? '' : `<input class="field-input" id="fx-rel-title" placeholder="Column name, e.g. Lender" style="flex:1 1 160px">`}<select class="field-input" id="fx-rel-board" aria-label="Board to link to">${boardOptions(m.relBoard || '', null)}</select><button class="btn primary" data-fx="rel-add">${m.col && rels.some(c => c.id === m.col) ? 'Save' : 'Add'}</button></div>
        ${rels.length ? `<h3 style="font-size:16px">${m.col && mirs.some(c => c.id === m.col) ? 'Set up ' + esc((mirs.find(c => c.id === m.col) || {}).title) : 'Add a mirror column'}</h3>
        <div class="form-row">${m.col && mirs.some(c => c.id === m.col) ? '' : `<input class="field-input" id="fx-mir-title" placeholder="Column name, e.g. Lender status" style="flex:1 1 160px">`}<select class="field-input" id="fx-mir-rel" aria-label="Through">${rels.map(c => `<option value="${esc(c.id)}" ${m.mirRel === c.id ? 'selected' : ''}>Through ${esc(c.title)}</option>`).join('')}</select>
          <select class="field-input" id="fx-mir-col" aria-label="Column to show">${tb ? tb.columns.filter(c => !['button', 'board_relation', 'mirror'].includes(c.type)).map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('') : '<option value="">Pick a connect column first</option>'}</select><button class="btn primary" data-fx="mir-add">${m.col && mirs.some(c => c.id === m.col) ? 'Save' : 'Add'}</button></div>` : ''}
        <div><button class="btn" data-fx="close">Done</button></div>`;
    },
    'pick-links': m => {
      const tb = S().boards.find(x => x.id === m.target);
      return `<h3>Link items${tb ? ' from ' + esc(tb.name) : ''}</h3>
        <div class="form-row"><input class="field-input" id="fx-lk-q" placeholder="Search by name" value="${esc(m.q || '')}" style="flex:1 1 200px" autocomplete="off"></div>
        <div class="fx-pick">${m.list ? m.list.map(x => `<label class="pop-check"><input type="checkbox" data-fx-lk="${esc(x.id)}" ${m.sel.has(x.id) ? 'checked' : ''}>${esc(x.name)}<span class="ct">${esc(x.group)}</span></label>`).join('') || '<p class="rail-note">No items match.</p>' : '<p class="rail-note">Loading…</p>'}</div>
        <div class="form-row"><button class="btn primary" data-fx="lk-save">Save · ${m.sel.size} linked</button><button class="btn" data-fx="close">Cancel</button></div>`;
    },
    'sess-add': m => `<h3>Add time</h3><div class="fx-sess"><input class="field-input" type="datetime-local" id="fx-add-s" aria-label="Start"><span class="fx-mute">start</span><input class="field-input" type="datetime-local" id="fx-add-e" aria-label="End"><span class="fx-mute">end</span></div>
      ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}<div class="form-row"><button class="btn primary" data-fx="add-go">Add</button><button class="btn" data-fx="close">Cancel</button></div>`,
  };
  const FORM_OK = new Set(['text', 'phone', 'email', 'number', 'date', 'status', 'dropdown', 'checkbox', 'link']);
  function formEditor(b, m) {
    const e = m.edit, inForm = new Map(e.questions.map(q => [q.col, q]));
    const cand = [{ id: 'name', title: 'Item name', type: 'text' }, ...b.columns.filter(c => FORM_OK.has(c.type) && !c.readonly)];
    const ordered = [...e.questions.map(q => cand.find(c => c.id === q.col)).filter(Boolean), ...cand.filter(c => !inForm.has(c.id))];
    return `<h3>${e.id ? 'Edit form' : 'New form'}</h3>
      <div class="form-row"><label for="fx-fm-title">Title</label><input class="field-input" id="fx-fm-title" value="${esc(e.title)}" style="flex:1 1 220px"></div>
      <div class="form-row"><label for="fx-fm-desc">Intro</label><input class="field-input" id="fx-fm-desc" value="${esc(e.desc || '')}" placeholder="Optional, shown under the title" style="flex:1 1 220px"></div>
      <div class="form-row"><label for="fx-fm-group">New items go to</label><select class="field-input" id="fx-fm-group">${(b.groups || []).map(g => `<option value="${esc(g.id)}" ${g.id === e.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
      <div class="form-row"><label for="fx-fm-thanks">Thank-you message</label><input class="field-input" id="fx-fm-thanks" value="${esc(e.thanks || '')}" style="flex:1 1 220px"></div>
      <p>Pick the questions. Each one fills a column. The name question is always asked.</p>
      <div style="display:flex;flex-direction:column;gap:6px">${ordered.map(c => { const q = inForm.get(c.id), on = !!q || c.id === 'name'; return `<div class="fx-q" data-fx-qcol="${esc(c.id)}">
        <input type="checkbox" class="fx-q-on" ${on ? 'checked' : ''} ${c.id === 'name' ? 'disabled' : ''} aria-label="Ask ${esc(c.title)}">
        <input class="field-input fx-q-label" value="${esc(q ? q.q || c.title : c.title)}" aria-label="Question for ${esc(c.title)}">
        <label class="pop-check req"><input type="checkbox" class="fx-q-req" ${(q && q.required) || c.id === 'name' ? 'checked' : ''} ${c.id === 'name' ? 'disabled' : ''}>Required</label>
        <input class="field-input fx-q-desc sub" value="${esc(q ? q.desc || '' : '')}" placeholder="Help text (optional) · ${esc(c.title)}, ${esc(c.type)}" aria-label="Help text for ${esc(c.title)}"></div>`; }).join('')}</div>
      ${m.err ? `<div class="rule"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      <div class="form-row"><button class="btn primary" data-fx="form-save">${e.id ? 'Save form' : 'Create form'}</button><button class="btn" data-fx="form-back">Back</button></div>`;
  }
  function readForm() {
    const qs = [...layer.querySelectorAll('[data-fx-qcol]')].filter(r => r.querySelector('.fx-q-on').checked).map(r => ({ col: r.dataset.fxQcol, q: r.querySelector('.fx-q-label').value.trim(), desc: r.querySelector('.fx-q-desc').value.trim(), required: r.dataset.fxQcol === 'name' || r.querySelector('.fx-q-req').checked }));
    const v = id => (document.getElementById(id) || {}).value || '';
    return { title: v('fx-fm-title').trim(), desc: v('fx-fm-desc').trim(), group: v('fx-fm-group'), thanks: v('fx-fm-thanks').trim(), questions: qs };
  }
  function loadForms() { const m = M; api('GET', '/api/x/forms?board=' + encodeURIComponent(m.board)).then(l => { if (M === m) { m.list = l; renderModal(); } }).catch(e => { if (M === m) { m.err = e.message; renderModal(); } }); }
  function loadTemplates() { const m = M; api('GET', '/api/x/templates').then(l => { if (M === m) { m.list = l; renderModal(); } }).catch(e => { if (M === m) { m.err = e.message; renderModal(); } }); }
  function loadPick() { const m = M; api('GET', `/api/x/link-search?board=${encodeURIComponent(m.target)}&q=${encodeURIComponent(m.q || '')}`).then(l => { if (M === m) { m.list = l; renderModal(); } }).catch(e => { if (M === m) { m.list = []; toast(e.message); renderModal(); } }); }
  function newColId() { return 'c' + Math.random().toString(36).slice(2, 10); }

  // ---------- page hooks ----------
  function head(b) {
    const s = S(); const view = A().curView && A().curView();
    return `${narrow() ? `<button class="btn fx-ic" data-fx="search" aria-label="Search everything">${ICON.search}</button>` : ''}
      ${s.isGuest ? '' : '<button class="btn" data-fx="activity" title="Every change on this board">Activity</button>'}
      ${s.isGuest ? '' : '<button class="btn" data-fx="board-menu" aria-haspopup="menu">More</button>'}
      ${view && view.note ? `<span class="pill" title="${esc(view.note)}">View partly copied</span>` : ''}`;
  }
  function railTop() { return `<button class="fx-searchbox" data-fx="search" aria-label="Search everything">${ICON.search}<span>Search everything</span><kbd>/</kbd></button>`; }
  function railBottom() { return canWrite() ? '<div class="form-row"><button class="btn" data-fx="templates">From template</button><button class="btn" data-fx="bin">Recycle bin</button></div>' : ''; }
  function homeTop() { return `<button class="icon-round" data-fx="search" aria-label="Search everything">${ICON.search.replace('<svg', '<svg style="width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.6"')}</button>`; }

  // ---------- events ----------
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-fx-menu]') && !e.target.closest('[data-fx="board-menu"]')) closeMenu();
    const t = e.target.closest('[data-fx]'); if (!t) return;
    const a = t.dataset.fx, b = A().board();
    if (a === 'close-bg' && e.target !== t) return;
    switch (a) {
      case 'close': case 'close-bg': closeModal(); break;
      case 'search': SR.q = SR.q || ''; openSearch(); break;
      case 'open-res': openResult(Number(t.dataset.k)); break;
      case 'open-link': closeModal(); if (window.SolverOpen) window.SolverOpen(t.dataset.b, t.dataset.i); break;
      case 'activity': if (b) openActivity(b); break;
      case 'act-more': loadActivity(false); break;
      case 'revert': revert(t.dataset.id); break;
      case 'board-menu': {
        if (!b) return; const items = [];
        if (canWrite()) items.push(['dup', 'Duplicate board…'], ['save-tp', 'Save as template…'], ['templates', 'New board from template…'], ['links', 'Connect boards…']);
        if (isAdmin()) items.push(['forms', 'Forms…']);
        if (canWrite()) items.push(['bin', 'Recycle bin']);
        if (isAdmin()) items.push(['del-board', S().confirmBoard === b.id ? 'Click again to delete this board' : 'Delete board', true]);
        if (!items.length) return;
        showMenu(t, items); break;
      }
      case 'dup': closeMenu(); if (b) openModal({ type: 'duplicate', title: 'Duplicate', board: b.id, name: b.name, count: S().items.length, withItems: false }); break;
      case 'dup-go': {
        const m = M, name = document.getElementById('fx-dup-name').value.trim(), withItems = (layer.querySelector('input[name="fx-dup-items"]:checked') || {}).value === '1';
        m.busy = true; renderModal();
        api('POST', '/api/x/board/duplicate', { board: m.board, name, withItems }).then(r => { closeModal(); toast(`Made “${r.name}”${withItems ? ` with ${r.items} items` : ''}`); setTimeout(() => window.SolverOpen && window.SolverOpen(r.id), 400); }).catch(err => { m.busy = false; m.err = err.message; renderModal(); });
        break;
      }
      case 'save-tp': closeMenu(); if (b) openModal({ type: 'save-template', title: 'Save as template', board: b.id, name: b.name }); break;
      case 'tp-save': { const m = M; api('POST', '/api/x/templates', { board: m.board, name: document.getElementById('fx-tp-name').value }).then(r => { closeModal(); toast(`Saved template “${r.name}”`); }).catch(err => { m.err = err.message; renderModal(); }); break; }
      case 'templates': closeMenu(); openModal({ type: 'templates', title: 'Templates', list: null }); loadTemplates(); break;
      case 'tp-pick': M.pick = t.dataset.id; renderModal(); setTimeout(() => { const i = document.getElementById('fx-tp-new'); if (i) { i.focus(); i.select(); } }, 0); break;
      case 'tp-del': { const m = M, id = t.dataset.id; if (m.confirm !== id) { m.confirm = id; renderModal(); return; } api('DELETE', '/api/x/templates/' + id).then(() => { m.confirm = null; loadTemplates(); }).catch(err => { m.err = err.message; renderModal(); }); break; }
      case 'tp-use': {
        const m = M, s = S(), ws = (A().workspaces().find(w => w.id === s.ws)) || null;
        api('POST', '/api/x/templates/use', { id: m.pick, name: document.getElementById('fx-tp-new').value, workspace: ws }).then(r => { closeModal(); toast(`Made “${r.name}”`); setTimeout(() => window.SolverOpen && window.SolverOpen(r.id), 400); }).catch(err => { m.err = err.message; renderModal(); });
        break;
      }
      case 'links': closeMenu(); if (b) openModal({ type: 'links', title: 'Connect boards', board: b.id, mirRel: (b.columns.find(c => c.type === 'board_relation') || {}).id, mirRelBoard: ((b.columns.find(c => c.type === 'board_relation') || {}).boards || [])[0] }); break;
      case 'setup-col': {
        if (!b) return; const c = b.columns.find(x => x.id === t.dataset.col); if (!c) return;
        const rel = b.columns.find(x => x.type === 'board_relation' && (c.type === 'board_relation' ? x.id === c.id : true));
        openModal({ type: 'links', title: 'Connect boards', board: b.id, col: c.id, relBoard: (c.boards || [])[0], mirRel: c.relation || (rel || {}).id, mirRelBoard: ((rel || {}).boards || [])[0] }); break;
      }
      case 'rel-add': {
        const m = M, bb = S().boards.find(x => x.id === m.board), target = document.getElementById('fx-rel-board').value; if (!bb || !target) return;
        const editing = m.col && bb.columns.find(c => c.id === m.col && c.type === 'board_relation');
        const title = editing ? editing.title : (document.getElementById('fx-rel-title').value || '').trim(); if (!title) { m.err = 'Give the column a name.'; renderModal(); return; }
        const columns = editing ? bb.columns.map(c => c.id === m.col ? { ...c, boards: [target] } : c) : [...bb.columns, { id: newColId(), title, type: 'board_relation', boards: [target] }];
        A().patchBoard({ columns }); A().localBoard({ columns }); m.col = null; m.err = ''; m.mirRel = m.mirRel || columns.find(c => c.type === 'board_relation').id; m.mirRelBoard = m.mirRelBoard || target; toast(editing ? 'Saved' : `Added ${title}`); L.board = null; renderModal(); break;
      }
      case 'mir-add': {
        const m = M, bb = S().boards.find(x => x.id === m.board); if (!bb) return;
        const rel = document.getElementById('fx-mir-rel').value, mc = document.getElementById('fx-mir-col').value; if (!rel || !mc) { m.err = 'Pick the connect column and the column to show.'; renderModal(); return; }
        const editing = m.col && bb.columns.find(c => c.id === m.col && c.type === 'mirror');
        const title = editing ? editing.title : (document.getElementById('fx-mir-title').value || '').trim(); if (!title) { m.err = 'Give the column a name.'; renderModal(); return; }
        const columns = editing ? bb.columns.map(c => c.id === m.col ? { ...c, relation: rel, mirror: mc } : c) : [...bb.columns, { id: newColId(), title, type: 'mirror', relation: rel, mirror: mc, readonly: true }];
        A().patchBoard({ columns }); A().localBoard({ columns }); m.col = null; m.err = ''; toast(editing ? 'Saved' : `Added ${title}`); L.board = null; renderModal(); break;
      }
      case 'pick-links': {
        if (!b) return; const c = b.columns.find(x => x.id === t.dataset.col), item = A().itemById(t.dataset.item); if (!c || !item) return;
        const target = (c.boards || [])[0], cur = Array.isArray((item.values || {})[c.id]) ? item.values[c.id] : [];
        openModal({ type: 'pick-links', title: 'Link items', target, item: item.id, col: c.id, q: '', list: null, sel: new Set(cur.filter(x => x.b === target).map(x => x.i)), other: cur.filter(x => x.b !== target) });
        loadPick(); setTimeout(() => { const i = document.getElementById('fx-lk-q'); if (i) i.focus(); }, 0); break;
      }
      case 'lk-save': { const m = M; const v = [...m.other, ...[...m.sel].map(i => ({ b: m.target, i }))]; closeModal(); A().setValue(m.item, m.col, v.length ? v : ''); refreshLinks(); break; }
      case 'forms': closeMenu(); if (b) { openModal({ type: 'forms', title: 'Forms', board: b.id, list: null }); loadForms(); } break;
      case 'form-new': M.edit = { title: (b && b.name) || 'Form', desc: '', group: ((b && b.groups[0]) || {}).id, thanks: 'Thanks! We got your answers.', questions: [{ col: 'name', q: 'Your name', required: true }] }; M.err = ''; renderModal(); break;
      case 'form-monday': { const m = M; api('POST', '/api/x/forms', { board: m.board, fromMonday: true }).then(f => { m.list = null; loadForms(); m.edit = f; renderModal(); toast('Made a form from the Monday form. Check it, then share the link.'); }).catch(err => { m.err = err.message; renderModal(); }); break; }
      case 'form-edit': { const f = (M.list || []).find(x => x.id === t.dataset.id); if (f) { M.edit = JSON.parse(JSON.stringify(f)); M.err = ''; renderModal(); } break; }
      case 'form-back': M.edit = null; M.err = ''; renderModal(); break;
      case 'form-save': {
        const m = M, body = readForm();
        (m.edit.id ? api('PATCH', '/api/x/forms/' + m.edit.id, body) : api('POST', '/api/x/forms', { board: m.board, ...body })).then(() => { m.edit = null; m.err = ''; toast('Form saved'); loadForms(); renderModal(); }).catch(err => { m.err = err.message; renderModal(); });
        break;
      }
      case 'form-toggle': { const m = M, f = (m.list || []).find(x => x.id === t.dataset.id); if (!f) return; api('PATCH', '/api/x/forms/' + f.id, { active: !f.active }).then(() => { toast(f.active ? 'Form turned off: the link now says it’s closed' : 'Form is open again'); loadForms(); }).catch(err => toast(err.message)); break; }
      case 'form-del': { const m = M, id = t.dataset.id; if (m.confirm !== id) { m.confirm = id; renderModal(); return; } api('DELETE', '/api/x/forms/' + id).then(() => { m.confirm = null; loadForms(); }).catch(err => toast(err.message)); break; }
      case 'form-copy': { const l = t.dataset.link; (navigator.clipboard ? navigator.clipboard.writeText(l) : Promise.reject()).then(() => toast('Link copied')).catch(() => toast('Select the link and copy it')); break; }
      case 'bin': closeMenu(); openBin(); break;
      case 'restore': {
        const m = M, id = t.dataset.id, x = (m.items || []).find(y => y.id === id);
        t.disabled = true;
        api('POST', '/api/x/bin/restore', { id }).then(r => { toast(`Restored ${x ? '“' + x.name + '”' : ''}`); openBin(); if (x && x.kind !== 'group' && window.SolverOpen) setTimeout(() => { closeModal(); window.SolverOpen(r.board, r.item || null); }, 500); }).catch(err => { m.err = err.message; t.disabled = false; renderModal(); });
        break;
      }
      case 'forget': { const m = M, id = t.dataset.id; if (m.confirm !== id) { m.confirm = id; renderModal(); return; } api('POST', '/api/x/bin/forget', { id }).then(() => openBin()).catch(err => toast(err.message)); break; }
      case 'del-board': {
        if (!b) return; const s = S();
        if (s.confirmBoard !== b.id) { s.confirmBoard = b.id; closeMenu(); showMenu(document.querySelector('[data-fx="board-menu"]') || t, [['del-board', `Click again to delete “${b.name}”`, true]]); return; }
        s.confirmBoard = null; closeMenu();
        const id = b.id, name = b.name;
        window.KS.api('DELETE', '/api/doc?path=' + encodeURIComponent('boards/' + id)).then(() => {
          toastAction(`Deleted “${name}”`, 'Undo', () => api('GET', '/api/x/bin').then(r => { const x = r.items.find(y => y.kind === 'board' && y.board === id); if (!x) throw new Error('It’s no longer in the recycle bin.'); return api('POST', '/api/x/bin/restore', { id: x.id }); }).then(() => { toast('Board restored'); setTimeout(() => window.SolverOpen && window.SolverOpen(id), 600); }).catch(err => toast(err.message)), 12000);
          s.page = 'home'; A().savePage(); A().render();
        }).catch(err => toast(err.message));
        break;
      }
      case 'timer': {
        const item = t.dataset.item, col = t.dataset.col, act = t.dataset.actT; t.disabled = true;
        api('POST', '/api/x/time', { board: b.id, item, col, action: act }).then(r => { const i = A().itemById(item); if (i) { i.values = { ...(i.values || {}), [col]: r.value }; A().scheduleRender(); } toast(act === 'start' ? 'Timer started' : `Stopped · ${fmtDur(r.total)} in total`); }).catch(err => { t.disabled = false; toast(err.message); });
        break;
      }
      case 'sess-edit': editSess = t.dataset.s; A().renderLayer(); break;
      case 'sess-cancel': editSess = null; A().renderLayer(); break;
      case 'sess-save': {
        const s = t.dataset.s, st = document.getElementById('fx-ts-' + s), en = document.getElementById('fx-te-' + s);
        api('POST', '/api/x/time', { board: b.id, item: t.dataset.item, col: t.dataset.col, action: 'edit', session: s, start: new Date(st.value).toISOString(), end: en ? new Date(en.value).toISOString() : null })
          .then(r => { editSess = null; const i = A().itemById(t.dataset.item); if (i) i.values = { ...(i.values || {}), [t.dataset.col]: r.value }; A().renderLayer(); toast('Saved'); }).catch(err => toast(err.message));
        break;
      }
      case 'sess-del': {
        if (!confirm('Delete this time entry?')) return;
        api('POST', '/api/x/time', { board: b.id, item: t.dataset.item, col: t.dataset.col, action: 'delete', session: t.dataset.s }).then(r => { const i = A().itemById(t.dataset.item); if (i) i.values = { ...(i.values || {}), [t.dataset.col]: r.value }; A().renderLayer(); }).catch(err => toast(err.message));
        break;
      }
      case 'sess-add': openModal({ type: 'sess-add', title: 'Add time', board: b.id, item: t.dataset.item, col: t.dataset.col }); break;
      case 'add-go': {
        const m = M, s = document.getElementById('fx-add-s').value, en = document.getElementById('fx-add-e').value;
        if (!s || !en) { m.err = 'Enter a start and an end.'; renderModal(); return; }
        api('POST', '/api/x/time', { board: m.board, item: m.item, col: m.col, action: 'add', start: new Date(s).toISOString(), end: new Date(en).toISOString() }).then(r => { const i = A().itemById(m.item); if (i) i.values = { ...(i.values || {}), [m.col]: r.value }; closeModal(); A().renderLayer(); toast('Time added'); }).catch(err => { m.err = err.message; renderModal(); });
        break;
      }
    }
  });
  document.addEventListener('change', e => {
    if (!M) return; const t = e.target;
    if (M.type === 'activity' && t.id && t.id.startsWith('fx-f-')) { M.f[t.id.slice(5)] = t.value; loadActivity(true); }
    if (M.type === 'links' && t.id === 'fx-mir-rel') { const bb = S().boards.find(x => x.id === M.board), rc = bb && bb.columns.find(c => c.id === t.value); M.mirRel = t.value; M.mirRelBoard = ((rc || {}).boards || [])[0]; renderModal(); }
    if (M.type === 'pick-links' && t.dataset.fxLk) { t.checked ? M.sel.add(t.dataset.fxLk) : M.sel.delete(t.dataset.fxLk); const btn = layer.querySelector('[data-fx="lk-save"]'); if (btn) btn.textContent = `Save · ${M.sel.size} linked`; }
  });
  let pickTimer = null;
  document.addEventListener('input', e => {
    if (e.target.id === 'fx-q') { SR.q = e.target.value; runSearch(); }
    if (e.target.id === 'fx-lk-q' && M) { M.q = e.target.value; clearTimeout(pickTimer); pickTimer = setTimeout(loadPick, 200); }
  });
  const typing = el => el && el.matches && el.matches('input, textarea, select, [contenteditable="true"]');
  window.addEventListener('keydown', e => {
    if (M && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeModal(); return; }
    if (menu && e.key === 'Escape') { e.stopPropagation(); closeMenu(); return; }
    if (M && M.type === 'search') {
      const n = flatResults().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); SR.sel = Math.min(n - 1, SR.sel + 1); paintResults(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); SR.sel = Math.max(0, SR.sel - 1); paintResults(); }
      else if (e.key === 'Enter' && e.target.id === 'fx-q') { e.preventDefault(); e.stopPropagation(); openResult(SR.sel); }
      return;
    }
    if (M) return;
    if (((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing(e.target))) { e.preventDefault(); openSearch(); return; }
    if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !typing(e.target) && A().S.page === 'board') { e.preventDefault(); undoLast(); }
  }, true);

  // live: linked items changed (on a board this person can see) -> mirrors refresh; items here changed -> history refresh
  function wire() {
    if (!window.KS || !window.KS.on) return setTimeout(wire, 300);
    window.KS.on('change', ev => {
      const b = A() && A().board(); if (!b) return;
      const m = /^boards\/([^/]+)\/items$/.exec(ev.col || ''); if (!m) return;
      if (relCols(b).length && (m[1] === b.id || L.targets.has(m[1]))) refreshLinks();
      if (m[1] === b.id && HC.has(ev.id)) HC.get(ev.id).stale = true;
    });
  }
  wire();
  // the page's board changed: drop the links of the previous board
  let lastBoard = null;
  setInterval(() => { const s = A() && A().S; if (s && s.boardId !== lastBoard) { lastBoard = s.boardId; L.items = {}; L.board = null; } }, 500);

  // new column types in "+ Column"
  function addTypes() { const T = A() && A().TYPES; if (!T) return setTimeout(addTypes, 200); T.board_relation = 'Connect boards'; T.mirror = 'Mirror'; T.time_tracking = 'Time tracking'; }
  addTypes();

  window.SolverFeatures = { cell, describe, head, railTop, railBottom, homeTop, historyTab, deleted, bulkEdited, deleteGroup, openSearch };
  // the page rendered before this file loaded: render again so the hooks show up
  setTimeout(() => { try { A() && A().render(); } catch (e) {} }, 0);
})();
