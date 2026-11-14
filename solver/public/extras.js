// Solver.ca add-ons on the page: AI columns, the item's "Calls & texts" timeline, and "Phone/desktop alerts" and
// "Email me my notifications" in Profile. Also opens the item a push alert points to (#open=board/item).
(() => {
  'use strict';
  const A = () => window.SolverApp;
  const S = () => A().S;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = iso => { try { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const rerender = () => { try { A().renderLayer(); A().renderContent(); } catch (e) {} };

  // ---------- AI columns ----------
  const AI = { status: null, busy: new Set() };
  const OFF_MSG = 'Add an Anthropic key to turn on AI columns';
  function aiStatus() { if (AI.status || AI.loading || !window.KS) return; AI.loading = true; KS.api('GET', '/api/ai/status').then(s => { AI.status = s; rerender(); }).catch(() => { AI.status = { on: false, message: OFF_MSG }; }).finally(() => { AI.loading = false; }); }
  function runAi(body, key) {
    AI.busy.add(key); rerender();
    return KS.api('POST', '/api/ai/run', body).then(r => { if (r.queued != null) A().toast(r.queued ? `Running AI on ${r.queued} item${r.queued === 1 ? '' : 's'}. Cells fill in as answers arrive.${r.skipped ? ` ${r.skipped} skipped (rate limit).` : ''}` : 'Nothing to run in that group.'); })
      .catch(e => A().toast(e.message || 'The AI run failed.')).finally(() => { AI.busy.delete(key); rerender(); });
  }
  function aiCell(col, item, inDrawer) {
    aiStatus();
    const v = (item.values || {})[col.id], meta = (item.ai || {})[col.id] || {}, key = `${item.id}|${col.id}`, busy = AI.busy.has(key);
    const st = AI.status;
    if (st && !st.on) return inDrawer ? `<div class="ai-box">${v ? `<div class="ai-full">${esc(String(v))}</div>` : ''}<div class="ai-meta">${OFF_MSG}</div></div>`
      : `<div class="ai-cell off" title="${OFF_MSG}"><span class="ai-ic">✦</span><span class="ai-text">${esc(v ? String(v) : OFF_MSG)}</span></div>`;
    const canRun = S().canWrite && st && st.on;
    const btn = canRun ? `<button class="ai-run" data-act="ai-run" data-item="${esc(item.id)}" data-col="${esc(col.id)}" ${busy ? 'disabled' : ''} title="${v ? 'Run again' : 'Run'}" aria-label="Run AI for ${esc(col.title)}">${busy ? '<span class="ai-spin"></span>' : v ? '↻' : '▶'}</button>` : '';
    if (!inDrawer) return `<div class="ai-cell ${meta.error ? 'err' : ''}" title="${esc(meta.error ? meta.error : v ? String(v) : col.prompt || '')}"><span class="ai-ic">✦</span><span class="ai-text">${esc(v ? String(v) : meta.error ? 'Didn’t work, see why' : '')}</span>${btn}</div>`;
    return `<div class="ai-box"><div class="ai-full">${v ? esc(String(v)) : `<span class="rail-note">${col.prompt ? 'Not run yet.' : 'This AI column has no prompt yet. Open the column’s settings to write one.'}</span>`}</div>
      ${meta.error ? `<div class="ai-meta err">${esc(meta.error)}</div>` : ''}
      <div class="ai-meta">${meta.at && !meta.error ? `Made ${esc(fmt(meta.at))} by ${esc(meta.model || 'AI')}${meta.by ? ' for ' + esc(meta.by) : ''}` : ''}${btn ? ` ${btn.replace('class="ai-run"', 'class="btn ai-run"').replace(/>(↻|▶)</, v ? '>↻ Run again<' : '>▶ Run<')}` : ''}</div></div>`;
  }
  function aiSettings(c, b) {
    if (c.type !== 'ai') return '';
    const st = AI.status, can = S().canWrite;
    const refs = ['Name', 'Group', 'Updates', ...(b.columns || []).filter(x => x.id !== c.id && x.type !== 'ai' && x.type !== 'button').map(x => x.title)];
    return `<div class="ai-settings"><h4 class="sec-title">AI prompt</h4>
      ${st && !st.on ? `<div class="rule"><div class="rule-text">${OFF_MSG}. Set ANTHROPIC_API_KEY on the server; until then nothing is sent anywhere.</div></div>` : ''}
      <p>Write what Claude should put in each cell. Use other columns in curly brackets, for example: Summarise {Updates} for {Name} in one line, and suggest the next step.</p>
      <textarea class="field-input" id="ai-prompt" rows="4" ${can ? '' : 'readonly'} placeholder="Summarise {Updates} for {Name} in one line.">${esc(c.prompt || '')}</textarea>
      <div class="ai-refs">${refs.map(r => `<button class="pill ai-ref" data-act="ai-ref" data-ref="${esc(r)}" type="button">{${esc(r)}}</button>`).join('')}</div>
      ${can ? `<div class="rx-row"><label class="pop-check"><input type="checkbox" id="ai-autorun" ${c.autorun ? 'checked' : ''}>Run again when a column it uses changes</label></div>
      <div class="rx-row"><button class="btn primary" data-act="ai-save" data-col="${esc(c.id)}">Save prompt</button></div>
      <h4 class="sec-title">Run for a group</h4>
      <div class="rx-row"><select class="field-input" id="ai-group" aria-label="Group">${(b.groups || []).map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>
        <label class="pop-check"><input type="checkbox" id="ai-empty" checked>Only empty cells</label>
        <button class="btn" data-act="ai-run-group" data-col="${esc(c.id)}" ${st && st.on ? '' : 'disabled'}>${AI.busy.has('g|' + c.id) ? 'Starting…' : 'Run'}</button></div>
      <p class="rail-note">Up to 50 items at a time. Only this board’s columns for each item are sent to Claude, and only for boards you can see.</p>` : ''}</div>`;
  }

  // ---------- Calls & texts ----------
  const COMMS = new Map(); // item id -> { at, data, err }
  function loadComms(b, i, force) {
    const hit = COMMS.get(i.id); if (hit && !force && (hit.loading || Date.now() - hit.at < 30000)) return;
    COMMS.set(i.id, { ...(hit || {}), loading: true, at: Date.now() });
    KS.api('GET', `/api/comms?board=${encodeURIComponent(b.id)}&item=${encodeURIComponent(i.id)}`).then(d => COMMS.set(i.id, { at: Date.now(), data: d }))
      .catch(e => COMMS.set(i.id, { at: Date.now(), err: e.message })).finally(() => { if (S().openItem === i.id && S().drawerTab === 'comms') A().renderLayer(); });
  }
  const ICON = { call: '📞', text: '💬', email: '✉️', docs: '📎' };
  const LABEL = { call: 'Call', text: 'Text', email: 'Email', docs: 'Documents received' };
  function commsBody(b, i) {
    loadComms(b, i);
    const hit = COMMS.get(i.id) || {};
    if (hit.err) return `<div class="comms"><p class="rail-note">${esc(hit.err)}</p></div>`;
    const d = hit.data; if (!d) return '<div class="comms"><p class="rail-note">Loading calls and texts.</p></div>';
    const dur = s => s == null ? '' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? (s % 60) + ' s' : ''}` : `${s} s`;
    const rows = d.events.map(e => `<li class="cm-row ${esc(e.direction || '')}"><span class="cm-ic" aria-hidden="true">${ICON[e.type] || '•'}</span><div class="cm-main"><div class="cm-top"><b>${esc(LABEL[e.type] || e.type)}${e.direction === 'outbound' ? ' out' : e.direction === 'inbound' ? ' in' : ''}</b><time>${esc(fmt(e.at))}</time></div>${e.note ? `<div class="cm-note">${esc(e.note)}</div>` : ''}<div class="cm-src">${esc(e.source || '')}${e.duration ? ' · ' + esc(dur(e.duration)) : ''}</div></div></li>`).join('');
    const rc = d.ringcentral || {};
    return `<div class="comms"><div class="cm-head"><h4 class="sec-title">Calls and texts</h4><button class="btn" data-act="comms-refresh">Refresh</button></div>
      <p class="rail-note">${d.phones ? 'Matched by this lead’s phone number.' : 'This item has no phone number yet, so only events sent for this item show here.'} Texts and emails sent from Solver.ca show here too; calls are read-only.</p>
      <div class="cm-rc ${rc.on ? 'on' : ''}">${rc.on ? (rc.error ? 'RingCentral: ' + esc(rc.error) : 'RingCentral call log and texts: connected (read-only)') : 'RingCentral: not connected. Events your phone tools post to Solver.ca show here.'}</div>
      ${rows ? `<ul class="cm-list">${rows}</ul>` : '<p class="rail-note">No calls or texts recorded yet.</p>'}</div>`;
  }

  // ---------- Profile: phone/desktop alerts and email ----------
  const AL = { loaded: false, loading: false, push: null, email: null, here: null, msg: '' };
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const u8 = b64 => { const s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); };
  async function loadAlerts() {
    if (AL.loading) return; AL.loading = true;
    try {
      const [p, e] = await Promise.all([KS.api('GET', '/api/push/status'), KS.api('GET', '/api/me/alerts')]);
      AL.push = p; AL.email = e.email;
      AL.here = null;
      if (pushSupported()) { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); AL.here = sub ? sub.endpoint : null; }
    } catch (err) { AL.msg = err.message || 'Couldn’t load alert settings.'; }
    AL.loaded = true; AL.loading = false;
    if (S().modal && S().modal.type === 'profile') A().renderLayer();
  }
  async function pushOn() {
    if (!pushSupported()) { AL.msg = /iphone|ipad/i.test(navigator.userAgent) ? 'On iPhone or iPad: install Solver.ca to your Home Screen first (Install app), open it from there, then turn alerts on.' : 'This browser can’t show alerts.'; return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { AL.msg = 'Alerts are blocked for this site. Allow notifications in the browser’s site settings, then try again.'; return; }
    const reg = await (navigator.serviceWorker.getRegistration().then(r => r || navigator.serviceWorker.register('/sw.js'))).then(() => navigator.serviceWorker.ready);
    const { publicKey } = await KS.api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) { const k = new Uint8Array(sub.options.applicationServerKey); const want = u8(publicKey); if (k.length !== want.length || k.some((x, j) => x !== want[j])) { await sub.unsubscribe(); sub = null; } }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(publicKey) });
    const ua = navigator.userAgent, device = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : 'This device';
    await KS.api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), device });
    AL.msg = 'Alerts are on for this device.';
  }
  async function pushOff() {
    const reg = pushSupported() && await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await KS.api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe().catch(() => {}); }
    AL.msg = 'Alerts are off for this device.';
  }
  function profileBox() {
    if (!AL.loaded) { loadAlerts(); return '<div class="alerts-box"><h4 class="sec-title">Phone/desktop alerts</h4><p class="rail-note">Loading.</p></div>'; }
    const p = AL.push || { devices: [] }, e = AL.email || {}, onHere = !!AL.here;
    const others = (p.devices || []).length - (onHere ? 1 : 0);
    return `<div class="alerts-box">
      <h4 class="sec-title">Phone/desktop alerts</h4>
      <p>Get your mentions, assignments and reminders as alerts on this ${/iphone|android/i.test(navigator.userAgent) ? 'phone' : 'computer'}, even when Solver.ca is closed.</p>
      <div class="rx-row"><span class="pill ${onHere ? 'al-on' : ''}">${onHere ? 'On for this device' : 'Off for this device'}</span>${others > 0 ? `<span class="rail-note">Also on for ${others} other device${others === 1 ? '' : 's'}</span>` : ''}</div>
      <div class="rx-row">${onHere ? '<button class="btn" data-act="al-push-off">Turn off here</button><button class="btn" data-act="al-push-test">Send a test</button>' : '<button class="btn primary" data-act="al-push-on">Turn on alerts here</button>'}</div>
      <h4 class="sec-title">Email me my notifications</h4>
      ${e.configured ? `<div class="rx-row"><select class="field-input" id="al-email" aria-label="Email me my notifications">${[['off', 'Off'], ['instant', 'Instant (each one)'], ['daily', 'Daily digest']].map(([v, l]) => `<option value="${v}" ${e.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="rail-note">Sent only to ${esc(e.to || 'your own address')}.</span></div>`
        : '<div class="rx-row"><select class="field-input" disabled aria-label="Email me my notifications"><option>Off</option></select><span class="pill">Not set up yet</span></div>'}
      ${AL.msg ? `<p class="al-msg">${esc(AL.msg)}</p>` : ''}</div>`;
  }

  window.SolverExt.register({
    types() { return {}; },
    cell(col, item, inDrawer) { return col.type === 'ai' ? aiCell(col, item, inDrawer) : null; },
    colSettings(c, b) { if (c.type === 'ai') aiStatus(); return aiSettings(c, b); },
    drawerTabs(b) { return (b.columns || []).some(c => c.type === 'phone' || c.type === 'email') ? [['comms', 'Calls & texts']] : []; },
    drawerBody(tab, b, i) { return tab === 'comms' ? commsBody(b, i) : null; },
    profile() { return profileBox(); },
    onChange(e) {
      const t = e.target;
      if (t.id === 'al-email') { KS.api('PUT', '/api/me/alerts', { emailMode: t.value }).then(() => { AL.email.mode = t.value; AL.msg = t.value === 'off' ? 'Email alerts are off.' : t.value === 'daily' ? 'You’ll get one email a day with your unread notifications.' : 'You’ll get an email for each notification.'; A().renderLayer(); }).catch(err => { AL.msg = err.message; A().renderLayer(); }); return true; }
      return false;
    },
    onAct(a, t, e, b) {
      switch (a) {
        case 'ai-run': runAi({ board: b.id, item: t.dataset.item, col: t.dataset.col }, `${t.dataset.item}|${t.dataset.col}`); return true;
        case 'ai-run-group': { const g = document.getElementById('ai-group'); runAi({ board: b.id, group: g && g.value, col: t.dataset.col, onlyEmpty: !!(document.getElementById('ai-empty') || {}).checked }, 'g|' + t.dataset.col); return true; }
        case 'ai-ref': { const ta = document.getElementById('ai-prompt'); if (!ta) return true; const ins = `{${t.dataset.ref}}`, p = ta.selectionStart ?? ta.value.length; ta.value = ta.value.slice(0, p) + ins + ta.value.slice(ta.selectionEnd ?? p); ta.focus(); ta.setSelectionRange(p + ins.length, p + ins.length); return true; }
        case 'ai-save': {
          const prompt = (document.getElementById('ai-prompt') || {}).value || '', autorun = !!(document.getElementById('ai-autorun') || {}).checked;
          if (prompt.length > 4000) { A().toast('Keep the prompt under 4,000 characters.'); return true; }
          const columns = b.columns.map(c => c.id === t.dataset.col ? { ...c, prompt: prompt.trim(), autorun } : c);
          A().patchBoard({ columns }); A().localBoard({ columns }); A().toast('Prompt saved'); return true;
        }
        case 'comms-refresh': { const i = A().itemById(S().openItem); if (i) loadComms(b, i, true); return true; }
        case 'al-push-on': case 'al-push-off': case 'al-push-test': {
          AL.msg = 'One moment…'; A().renderLayer();
          (a === 'al-push-on' ? pushOn() : a === 'al-push-off' ? pushOff() : KS.api('POST', '/api/push/test', {}).then(r => { AL.msg = r.ok ? 'Test sent. It should pop up in a few seconds.' : 'The push service didn’t accept it. Turn alerts off and on again.'; }))
            .catch(err => { AL.msg = (err && err.message) || 'That didn’t work.'; })
            .finally(() => { AL.loaded = false; loadAlerts(); });
          return true;
        }
      }
      return false;
    },
  });

  // ---------- open the item an alert points to: /#open=<board>/<item> ----------
  function openFromHash() {
    const m = /^#open=([^/]+)(?:\/(.+))?$/.exec(location.hash || ''); if (!m) return;
    const go = () => {
      const app = window.SolverApp; if (!app || !window.SolverOpen || !app.S.boards.length) return setTimeout(go, 300);
      history.replaceState(null, '', location.pathname + location.search);
      window.SolverOpen(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
    };
    go();
  }
  addEventListener('hashchange', openFromHash);
  addEventListener('DOMContentLoaded', openFromHash);
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'open' && e.data.url) { const u = new URL(e.data.url, location.origin); if (u.hash) { location.hash = u.hash; } } });
  window.SolverExtras = { AI, COMMS, AL };
})();
