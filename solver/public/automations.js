// Solver.ca automation editor: list, create, edit, duplicate, switch on/off and delete a board's rules with a
// sentence builder ("When [trigger] and only if [condition…] then [action] and [action…]"), plus each rule's run log.
// Rules copied from Monday show here too and can be edited. The rules themselves run in the page's engine
// (index.html) and on the server for API changes and date reminders; the server checks every rule on save.
(() => {
  'use strict';
  const A = () => window.SolverApp;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rid = p => p + Math.random().toString(36).slice(2, 10);
  const fmt = iso => { try { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };

  const TRIG = {
    status: 'a status changes', column: 'a column changes', created: 'an item is created', moved_group: 'an item moves to a group',
    button: 'a button is pressed', date_arrives: 'a date arrives', sub_status: 'a subitem’s status changes', moved_board: 'an item is moved here from another board',
    monday_only: 'something happens in Monday (logged only)',
  };
  const ACT = {
    move_group: 'move it to a group', set_status: 'set a status', set_value: 'set a column', set_date: 'set a date', clear: 'clear a column',
    assign: 'assign someone', create_update: 'post an update', move_board: 'move it to another board', copy_to_board: 'copy it to another board',
    duplicate: 'duplicate it', notify: 'notify someone in Solver.ca', webhook: 'send to a connected tool (webhook)', external: 'a Monday-only action (logged only)',
  };
  const SUB_ACT = ['set_status', 'set_value', 'set_date', 'clear'];
  const COND = { status_is: 'a status is', is: 'a column is', is_not: 'a column is not', empty: 'a column is empty', not_empty: 'a column is not empty', contains: 'a column contains', has_person: 'a person is', group: 'the group is' };
  const NOT_SETTABLE = ['formula', 'button', 'item_id', 'created', 'ai'];
  const RUNS_HERE = ['move_group', 'set_status', 'set_value', 'set_date', 'clear', 'assign', 'create_update', 'move_board', 'copy_to_board', 'duplicate', 'notify', 'webhook'];

  // ---------- helpers on the board ----------
  const cols = b => b.columns || [];
  const col = (b, id, sub) => (sub ? (b.subColumns || []) : cols(b)).find(c => c.id === id);
  const labelName = (c, v) => { const l = c && (c.labels || []).find(x => x.id === String(v)); return l ? l.label : String(v ?? ''); };
  const groupName = (b, g) => g === '__top__' ? 'the top group' : ((b.groups || []).find(x => x.id === g) || {}).name || 'a deleted group';
  const boardName = id => ((A().S.boards || []).find(x => x.id === id) || {}).name || 'a board that isn’t here';
  const condKind = c => c.col === '__group' ? 'group' : (c.op || 'is') === 'is' ? 'status_is_or_is' : c.op;
  const tok = s => `<span class="tok">${esc(s)}</span>`;
  const valText = (c, v) => Array.isArray(v) ? v.map(x => labelName(c, x)).join(' or ') : c && c.type === 'status' ? labelName(c, v) : v === true ? 'checked' : String(v ?? '');
  function parseWhen(w) {
    const s = String(w || ''), m = /^(\d+) day\(s\) (before|after) the date/.exec(s), t = /at (\d{1,2}:\d{2})\s*(.*)$/.exec(s);
    return { n: m ? Number(m[1]) : 0, dir: m ? m[2] : 'on', time: t ? t[1].padStart(5, '0') : '09:00', tz: t ? t[2].trim() : '' };
  }
  const makeWhen = d => `${d.dir === 'on' || !Number(d.n) ? 'on the date' : `${Number(d.n)} day(s) ${d.dir} the date`}, at ${d.time || '09:00'}${d.tz ? ' ' + d.tz : ''}`;

  // ---------- the sentence for a rule ----------
  function sentence(b, r) {
    r = A().normRule(r);
    const sub = r.trigger === 'sub_status';
    const c = col(b, r.col, sub);
    let when;
    switch (r.trigger) {
      case 'status': when = `${tok(c ? c.title : 'a deleted column')} changes${r.value != null && r.value !== '' ? ' to ' + tok(labelName(c, r.value)) : ''}`; break;
      case 'column': when = `${tok(c ? c.title : 'a deleted column')} changes${r.value != null && r.value !== '' ? ' to ' + tok(valText(c, r.value)) : ''}`; break;
      case 'created': when = `an item is created${r.group ? ' in ' + tok(groupName(b, r.group)) : ''}`; break;
      case 'moved_group': when = r.group ? `an item moves to ${tok(groupName(b, r.group))}` : 'an item moves to any group'; break;
      case 'button': when = `${tok(c ? c.title : 'a deleted button')} is pressed`; break;
      case 'date_arrives': when = `${tok(c ? c.title : 'a deleted date')} arrives (${esc(r.when || 'on the date')})`; break;
      case 'sub_status': when = `a subitem’s ${tok(c ? c.title : 'status')} changes${r.value != null && r.value !== '' ? ' to ' + tok(labelName(c, r.value)) : ''}`; break;
      case 'moved_board': when = 'an item is moved here from another board'; break;
      default: when = esc(String(r.title || 'something happens in Monday').replace(/^when\s+/i, '').replace(/\s*→.*$/, ''));
    }
    const conds = (r.conditions || []).map(k => {
      if (k.col === '__group') return `the group ${k.op === 'is_not' ? 'is not' : 'is'} ${tok(groupName(b, k.value))}`;
      const kc = col(b, k.col), t = tok(kc ? kc.title : 'a deleted column');
      switch (k.op) {
        case 'empty': return `${t} is empty`; case 'not_empty': return `${t} is not empty`;
        case 'contains': return `${t} contains ${tok(k.value)}`; case 'has_person': return `${t} includes ${tok(valText(kc, k.value))}`;
        case 'is_not': case 'is_not_any': return `${t} is not ${tok(valText(kc, k.value))}`;
        default: return `${t} is ${tok(valText(kc, k.value))}`;
      }
    });
    const acts = (r.actions || []).map(a => {
      const ac = col(b, a.col, sub), ct = tok(ac ? ac.title : 'a deleted column');
      switch (a.type) {
        case 'move_group': return `move it to ${tok(groupName(b, a.group))}`;
        case 'set_status': return `set ${ct} to ${tok(labelName(ac, a.value))}`;
        case 'set_value': return `set ${ct} to ${tok(valText(ac, a.value))}`;
        case 'set_date': return `set ${ct} to ${tok(!a.offset ? 'today' : a.offset > 0 ? `today + ${a.offset} day${a.offset === 1 ? '' : 's'}` : `today − ${-a.offset} day${a.offset === -1 ? '' : 's'}`)}`;
        case 'clear': return `clear ${ct}`;
        case 'assign': return `assign ${tok(a.value)} in ${ct}`;
        case 'create_update': return `post the update ${tok(String(a.value || a.message || '').slice(0, 60))}`;
        case 'move_board': return `move it to ${tok(boardName(a.board))}`;
        case 'copy_to_board': return `copy it to ${tok(boardName(a.board))}`;
        case 'duplicate': return `duplicate it${a.withUpdates ? ' with its updates' : ''}`;
        case 'notify': return `notify ${tok(a.to || 'someone')}`;
        case 'webhook': return `send it to ${tok(hookName(a.hook))}`;
        default: return `${esc(a.label || a.type.replace(/_/g, ' '))} <span class="rx-muted">(Monday only, logged)</span>`;
      }
    });
    return `When ${when}${conds.length ? ', and only if ' + conds.join(' and ') : ''}, ${acts.length ? acts.join(', then ') : '<i>no actions yet</i>'}.`;
  }
  const plain = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim(); };
  let META = null;
  const hookName = id => { if (!id) return 'every connected tool listening'; const h = META && (META.hooks || []).find(x => x.id === id); return h ? h.name : 'a connected tool'; };
  function loadMeta() { if (META || !window.KS) return; KS.api('GET', '/api/automations/meta').then(m => { META = m; rerender(); }).catch(() => { META = { hooks: [] }; }); }
  const rerender = () => { const S = A().S; if (S.modal && S.modal.type === 'automations') A().renderLayer(); };

  // ---------- run log ----------
  const queue = []; let timer = null;
  function ruleRan(b, item, rule, texts) {
    if (!rule || !rule.id || !item || !window.KS) return;
    queue.push({ board: b.id, rule: rule.id, item: item.id, itemName: item.name, result: (texts && texts.length ? texts.join('; ') : 'Ran').slice(0, 500) });
    clearTimeout(timer); timer = setTimeout(flush, 1200);
  }
  function flush() {
    const byBoard = {}; queue.splice(0).forEach(r => { (byBoard[r.board] = byBoard[r.board] || []).push(r); });
    Object.entries(byBoard).forEach(([board, runs]) => KS.api('POST', '/api/automations/runs', { board, runs }).catch(() => {}));
  }
  function loadRuns(m, b) {
    KS.api('GET', '/api/automations/runs?board=' + encodeURIComponent(b.id) + (m.view === 'runs' ? '&rule=' + encodeURIComponent(m.ruleId) : '')).then(rows => {
      if (m.view === 'runs') m.runs = rows; else { m.last = {}; rows.forEach(r => { if (!m.last[r.rule]) m.last[r.rule] = r; }); }
      rerender();
    }).catch(e => { m.err = e.message; rerender(); });
  }

  // ---------- the draft (edit form state) ----------
  function toDraft(r, b) {
    r = JSON.parse(JSON.stringify(A().normRule(r)));
    if (!r.trigger) r.trigger = 'status';
    const d = { ...r, conditions: r.conditions || [], actions: r.actions || [] };
    if (d.trigger === 'date_arrives') Object.assign(d, { _when: parseWhen(d.when) });
    d._orig = JSON.stringify({ trigger: r.trigger, col: r.col, value: r.value, group: r.group, when: r.when, conditions: r.conditions || [], actions: r.actions || [] });
    delete d.label; delete d.action; delete d.target; delete d.targetCol; delete d.targetLabel; // old-style rules become the new shape
    return d;
  }
  function newDraft(b) {
    const sc = cols(b).find(c => c.type === 'status');
    return { id: rid('a'), on: true, title: '', trigger: sc ? 'status' : 'created', col: sc ? sc.id : undefined, value: sc && (sc.labels || [])[0] ? sc.labels[0].id : '', conditions: [], actions: [defaultAction(b, 'move_group')], _new: true, _orig: '' };
  }
  function defaultAction(b, type, sub) {
    const pick = t => (sub ? (b.subColumns || []) : cols(b)).find(c => (t ? c.type === t : !NOT_SETTABLE.includes(c.type) && !c.readonly));
    switch (type) {
      case 'move_group': return { type, group: ((b.groups || [])[0] || {}).id || '__top__' };
      case 'set_status': { const c = pick('status'); return { type, col: c && c.id, value: c && (c.labels || [])[0] ? c.labels[0].id : '' }; }
      case 'set_value': { const c = (sub ? (b.subColumns || []) : cols(b)).find(x => x.type !== 'status' && !NOT_SETTABLE.includes(x.type) && !x.readonly); return { type, col: c && c.id, value: '' }; }
      case 'set_date': { const c = pick('date'); return { type, col: c && c.id, offset: 0 }; }
      case 'clear': { const c = pick(); return { type, col: c && c.id }; }
      case 'assign': { const c = pick('person'); return { type, col: c && c.id, value: '' }; }
      case 'create_update': return { type, value: '' };
      case 'move_board': case 'copy_to_board': { const o = (A().S.boards || []).find(x => x.id !== b.id); return { type, board: o ? o.id : '', group: o && o.groups && o.groups[0] ? o.groups[0].id : '' }; }
      case 'duplicate': return { type, withUpdates: false };
      case 'notify': return { type, to: '', message: '' };
      case 'webhook': return { type, hook: '', note: '' };
      default: return { type };
    }
  }
  function triggerDefaults(d, b) {
    const pick = (t, sub) => (sub ? (b.subColumns || []) : cols(b)).find(c => c.type === t);
    delete d.col; delete d.value; delete d.group; delete d.when; delete d._when;
    if (d.trigger === 'status') { const c = pick('status'); d.col = c && c.id; d.value = ''; }
    if (d.trigger === 'column') { const c = cols(b).find(x => !['formula', 'button'].includes(x.type)); d.col = c && c.id; d.value = ''; }
    if (d.trigger === 'moved_group') d.group = ((b.groups || [])[0] || {}).id;
    if (d.trigger === 'button') { const c = pick('button'); d.col = c && c.id; }
    if (d.trigger === 'date_arrives') { const c = pick('date'); d.col = c && c.id; d._when = { n: 0, dir: 'on', time: '09:00', tz: '' }; }
    if (d.trigger === 'sub_status') { const c = pick('status', true); d.col = c && c.id; d.value = ''; d.actions = d.actions.filter(a => SUB_ACT.includes(a.type)); if (!d.actions.length) d.actions.push(defaultAction(b, 'set_status', true)); }
  }
  // the rule to save (internal fields dropped, empty ones removed)
  function fromDraft(d, b) {
    const r = {};
    for (const [k, v] of Object.entries(d)) if (!k.startsWith('_') && v !== undefined) r[k] = v;
    if (d.trigger === 'date_arrives') r.when = makeWhen(d._when || {});
    else delete r.when;
    if (!['status', 'column', 'sub_status', 'button', 'date_arrives'].includes(r.trigger)) delete r.col;
    if (!['status', 'column', 'sub_status'].includes(r.trigger) || r.value === '') delete r.value;
    if (!['created', 'moved_group'].includes(r.trigger) || !r.group) delete r.group;
    r.conditions = (d.conditions || []).map(c => { const x = { ...c }; delete x._kind; return x; });
    r.actions = (d.actions || []).map(a => ({ ...a }));
    const struct = JSON.stringify({ trigger: r.trigger, col: r.col, value: r.value, group: r.group, when: r.when, conditions: r.conditions, actions: r.actions });
    if (d._titleTouched && String(d.title || '').trim()) r.title = String(d.title).trim();
    else if (d._new || struct !== d._orig || !r.title) r.title = plain(sentence(b, { ...r, title: '' })).replace(/^When /, 'When ').replace(/\.$/, '').slice(0, 280);
    return r;
  }

  // ---------- form controls ----------
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
  const sel = (path, options, cur, aria) => `<select class="field-input" data-r="${esc(path)}" aria-label="${esc(aria || path)}">${options.map(([v, l]) => opt(v, l, String(v) === String(cur ?? ''))).join('')}</select>`;
  const inp = (path, val, ph, aria, extra = '') => `<input class="field-input" data-r="${esc(path)}" value="${esc(val ?? '')}" placeholder="${esc(ph || '')}" aria-label="${esc(aria || ph || path)}" ${extra}>`;
  const colOpts = (list, cur) => { const o = list.map(c => [c.id, c.title]); if (cur && !list.some(c => c.id === cur)) o.unshift([cur, '(deleted column)']); if (!o.length) o.push(['', '(no suitable column)']); return o; };
  const groupOpts = (b, any) => [...(any ? [['', 'any group']] : []), ['__top__', 'the top group'], ...(b.groups || []).map(g => [g.id, g.name])];
  function valueControl(path, b, c, cur, aria, allowAny) {
    if (c && c.type === 'status') return sel(path, [...(allowAny ? [['', 'anything']] : []), ...(c.labels || []).filter(l => !l.hidden || l.id === String(cur)).map(l => [l.id, l.label])], Array.isArray(cur) ? cur[0] : cur, aria);
    if (c && c.type === 'checkbox') return sel(path, [...(allowAny ? [['', 'anything']] : []), ['true', 'checked'], ['', 'unchecked']], cur === true ? 'true' : cur, aria);
    if (c && c.type === 'dropdown') return sel(path, [...(allowAny ? [['', 'anything']] : []), ...(c.options || []).map(o => [o, o])], cur, aria);
    if (c && c.type === 'date') return inp(path, cur, 'YYYY-MM-DD', aria, 'type="date"');
    if (c && c.type === 'person') return inp(path, cur, 'Name', aria, 'list="rx-people"');
    return inp(path, Array.isArray(cur) ? cur.join(', ') : cur, allowAny ? 'anything' : 'value', aria);
  }
  function renderEdit(m, b) {
    const d = m.edit, S = A().S, sub = d.trigger === 'sub_status';
    const fromMonday = d.source === 'monday';
    const trigOpts = Object.entries(TRIG).filter(([k]) => k !== 'monday_only' || d.trigger === 'monday_only').map(([k, l]) => [k, l]);
    let tp = '';
    const c = col(b, d.col, sub);
    switch (d.trigger) {
      case 'status': tp = sel('col', colOpts(cols(b).filter(x => x.type === 'status'), d.col), d.col, 'Status column') + '<span class="rx-w">changes to</span>' + valueControl('value', b, c, d.value, 'Status label', true); break;
      case 'column': tp = sel('col', colOpts(cols(b).filter(x => !['formula', 'button'].includes(x.type)), d.col), d.col, 'Column') + '<span class="rx-w">changes to</span>' + valueControl('value', b, c, d.value, 'Value', true); break;
      case 'created': tp = '<span class="rx-w">in</span>' + sel('group', groupOpts(b, true), d.group || '', 'Group'); break;
      case 'moved_group': tp = sel('group', groupOpts(b, true), d.group || '', 'Group'); break;
      case 'button': tp = sel('col', colOpts(cols(b).filter(x => x.type === 'button'), d.col), d.col, 'Button column'); break;
      case 'date_arrives': { const w = d._when || {}; tp = sel('col', colOpts(cols(b).filter(x => x.type === 'date'), d.col), d.col, 'Date column')
        + sel('_when.dir', [['on', 'on the date'], ['before', 'days before'], ['after', 'days after']], w.dir, 'When')
        + (w.dir !== 'on' ? inp('_when.n', w.n || 1, 'days', 'Days', 'type="number" min="1" max="365" style="width:76px"') : '')
        + '<span class="rx-w">at</span>' + inp('_when.time', w.time || '09:00', '09:00', 'Time', 'type="time" style="width:120px"'); break; }
      case 'sub_status': tp = sel('col', colOpts((b.subColumns || []).filter(x => x.type === 'status'), d.col), d.col, 'Subitem status column') + '<span class="rx-w">changes to</span>' + valueControl('value', b, c, d.value, 'Status label', true); break;
    }
    const conds = (d.conditions || []).map((k, i) => {
      const kind = k._kind || (k.col === '__group' ? 'group' : (k.op || 'is') === 'is' ? ((col(b, k.col) || {}).type === 'status' ? 'status_is' : 'is') : k.op === 'is_not_any' ? 'is_not' : k.op);
      const pool = kind === 'status_is' ? cols(b).filter(x => x.type === 'status') : kind === 'has_person' ? cols(b).filter(x => x.type === 'person') : cols(b).filter(x => !['button'].includes(x.type));
      const kc = col(b, k.col);
      const ctl = kind === 'group' ? sel(`c.${i}.op`, [['is', 'is'], ['is_not', 'is not']], k.op || 'is', 'Is or is not') + sel(`c.${i}.value`, groupOpts(b, false), k.value, 'Group')
        : sel(`c.${i}.col`, colOpts(pool, k.col), k.col, 'Column') + (['empty', 'not_empty'].includes(kind) ? '' : valueControl(`c.${i}.value`, b, kc, k.value, 'Value'));
      return `<div class="rx-line"><span class="rx-w">${i ? 'and' : 'and only if'}</span>${sel(`c.${i}._kind`, Object.entries(COND), kind, 'Condition')}${ctl}<button class="icon-btn" data-act="rx-cond-del" data-k="${i}" aria-label="Remove condition">×</button></div>`;
    }).join('');
    const actTypes = Object.entries(ACT).filter(([k]) => (sub ? SUB_ACT.includes(k) : true) && (k !== 'external' || fromMonday));
    const acts = (d.actions || []).map((a, i) => {
      const ac = col(b, a.col, sub), P = f => `a.${i}.${f}`;
      let p = '';
      const settable = (sub ? (b.subColumns || []) : cols(b)).filter(x => !NOT_SETTABLE.includes(x.type) && !(x.readonly && x.source !== 'file'));
      switch (a.type) {
        case 'move_group': p = sel(P('group'), groupOpts(b, false), a.group, 'Group'); break;
        case 'set_status': p = sel(P('col'), colOpts((sub ? (b.subColumns || []) : cols(b)).filter(x => x.type === 'status'), a.col), a.col, 'Status column') + '<span class="rx-w">to</span>' + valueControl(P('value'), b, ac, a.value, 'Label'); break;
        case 'set_value': p = sel(P('col'), colOpts(settable.filter(x => x.type !== 'status'), a.col), a.col, 'Column') + '<span class="rx-w">to</span>' + valueControl(P('value'), b, ac, a.value, 'Value'); break;
        case 'set_date': p = sel(P('col'), colOpts((sub ? (b.subColumns || []) : cols(b)).filter(x => x.type === 'date'), a.col), a.col, 'Date column') + '<span class="rx-w">to today +</span>' + inp(P('offset'), a.offset || 0, '0', 'Days from today', 'type="number" min="-3650" max="3650" style="width:80px"') + '<span class="rx-w">days</span>'; break;
        case 'clear': p = sel(P('col'), colOpts(settable, a.col), a.col, 'Column'); break;
        case 'assign': p = inp(P('value'), a.value, 'Name', 'Person', 'list="rx-people"') + '<span class="rx-w">in</span>' + sel(P('col'), colOpts(cols(b).filter(x => x.type === 'person'), a.col), a.col, 'Person column'); break;
        case 'create_update': p = `<textarea class="field-input rx-wide" data-r="${P('value')}" rows="2" placeholder="The update to post" aria-label="Update text">${esc(a.value || a.message || '')}</textarea>`; break;
        case 'move_board': case 'copy_to_board': {
          const tb = (S.boards || []).find(x => x.id === a.board);
          p = sel(P('board'), [...(tb ? [] : [[a.board || '', a.board ? '(board not here)' : 'Pick a board']]), ...(S.boards || []).filter(x => x.id !== b.id).map(x => [x.id, x.name])], a.board, 'Board')
            + (tb ? sel(P('group'), [['__top__', 'top group'], ...(tb.groups || []).map(g => [g.id, g.name])], a.group, 'Group on that board') : '');
          break;
        }
        case 'duplicate': p = `<label class="pop-check rx-check"><input type="checkbox" data-r="${P('withUpdates')}" ${a.withUpdates ? 'checked' : ''}>with its updates</label>`; break;
        case 'notify': p = inp(P('to'), a.to, 'Who, e.g. Jan, {item.Owner}', 'Who to notify', 'list="rx-people"') + `<textarea class="field-input rx-wide" data-r="${P('message')}" rows="2" placeholder="Message. {item.Name} and {item.Column title} are filled in." aria-label="Message">${esc(a.message || '')}</textarea>`; break;
        case 'webhook': {
          const hooks = (META && META.hooks) || [];
          p = sel(P('hook'), [['', 'every connected tool listening'], ...hooks.map(h => [h.id, h.name + (h.active ? '' : ' (off)') + (h.listens ? '' : ' (not listening for this)')])], a.hook || '', 'Connected tool')
            + inp(P('note'), a.note, 'Note sent along (optional)', 'Note', 'style="flex:1 1 160px"')
            + `<div class="rx-hint">Sends a signed <code>automation.webhook</code> event to your tool (n8n, Zapier…). Solver.ca itself never texts or emails anyone.${hooks.length ? '' : ' No outgoing webhooks yet: an admin adds one in Integrations.'}</div>`;
          break;
        }
        case 'external': p = `<span class="rx-muted">${esc(a.label || 'Monday action')}: stays in Monday, logged here only</span>`; break;
      }
      return `<div class="rx-line"><span class="rx-w">${i ? 'and' : 'then'}</span>${sel(P('type'), actTypes.some(([k]) => k === a.type) ? actTypes : [[a.type, a.type], ...actTypes], a.type, 'Action')}${p}<button class="icon-btn" data-act="rx-act-del" data-k="${i}" aria-label="Remove action">×</button></div>`;
    }).join('');
    const people = [...new Set([...(S.teamNames || [])])];
    return `<div class="rx-editor"><h3>${d._new ? 'New automation' : 'Edit automation'}</h3>
      ${fromMonday ? '<p>Copied from Monday. Changes here only change Solver.ca.</p>' : ''}
      ${m.err ? `<div class="rule rx-err"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      <datalist id="rx-people">${people.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="rx-sentence">
        <div class="rx-line"><span class="rx-w">When</span>${sel('trigger', trigOpts, d.trigger, 'Trigger')}${tp}</div>
        ${conds}
        <div class="rx-line rx-add"><button class="btn" data-act="rx-cond-add">+ Condition</button></div>
        ${acts}
        <div class="rx-line rx-add"><button class="btn" data-act="rx-act-add">+ Action</button></div>
      </div>
      <div class="rx-preview"><span class="rx-w">Reads as</span> ${sentence(b, fromDraft(d, b))}</div>
      <div class="rx-row"><label for="rx-title">Name</label><input class="field-input" id="rx-title" data-r="title" value="${esc(d._titleTouched ? d.title : (d._new ? '' : d.title || ''))}" placeholder="Optional. The sentence is used if you leave this empty." style="flex:1 1 240px"></div>
      <div class="rx-row"><button class="btn primary" data-act="rx-save">${m.saving ? 'Saving…' : 'Save automation'}</button><button class="btn" data-act="rx-cancel">Cancel</button>
        <label class="pop-check rx-check"><input type="checkbox" data-r="on" ${d.on !== false ? 'checked' : ''}>On</label></div></div>`;
  }
  function renderRuns(m, b) {
    const r = (b.automations || []).find(x => x.id === m.ruleId);
    const rows = (m.runs || []).map(x => `<div class="rx-run ${x.ok ? '' : 'bad'}"><time>${esc(fmt(x.at))}</time>${x.item ? `<button class="linklike" data-act="rx-open-item" data-item="${esc(x.item)}">${esc(x.itemName || 'Item')}</button>` : '<span>—</span>'}<span class="rx-res">${esc(x.result || '')}</span><span class="rx-via">${esc(x.via || '')}</span></div>`).join('');
    return `<div class="rx-editor"><h3>Runs</h3><p>${r ? sentence(b, r) : 'This automation was deleted.'}</p>
      <p class="rx-small">The last 50 times it ran, newest first: in the app, through the API, as a date reminder, or sending to a connected tool.</p>
      <div class="rx-runs">${m.runs ? rows || '<p class="rail-note">It hasn’t run yet.</p>' : '<p class="rail-note">Loading.</p>'}</div>
      <div class="rx-row"><button class="btn" data-act="rx-back">Back to automations</button></div></div>`;
  }
  function renderList(m, b) {
    const S = A().S, all = (b.automations || []).map(A().normRule);
    const qq = String(m.q || '').toLowerCase();
    const shown = all.filter(r => (m.showAll || r.mondayActive !== false || r.source !== 'monday')).filter(r => !qq || plain(sentence(b, r)).toLowerCase().includes(qq) || String(r.title || '').toLowerCase().includes(qq));
    const hidden = all.filter(r => !(m.showAll || r.mondayActive !== false || r.source !== 'monday')).length;
    const runsHere = r => r.trigger !== 'monday_only' && (r.actions || []).some(a => RUNS_HERE.includes(a.type));
    const cards = shown.map(r => {
      const last = m.last && m.last[r.id];
      return `<div class="rule rx-card ${r.on === false ? 'off' : ''}" data-rule="${esc(r.id)}"><div class="rule-text">${sentence(b, r)}
        <div class="card-meta" style="margin-top:4px">${r.source === 'monday' ? '<span class="pill">Copied from Monday</span>' : ''}${runsHere(r) ? '<span class="pill">Runs in Solver.ca</span>' : '<span class="pill">Monday only, logged here</span>'}${(r.actions || []).some(a => a.type === 'webhook') ? '<span class="pill">Sends to a connected tool</span>' : ''}${r.source === 'monday' && r.mondayActive === false ? '<span class="pill">Off in Monday</span>' : ''}${(r.actions || []).some(a => a.type === 'external') ? '<span class="pill">Emails and texts are skipped</span>' : ''}${last ? `<span>Last ran ${esc(fmt(last.at))}</span>` : ''}</div></div>
        <div class="rx-btns">${S.canWrite ? `<button class="toggle" data-act="rx-toggle" data-id="${esc(r.id)}" aria-pressed="${r.on !== false}">${r.on === false ? 'Off' : 'On'}</button><button class="icon-btn" data-act="rx-edit" data-id="${esc(r.id)}">Edit</button><button class="icon-btn" data-act="rx-dup" data-id="${esc(r.id)}">Duplicate</button>` : ''}<button class="icon-btn" data-act="rx-runs" data-id="${esc(r.id)}">Runs</button>${S.canWrite ? `<button class="icon-btn" data-act="rx-del" data-id="${esc(r.id)}">${m.confirm === r.id ? 'Click again to delete' : 'Delete'}</button>` : ''}</div></div>`;
    }).join('');
    return `<div class="rx-editor"><div class="rx-head"><h3>Automations on ${esc(b.name)}</h3>${S.canWrite ? '<button class="btn primary" data-act="rx-new">+ New automation</button>' : ''}</div>
      <p>Rules that move items, change statuses and dates, assign people, post updates, notify teammates in Solver.ca, and copy or move items between boards. “Send to a connected tool” passes the item to your own tool (n8n, Zapier) as a signed webhook. Solver.ca never texts or emails leads itself: Monday’s email and text actions are only logged.</p>
      ${m.err ? `<div class="rule rx-err"><div class="rule-text">${esc(m.err)}</div></div>` : ''}
      ${all.length > 6 ? `<input class="field-input" data-r="__q" value="${esc(m.q || '')}" placeholder="Search ${all.length} automations" aria-label="Search automations">` : ''}
      <div class="rx-list">${cards || '<p class="rail-note">No automations yet.</p>'}</div>
      ${hidden && !m.showAll ? `<button class="btn" data-act="rx-show-all">Show ${hidden} that are off in Monday</button>` : ''}
      <div><button class="btn" data-act="close-modal-btn">Done</button></div></div>`;
  }

  // ---------- saving ----------
  function saveList(b, automations, m, ok) {
    m.saving = true; m.err = ''; rerender();
    return KS.api('PATCH', '/api/doc?path=' + encodeURIComponent('boards/' + b.id), { automations }).then(() => {
      m.saving = false; A().localBoard({ automations }); if (ok) ok(); rerender();
    }).catch(e => { m.saving = false; m.err = e.message || 'That didn’t save.'; rerender(); });
  }
  function setPath(obj, path, v) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]; o = o[k] = o[k] || {}; }
    o[parts[parts.length - 1]] = v;
  }
  function onField(t, rerenderIt) {
    const S = A().S, m = S.modal, b = A().board(); if (!m || m.type !== 'automations' || !b) return false;
    const path = t.dataset.r;
    if (path === '__q') { m.q = t.value; if (rerenderIt) { const pos = t.selectionStart; A().renderLayer(); const el = document.querySelector('[data-r="__q"]'); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} } } return true; }
    const d = m.edit; if (!d) return true;
    let v = t.type === 'checkbox' ? t.checked : t.value;
    const [head, k, field] = path.split('.');
    if (path === 'title') { d.title = v; d._titleTouched = true; return true; }
    if (path === 'on') { d.on = !!v; return true; }
    if (path === 'trigger') { d.trigger = v; triggerDefaults(d, b); }
    else if (path === 'col') { d.col = v; if (['status', 'column', 'sub_status'].includes(d.trigger)) d.value = ''; }
    else if (path === 'value') { const c = col(b, d.col, d.trigger === 'sub_status'); d.value = c && c.type === 'checkbox' ? v === 'true' : v; }
    else if (head === '_when') { d._when = d._when || {}; d._when[k] = k === 'n' ? Math.max(1, Number(v) || 1) : v; }
    else if (head === 'c') {
      const c = d.conditions[Number(k)];
      if (field === '_kind') {
        const kind = v, pool = kind === 'status_is' ? cols(b).filter(x => x.type === 'status') : kind === 'has_person' ? cols(b).filter(x => x.type === 'person') : cols(b);
        const nc = kind === 'group' ? { col: '__group', op: 'is', value: ((b.groups || [])[0] || {}).id } : { col: (pool[0] || {}).id, op: kind === 'status_is' ? 'is' : kind, value: '' };
        if (kind === 'status_is' && pool[0] && (pool[0].labels || [])[0]) nc.value = pool[0].labels[0].id;
        nc._kind = kind; d.conditions[Number(k)] = nc;
      } else if (field === 'col') { c.col = v; c.value = ''; const cc = col(b, v); if (cc && cc.type === 'status' && (cc.labels || [])[0] && c.op === 'is') c.value = cc.labels[0].id; }
      else c[field] = v;
    } else if (head === 'a') {
      const i = Number(k), a = d.actions[i];
      if (field === 'type') d.actions[i] = defaultAction(b, v, d.trigger === 'sub_status');
      else if (field === 'col') { a.col = v; if ('value' in a) { const cc = col(b, v, d.trigger === 'sub_status'); a.value = cc && cc.type === 'status' && (cc.labels || [])[0] ? cc.labels[0].id : ''; } }
      else if (field === 'board') { a.board = v; const tb = (S.boards || []).find(x => x.id === v); a.group = tb && tb.groups && tb.groups[0] ? tb.groups[0].id : '__top__'; }
      else if (field === 'offset') a.offset = Math.round(Number(v) || 0);
      else if (field === 'withUpdates') a.withUpdates = !!v;
      else if (field === 'value') { const cc = col(b, a.col, d.trigger === 'sub_status'); a.value = cc && cc.type === 'checkbox' ? v === 'true' : v; }
      else a[field] = v;
    } else setPath(d, path, v);
    if (rerenderIt) A().renderLayer();
    return true;
  }

  window.SolverExt.register({
    renderModal(m, b) {
      if (m.type !== 'automations' || !b) return null;
      loadMeta();
      if (!m.view) { m.view = 'list'; loadRuns(m, b); }
      return m.view === 'edit' && m.edit ? renderEdit(m, b) : m.view === 'runs' ? renderRuns(m, b) : renderList(m, b);
    },
    onAct(a, t, e, b) {
      if (!a.startsWith('rx-')) return false;
      const S = A().S, m = S.modal; if (!m || m.type !== 'automations' || !b) return true;
      const list = b.automations || [], find = id => list.find(r => r.id === id);
      if (a !== 'rx-del') m.confirm = null;
      switch (a) {
        case 'rx-new': m.view = 'edit'; m.edit = newDraft(b); m.err = ''; break;
        case 'rx-edit': { const r = find(t.dataset.id); if (!r) break; m.view = 'edit'; m.edit = toDraft(r, b); m.err = ''; break; }
        case 'rx-cancel': case 'rx-back': m.view = 'list'; m.edit = null; m.err = ''; loadRuns(m, b); break;
        case 'rx-show-all': m.showAll = true; break;
        case 'rx-runs': m.view = 'runs'; m.ruleId = t.dataset.id; m.runs = null; loadRuns(m, b); break;
        case 'rx-open-item': { const id = t.dataset.item; if (!A().itemById(id)) { A().toast('That item isn’t on this board any more.'); return true; } S.modal = null; S.openItem = id; S.drawerTab = 'activity'; A().renderLayer(); return true; }
        case 'rx-toggle': { const automations = list.map(r => r.id === t.dataset.id ? { ...r, on: r.on === false } : r); saveList(b, automations, m); return true; }
        case 'rx-dup': { const r = find(t.dataset.id); if (!r) break; const c = JSON.parse(JSON.stringify(r)); c.id = rid('a'); c.on = false; c.title = String(r.title || 'Automation').slice(0, 280) + ' (copy)'; delete c.mondayActive; const ix = list.indexOf(r);
          const automations = [...list.slice(0, ix + 1), c, ...list.slice(ix + 1)]; saveList(b, automations, m, () => A().toast('Duplicated. The copy starts off.')); return true; }
        case 'rx-del': { const id = t.dataset.id; if (m.confirm !== id) { m.confirm = id; break; } m.confirm = null; saveList(b, list.filter(r => r.id !== id), m, () => A().toast('Automation deleted')); return true; }
        case 'rx-cond-add': { const d = m.edit; const sc = cols(b).find(x => x.type === 'status'); d.conditions.push(sc ? { col: sc.id, op: 'is', value: ((sc.labels || [])[0] || {}).id || '', _kind: 'status_is' } : { col: (cols(b)[0] || {}).id, op: 'not_empty', _kind: 'not_empty' }); break; }
        case 'rx-cond-del': m.edit.conditions.splice(Number(t.dataset.k), 1); break;
        case 'rx-act-add': m.edit.actions.push(defaultAction(b, m.edit.trigger === 'sub_status' ? 'set_status' : 'set_status', m.edit.trigger === 'sub_status')); break;
        case 'rx-act-del': m.edit.actions.splice(Number(t.dataset.k), 1); break;
        case 'rx-save': {
          const d = m.edit; const r = fromDraft(d, b);
          if (!r.actions.length) { m.err = 'Add at least one action.'; break; }
          const exists = list.some(x => x.id === r.id);
          const automations = exists ? list.map(x => x.id === r.id ? r : x) : [...list, r];
          saveList(b, automations, m, () => { m.view = 'list'; m.edit = null; A().toast(exists ? 'Automation saved' : 'Automation added'); loadRuns(m, b); });
          return true;
        }
        default: return false;
      }
      A().renderLayer(); return true;
    },
    onChange(e) { const t = e.target; if (!t.dataset || t.dataset.r === undefined || !t.closest('.rx-editor')) return false; return onField(t, true); },
    onInput(e) {
      const t = e.target; if (!t.dataset || t.dataset.r === undefined || !t.closest('.rx-editor')) return false;
      if (t.dataset.r === '__q') return onField(t, true);
      if (t.tagName === 'SELECT' || t.type === 'checkbox') return true;
      return onField(t, false); // typing: keep the draft, re-render on change (blur)
    },
    ruleRan,
    // after-save work from the engine: "Send to a connected tool"
    after(x, b, item) {
      if (x.kind !== 'webhook') return false;
      KS.api('POST', '/api/automations/webhook', { board: b.id, item: item.id, rule: x.rule }).then(r => {
        if (r.sent) A().toast(`Sent to ${r.sent === 1 ? 'the connected tool' : r.sent + ' connected tools'}.`);
        else A().toast('No connected tool is listening yet. An admin can add one in Integrations.');
      }).catch(e => A().toast(e.message || 'Couldn’t send to the connected tool.'));
      return true;
    },
  });
  window.SolverAutomations = { sentence, fromDraft, toDraft, newDraft };
})();
