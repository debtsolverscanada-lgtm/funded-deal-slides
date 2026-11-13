// Email sequences screens: the admin list + editor, and a lead's own sequences (see sequences.js on the server).
(() => {
  'use strict';
  const A = () => window.SolverApp || {}, S = () => A().S || {};
  const api = (m, u, b) => window.KS.api(m, u, b);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const toast = m => (A().toast || alert)(m);
  let root = null, state = {};
  const boards = () => (S().boards || []);
  const bname = id => (boards().find(b => b.id === id) || {}).name || id;
  const fullBoard = id => (A().S && A().S.boards || []).find(b => b.id === id);

  function shell(html) {
    if (!root) { root = document.createElement('div'); root.id = 'seqm'; document.body.appendChild(root); root.addEventListener('click', onClick); root.addEventListener('change', onChange); }
    const ae = document.activeElement; if (!root.firstChild && ae && ae !== document.body) back = ae; // focus goes back here on close
    root.innerHTML = `<div class="sq-wrap"><div class="sq-modal" role="dialog" aria-modal="true" tabindex="-1" style="outline:none"><button class="sq-x" data-sq="close" aria-label="Close" title="Close">✕</button>${html}</div></div>`;
    const m = root.querySelector('.sq-modal'), h = m.querySelector('h3'); if (h) m.setAttribute('aria-label', h.textContent.trim());
    if (!m.contains(document.activeElement)) m.focus({ preventScroll: true }); // keyboard users land inside the window
    document.documentElement.classList.add('sq-open');
  }
  let back = null;
  const close = () => { if (root) { root.remove(); root = null; } state = {}; document.documentElement.classList.remove('sq-open'); if (back && back.isConnected) back.focus({ preventScroll: true }); back = null; };
  // capture phase + stopPropagation: Esc closes only this popup, not the lead drawer under it
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root) { e.preventDefault(); e.stopPropagation(); askClose(); } }, true);

  const trig = s => { const t = s.trigger || {}; const b = fullBoard(s.boards[0]) || {};
    if (t.type === 'created') return 'When a new lead comes in' + (t.inGroup ? ` (in ${esc(((b.groups || []).find(g => g.id === t.inGroup) || {}).name || 'a group')})` : '');
    if (t.type === 'status') return `When ${esc(((b.columns || []).find(c => c.id === t.col) || {}).title || 'Status')} changes to “${esc(t.label)}”`;
    if (t.type === 'group') return `When a lead is moved to “${esc(((b.groups || []).find(g => g.id === t.group) || {}).name || t.group)}”`;
    return 'Only when someone adds a lead by hand'; };
  const wait = st => st.waitDays || st.waitHours ? `wait ${st.waitDays ? st.waitDays + ' day' + (st.waitDays > 1 ? 's' : '') : ''}${st.waitDays && st.waitHours ? ' ' : ''}${st.waitHours ? st.waitHours + ' h' : ''}` : 'right away';

  // ---------- admin list ----------
  async function openList() {
    shell('<h3>Email sequences</h3><p>Loading…</p>');
    try { const d = await api('GET', '/api/seq'); state = { view: 'list', list: d.sequences, paused: d.paused }; drawList(); } catch (e) { shell(`<h3>Email sequences</h3><p class="em-warn">${esc(e.message)}</p><div class="form-row"><button class="btn" data-sq="close">Close</button></div>`); }
  }
  function drawList() {
    const byBoard = {}; for (const s of state.list) { const k = s.boards.map(bname).join(', '); (byBoard[k] = byBoard[k] || []).push(s); }
    const card = s => `<div class="sq-card${s.active ? ' on' : ''}">
        <div class="sq-row1"><b>${esc(s.name)}</b><label class="sq-switch" title="${s.active ? 'On: sending' : 'Off'}"><input type="checkbox" data-sq="toggle" data-id="${esc(s.id)}" ${s.active ? 'checked' : ''}><span></span></label></div>
        <div class="sq-meta">${trig(s)} · ${s.steps.length} email${s.steps.length > 1 ? 's' : ''} · from ${esc(s.from || 'the board’s rep')}</div>
        ${s.note ? `<div class="sq-note">${esc(s.note)}</div>` : ''}
        <div class="sq-row2"><span>${s.counts.active} in it · ${s.counts.done} finished · ${s.counts.stopped} stopped</span><span><button class="btn" data-sq="people" data-id="${esc(s.id)}">People</button><button class="btn" data-sq="edit" data-id="${esc(s.id)}">Edit</button></span></div></div>`;
    shell(`<div class="sq-head"><h3>Email sequences</h3><button class="btn primary" data-sq="new">+ New sequence</button></div>
      ${state.paused ? '<p class="em-warn">All sequences are paused on the server (SEQUENCES=off).</p>' : ''}
      <p class="rail-note" style="margin-top:0">Copied from Monday. They start <b>off</b>: turn one on only after you turn its twin off in Monday, or leads get every email twice.</p>
      ${Object.keys(byBoard).map(k => `<h4 class="sq-board">${esc(k)}</h4>${byBoard[k].map(card).join('')}`).join('') || '<p class="rail-note">No sequences yet.</p>'}
      <div class="form-row"><button class="btn" data-sq="close">Close</button></div>`);
  }
  async function openPeople(id) {
    const s = state.list.find(x => x.id === id); shell(`<h3>${esc(s.name)}</h3><p>Loading…</p>`);
    const d = await api('GET', `/api/seq/${encodeURIComponent(id)}/enrolled`);
    const st = r => r.status === 'active' ? `<span class="app-st set">Email ${r.step + 1} of ${r.of} next</span>` : r.status === 'done' ? '<span class="app-st on">Finished</span>' : `<span class="app-st off">Stopped</span> <small>${esc(r.reason || '')}</small>`;
    shell(`<h3>${esc(s.name)} · people</h3><div class="sq-people">${d.rows.map(r => `<div class="sq-person"><button class="linkish" data-sq="openlead" data-b="${esc(r.board)}" data-i="${esc(r.item)}">${esc(r.name)}</button> <small>${esc(bname(r.board))}</small> ${st(r)}${r.status === 'active' ? ` <button class="btn" data-sq="stop" data-id="${esc(r.id)}" data-back="${esc(id)}">Stop</button>` : ''}</div>`).join('') || '<p class="rail-note">Nobody yet.</p>'}</div>
      <div class="form-row"><button class="btn" data-sq="back">‹ Back</button></div>`);
  }

  // ---------- editor ----------
  function openEdit(id) {
    const s = id ? JSON.parse(JSON.stringify(state.list.find(x => x.id === id))) : { id: 'seq_' + Math.random().toString(36).slice(2, 10), name: '', boards: [S().boardId].filter(Boolean), trigger: { type: 'created' }, from: '', footer: true, stopOnReply: true, steps: [{ waitDays: 0, waitHours: 0, subject: '', body: '' }], active: false, _new: true };
    state.view = 'edit'; state.edit = s; drawEdit(); readForm(); state.orig = JSON.stringify(s);
  }
  function drawEdit() {
    const s = state.edit, b = fullBoard(s.boards[0]) || { columns: [], groups: [] };
    const statusCols = (b.columns || []).filter(c => c.type === 'status'), sc = statusCols.find(c => c.id === s.trigger.col) || statusCols[0];
    const opt = (v, cur, label) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
    const bl = boards().filter(x => !/mortgage\s*solver/i.test(((x.workspace || {}).name) || ''));
    shell(`<h3>${s._new ? 'New sequence' : 'Edit sequence'}</h3>
      <div class="sq-form">
        <label class="int-field"><span>Name</span><input class="field-input" data-f="name" value="${esc(s.name)}" placeholder="e.g. New lead welcome"></label>
        <div class="int-field"><span>Boards</span><div class="sq-boards">${bl.map(x => `<label class="int-ev"><input type="checkbox" data-f="board" value="${esc(x.id)}" ${s.boards.includes(x.id) ? 'checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div></div>
        <label class="int-field"><span>Starts</span><select class="field-input" data-f="ttype">${opt('created', s.trigger.type, 'When a new lead comes in')}${opt('status', s.trigger.type, 'When a status changes to…')}${opt('group', s.trigger.type, 'When a lead is moved to a group…')}${opt('manual', s.trigger.type, 'Only when someone adds a lead by hand')}</select></label>
        ${s.trigger.type === 'status' ? `<div class="sq-2"><select class="field-input" data-f="tcol">${statusCols.map(c => opt(c.id, sc && sc.id, c.title)).join('')}</select><select class="field-input" data-f="tlabel">${((sc && sc.labels) || []).map(l => opt(l.label, s.trigger.label, l.label)).join('')}</select></div>` : ''}
        ${s.trigger.type === 'group' ? `<select class="field-input" data-f="tgroup">${(b.groups || []).map(g => opt(g.id, s.trigger.group, g.name)).join('')}</select>` : ''}
        <label class="int-field"><span>Sent from</span><input class="field-input" data-f="from" value="${esc(s.from)}" placeholder="Leave empty: each board’s own rep"></label>
        <label class="int-ev"><input type="checkbox" data-f="stopOnReply" ${s.stopOnReply ? 'checked' : ''}><span>Stop when the lead replies</span></label>
        <label class="int-ev"><input type="checkbox" data-f="footer" ${s.footer ? 'checked' : ''}><span>Add the “reply UNSUBSCRIBE” line (marketing emails)</span></label>
        <div class="int-field"><span>Emails</span>${s.steps.map((st, k) => `<div class="sq-step"><div class="sq-step-h"><b>Email ${k + 1}</b><span>Wait <input class="field-input sq-n" type="number" min="0" data-f="wd" data-k="${k}" value="${st.waitDays}"> days <input class="field-input sq-n" type="number" min="0" max="23" data-f="wh" data-k="${k}" value="${st.waitHours}"> h ${k ? 'after the last one' : 'after it starts'}</span>${s.steps.length > 1 ? `<button class="btn" data-sq="rmstep" data-k="${k}">Remove</button>` : ''}</div>
            <input class="field-input" data-f="subject" data-k="${k}" value="${esc(st.subject)}" placeholder="Subject">
            <textarea class="field-input" rows="7" data-f="body" data-k="${k}" placeholder="Hi {first name}, …">${esc(st.body)}</textarea></div>`).join('')}
          <button class="btn" data-sq="addstep">+ Add an email</button>
          <p class="rail-note">Use {first name}, {name} or {rep}. Monday’s {pulse.name} works too.</p></div>
      </div>
      <p class="em-warn" id="sq-msg" hidden></p>
      <div class="form-row"><button class="btn primary" data-sq="save">Save</button>${s._new ? '' : '<button class="btn" data-sq="delete">Delete</button>'}<button class="btn" data-sq="back">Cancel</button></div>`);
  }
  function readForm() {
    const s = state.edit; if (!root) return;
    root.querySelectorAll('[data-f]').forEach(el => {
      const f = el.dataset.f, k = Number(el.dataset.k);
      if (f === 'name' || f === 'from') s[f] = el.value;
      else if (f === 'stopOnReply' || f === 'footer') s[f] = el.checked;
      else if (f === 'wd') s.steps[k].waitDays = Number(el.value) || 0;
      else if (f === 'wh') s.steps[k].waitHours = Number(el.value) || 0;
      else if (f === 'subject' || f === 'body') s.steps[k][f] = el.value;
      else if (f === 'tcol') s.trigger.col = el.value;
      else if (f === 'tlabel') s.trigger.label = el.value;
      else if (f === 'tgroup') s.trigger.group = el.value;
    });
    s.boards = [...root.querySelectorAll('[data-f="board"]:checked')].map(x => x.value);
    s.steps.forEach(st => { const h = Math.max(0, Math.floor(st.waitDays)) * 24 + Math.max(0, Math.floor(st.waitHours)); st.waitDays = Math.floor(h / 24); st.waitHours = h % 24; }); // 48 h is kept as 2 days
  }
  // redraw the editor without jumping back to the top
  const redrawKeepScroll = () => { const els = () => root ? [root.querySelector('.sq-wrap'), root.querySelector('.sq-modal')] : []; const tops = els().map(x => x ? x.scrollTop : 0); drawEdit(); els().forEach((x, i) => { if (x) x.scrollTop = tops[i]; }); };
  // closing by Esc or a click outside asks first when the editor has unsaved changes
  const askClose = () => { if (state.view === 'edit' && root) { readForm(); if (JSON.stringify(state.edit) !== state.orig && !confirm('Discard your unsaved changes to this sequence?')) return; } close(); };

  // ---------- a lead's sequences ----------
  async function openLead(bid, iid) {
    shell('<h3>Sequences</h3><p>Loading…</p>');
    try { const d = await api('GET', `/api/seq/item?board=${encodeURIComponent(bid)}&item=${encodeURIComponent(iid)}`); state = { view: 'lead', bid, iid, data: d }; drawLead(); }
    catch (e) { shell(`<h3>Sequences</h3><p class="em-warn">${esc(e.message)}</p><div class="form-row"><button class="btn" data-sq="close">Close</button></div>`); }
  }
  function drawLead() {
    const d = state.data, item = (A().itemById || (() => null))(state.iid);
    const st = r => r.status === 'active' ? (r.active ? `<span class="app-st set">Email ${r.step + 1} of ${r.of} next</span>` : '<span class="app-st off">Sequence is off</span>') : r.status === 'done' ? '<span class="app-st on">Finished</span>' : `<span class="app-st off">Stopped</span> <small>${esc(r.reason || '')}</small>`;
    const used = new Set(d.rows.filter(r => !(r.status === 'stopped' && !r.step && r.reason === 'no sending address for this board')).map(r => r.seq)), avail = d.available.filter(s => !used.has(s.id));
    shell(`<h3>Sequences · ${esc(item ? item.name : '')}</h3>
      ${d.rows.map(r => `<div class="sq-person"><b>${esc(r.name)}</b> ${st(r)}${r.status === 'active' ? ` <button class="btn" data-sq="stop" data-id="${esc(r.id)}">Stop</button>` : ''}</div>`).join('') || '<p class="rail-note">Not in any sequence.</p>'}
      ${avail.length ? `<div class="sq-2" style="margin-top:12px"><select class="field-input" id="sq-add">${avail.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.active ? '' : ' (off)'}</option>`).join('')}</select><button class="btn primary" data-sq="enroll">Add to sequence</button></div>` : ''}
      <div class="form-row"><button class="btn" data-sq="close">Close</button></div>`);
  }

  // ---------- clicks ----------
  async function onClick(e) {
    const t = e.target.closest('[data-sq]'); if (!t) { if (e.target.classList.contains('sq-wrap')) askClose(); return; }
    const a = t.dataset.sq;
    try {
      if (a === 'close') close();
      else if (a === 'new') openEdit(null);
      else if (a === 'edit') openEdit(t.dataset.id);
      else if (a === 'people') openPeople(t.dataset.id);
      else if (a === 'back') { if (state.view === 'lead') close(); else openList(); }
      else if (a === 'addstep') { readForm(); state.edit.steps.push({ waitDays: 1, waitHours: 0, subject: '', body: '' }); redrawKeepScroll(); const st = [...root.querySelectorAll('.sq-step')].pop(); if (st) { st.scrollIntoView({ block: 'nearest' }); const f = st.querySelector('[data-f="subject"]'); if (f) f.focus({ preventScroll: true }); } }
      else if (a === 'rmstep') { readForm(); state.edit.steps.splice(Number(t.dataset.k), 1); redrawKeepScroll(); }
      else if (a === 'save') {
        if ([...root.querySelectorAll('[data-f="wd"],[data-f="wh"]')].some(x => Number(x.value) < 0)) throw new Error('Waits can’t be negative.');
        readForm(); const s = state.edit, { id, _new, counts, updatedAt, ...body } = s;
        await api('PUT', `/api/seq/${encodeURIComponent(id)}`, body); toast('Sequence saved.'); openList();
      } else if (a === 'delete') { if (!confirm('Delete this sequence? Anyone in it stops getting its emails.')) return; await api('DELETE', `/api/seq/${encodeURIComponent(state.edit.id)}`); toast('Deleted.'); openList(); }
      else if (a === 'stop') { if (!confirm('Stop this lead’s emails from this sequence?')) return; await api('POST', '/api/seq/stop', { id: t.dataset.id }); toast('Stopped.'); if (state.view === 'lead') openLead(state.bid, state.iid); else openPeople(t.dataset.back); }
      else if (a === 'enroll') { const r = await api('POST', '/api/seq/enroll', { seq: root.querySelector('#sq-add').value, board: state.bid, item: state.iid }); toast(r.active ? 'Added. The first email goes out on schedule.' : 'Added, but that sequence is off, so nothing sends until an admin turns it on.'); openLead(state.bid, state.iid); }
      else if (a === 'openlead') { const b = t.dataset.b, i = t.dataset.i; close(); window.SolverOpen && window.SolverOpen(b, i); }
    } catch (err) { const m = root && root.querySelector('#sq-msg'); if (m) { m.hidden = false; m.textContent = err.message; } else toast(err.message); }
  }
  async function onChange(e) {
    const t = e.target;
    if (t.dataset.sq === 'toggle') {
      const s = state.list.find(x => x.id === t.dataset.id);
      if (t.checked && !confirm(`Turn on “${s.name}”?\n\nIf Monday is still sending this same email, turn it off in Monday first, or leads will get it twice.`)) { t.checked = false; return; }
      try { await api('POST', `/api/seq/${encodeURIComponent(s.id)}/active`, { active: t.checked }); s.active = t.checked; toast(t.checked ? 'On. It sends to new matches from now on.' : 'Off.'); drawList(); } catch (err) { t.checked = !t.checked; toast(err.message); }
    } else if (state.view === 'edit' && ['ttype', 'tcol', 'board'].includes(t.dataset.f)) {
      readForm(); if (t.dataset.f === 'ttype') state.edit.trigger = { type: t.value }; drawEdit();
    }
  }
  window.SolverSeq = { openList, openLead };
})();
