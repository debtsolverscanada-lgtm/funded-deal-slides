// NEW LEAD banner: a big card at the top of the screen for every brand-new DebtSolvers lead the person can see.
// Several at once stack ("1 of 3"); X closes the one showing and brings up the next, Open lead jumps to it. A lead
// that lands on the board you're looking at right now doesn't banner (you can already see it). Checks every 20 s.
(() => {
  'use strict';
  let queue = [], shown = null, busy = false;
  const S = () => (window.SolverApp && window.SolverApp.S) || null;
  const api = (m, u, b) => window.KS.api(m, u, b);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtPhone = p => /^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
  const ago = t => { const m = Math.max(0, Math.round((Date.now() - Date.parse(t)) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const onBoard = l => { const s = S(); return !!(s && s.page === 'board' && s.boardId === l.board && !document.hidden); };
  const seen = ids => ids.length && api('POST', '/api/leads/seen', { ids }).catch(() => {});

  async function poll() {
    const s = S(); if (busy || !window.KS || !s || !s.me) return; busy = true;
    try {
      const d = await api('GET', '/api/leads/new');
      const known = new Set(queue.map(l => l.id)), quiet = [];
      for (const l of d.leads || []) {
        if (known.has(l.id)) continue;
        if (onBoard(l)) { quiet.push(l.id); continue; } // already looking at that board
        queue.push(l);
      }
      seen(quiet); draw();
    } catch (e) { /* try again next time */ } finally { busy = false; }
  }
  function draw() {
    let el = document.getElementById('newlead');
    if (!queue.length) { if (el) el.remove(); shown = null; return; }
    const l = queue[0];
    if (!el) { el = document.createElement('div'); el.id = 'newlead'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-live', 'assertive'); document.body.appendChild(el); }
    const fresh = !shown || shown !== l.id; shown = l.id;
    const client = l.kind === 'client';
    el.innerHTML = `<div class="nl-card${client ? ' nl-client' : ''}${fresh ? ' nl-in' : ''}">
      <div class="nl-top"><span class="nl-pill"><i></i>${client ? 'NEW CLIENT ✅' : 'NEW LEAD'}</span>${queue.length > 1 ? `<span class="nl-count">1 of ${queue.length}</span>` : ''}<button class="nl-x" aria-label="Close this new lead" title="Close">✕</button></div>
      <div class="nl-name">${esc(l.name || 'New lead')}</div>
      <div class="nl-rows">
        ${l.phone ? `<a class="nl-row" href="tel:+1${esc(l.phone)}"><span>📞</span><b>${esc(fmtPhone(l.phone))}</b></a>` : ''}
        ${l.email ? `<div class="nl-row"><span>✉️</span><b>${esc(l.email)}</b></div>` : ''}
      </div>
      <div class="nl-foot"><span>${client ? 'Just signed · on ' : ''}${esc(l.boardName || '')} · ${esc(ago(l.at))}</span><button class="nl-open">${client ? 'Open client →' : 'Open lead →'}</button></div>
    </div>`;
    el.querySelector('.nl-x').onclick = () => next(false);
    el.querySelector('.nl-open').onclick = () => next(true);
  }
  function next(open) {
    const l = queue.shift(); if (!l) return draw();
    seen([l.id]); shown = null; draw();
    if (open && window.SolverOpen) window.SolverOpen(l.board, l.item);
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && queue.length && document.getElementById('newlead') && !document.querySelector('.modal-wrap')) next(false); });
  const start = () => { poll(); setInterval(poll, 20000); document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); }); };
  if (document.readyState === 'complete') setTimeout(start, 1500); else addEventListener('load', () => setTimeout(start, 1500));
  window.SolverNewLeads = { poll, _queue: () => queue };
})();
