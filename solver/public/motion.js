// Solver.ca motion: watches the page and adds entrances, count-ups, status pops, celebrations and a pointer spotlight.
// It never changes data. Modes: full (default), calm, off. Reduced-motion devices get no animation at all.
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let mode = 'full'; try { mode = localStorage.getItem('ks-motion') || 'full'; } catch (e) {}
  const applyMode = () => { document.documentElement.classList.toggle('mx-calm', mode === 'calm'); document.documentElement.classList.toggle('mx-off', mode === 'off'); };
  const on = () => mode !== 'off' && !reduce.matches;
  const full = () => mode === 'full' && !reduce.matches;
  applyMode();

  // ---------- ambient orbs ----------
  const orbs = document.createElement('div'); orbs.className = 'mx-orbs'; orbs.setAttribute('aria-hidden', 'true'); orbs.innerHTML = '<span></span><span></span><span></span>';
  document.body.prepend(orbs);

  // ---------- celebration ----------
  const CELEBRATE = /^(funded|closed|paid|deal accepted|approved|lender says yes|commitment issued|deal done|won|signed)$/i;
  function confetti(color) {
    if (!full()) return;
    const c = document.createElement('canvas'); c.className = 'mx-confetti'; const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr; document.body.appendChild(c);
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const tones = ['#ffffff', '#d9d9de', '#a7a7ad', color || '#ffffff'];
    const parts = Array.from({ length: 150 }, (_, i) => {
      const fromLeft = i % 2 === 0, a = (fromLeft ? -60 : -120) * Math.PI / 180 + (Math.random() - .5) * .9, sp = 9 + Math.random() * 9;
      return { x: fromLeft ? -10 : innerWidth + 10, y: innerHeight * (.55 + Math.random() * .25), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - .5) * .3, col: tones[i % tones.length], life: 0 };
    });
    const t0 = performance.now();
    (function frame(t) {
      const el = t - t0; g.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) { p.vy += .32; p.vx *= .992; p.vy *= .992; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.globalAlpha = Math.max(0, 1 - el / 2600); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.col; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1); g.restore(); }
      if (el < 2600) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }
  function celebrate(label, name, color) {
    if (!full()) return;
    confetti(color);
    const b = document.createElement('div'); b.className = 'mx-banner'; b.setAttribute('role', 'status');
    const t1 = document.createElement('b'); t1.textContent = label + '!'; const t2 = document.createElement('span'); t2.textContent = name || '';
    b.append(t1, t2); document.body.appendChild(b); setTimeout(() => b.remove(), 2700);
  }

  // ---------- count-up numbers ----------
  const NUMSEL = '.hero-num, .ov-main .v';
  const running = new Map();
  function countUp(idx, txt) {
    const m = /^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/.exec(txt); if (!m) return;
    const target = Number(m[2].replace(/,/g, '')); if (!Number.isFinite(target) || target === 0) return;
    const dec = (m[2].split('.')[1] || '').length, t0 = performance.now(), dur = 900 + Math.min(700, Math.log10(Math.abs(target) + 1) * 180), token = {};
    running.set(idx, token);
    (function step(t) {
      if (running.get(idx) !== token) return;
      const el = content.querySelectorAll(NUMSEL)[idx]; if (!el) { running.delete(idx); return; }
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = k < 1 ? m[1] + (target * e).toLocaleString('en-CA', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + m[3] : txt;
      if (k < 1) requestAnimationFrame(step); else running.delete(idx);
    })(t0);
  }

  // ---------- page entrances + status changes ----------
  const content = document.getElementById('content'), layer = document.getElementById('layer');
  let counted = new Map(), lastKey = '', chips = new Map(), lanes = new Map(), groups = new Map(), firstScan = true, enterTimer = null;
  const pageKey = () => {
    if (content.querySelector('.home')) return 'home';
    const title = document.getElementById('board-select') || document.getElementById('board-title'); const tab = document.querySelector('.tabs .tab[aria-pressed="true"]');
    return 'board:' + (title ? title.value : '') + ':' + (tab ? tab.textContent : '') + ':' + (content.querySelector('.board tbody tr, .lane, .cal, .agenda') ? 'ready' : 'loading');
  };
  function scan() {
    const key = pageKey();
    if (key !== lastKey) {
      lastKey = key;
      if (on()) {
        content.classList.add('mx-enter', 'mx-draw'); clearTimeout(enterTimer);
        content.querySelectorAll('.board tbody tr').forEach((tr, i) => tr.style.setProperty('--i', i));
        enterTimer = setTimeout(() => content.classList.remove('mx-enter'), 1300);
        setTimeout(() => content.classList.remove('mx-draw'), 2600);
      }
      counted = new Map();
      firstScan = true;
    }
    // count numbers up the first time they show on this page (they often arrive a moment after the page)
    if (on()) content.querySelectorAll(NUMSEL).forEach((el, i) => { const txt = el.textContent.trim(); if (running.has(i)) return; if (counted.get(i) !== txt) { counted.set(i, txt); countUp(i, txt); } });
    // status chips that changed since the last render
    const now = new Map();
    content.querySelectorAll('.chip[data-item][data-col]').forEach(ch => {
      const k = ch.dataset.item + '|' + ch.dataset.col + '|' + (ch.dataset.sub || ''), text = ch.textContent.trim(); now.set(k, text);
      const prev = chips.get(k);
      if (!firstScan && prev !== undefined && prev !== text && on()) {
        ch.classList.add('mx-changed'); setTimeout(() => ch.classList.remove('mx-changed'), 700);
        if (CELEBRATE.test(text)) { const row = ch.closest('tr'); const nm = row && (row.querySelector('[data-edit="name"]') || row.querySelector('.name-open')); celebrate(text, nm ? (nm.value || nm.textContent) : '', getComputedStyle(ch).getPropertyValue('--c').trim()); }
      }
    });
    chips = now;
    // Kanban cards that changed lanes
    const nowLanes = new Map();
    content.querySelectorAll('.lane[data-lane]').forEach(l => { const name = (l.querySelector('.lane-head span') || {}).textContent || ''; l.querySelectorAll('.card[data-item]').forEach(cd => nowLanes.set(cd.dataset.item, name.trim())); });
    if (!firstScan && on()) for (const [id, lane] of nowLanes) { const prev = lanes.get(id); if (prev && prev !== lane && CELEBRATE.test(lane)) { const cd = document.querySelector(`.card[data-item="${CSS.escape(id)}"] .card-name`); celebrate(lane, cd ? cd.textContent : ''); } }
    lanes = nowLanes;
    // rows that moved group: flash them
    const nowGroups = new Map();
    content.querySelectorAll('tr[data-row][data-group]').forEach(tr => {
      nowGroups.set(tr.dataset.row, tr.dataset.group);
      if (!firstScan && on() && groups.has(tr.dataset.row) && groups.get(tr.dataset.row) !== tr.dataset.group) {
        tr.classList.add('mx-flash'); setTimeout(() => tr.classList.remove('mx-flash'), 1300);
        // moved into a winning group (e.g. DebtSolvers "Signed"): confetti + Penny cheers
        const gEl = document.querySelector(`.group-name[data-group="${CSS.escape(tr.dataset.group)}"]`), gName = gEl ? String(gEl.value || gEl.textContent || '').trim() : '';
        if (CELEBRATE.test(gName)) { const nm = tr.querySelector('[data-edit="name"]') || tr.querySelector('.name-open'); celebrate(gName, nm ? (nm.value || nm.textContent) : ''); }
      }
    });
    groups = nowGroups;
    firstScan = false;
  }

  // ---------- overlays appearing ----------
  let seen = {};
  function scanLayer() {
    const d = layer.querySelector('.drawer'), m = layer.querySelector('.modal-wrap'), p = layer.querySelector('.pop'), bb = layer.querySelector('.bulkbar'), sc = layer.querySelector('.scrim');
    const ids = { drawer: d && d.getAttribute('aria-label'), modal: m && ((m.querySelector('h3') || {}).textContent || 'modal'), pop: p && (p.getAttribute('style') || 'pop'), bulk: bb && 'bulk' };
    if (on()) {
      if (d && ids.drawer !== seen.drawer) { d.classList.add('mx-new'); if (sc) sc.classList.add('mx-new'); }
      if (m && ids.modal !== seen.modal) m.classList.add('mx-new');
      if (p && ids.pop !== seen.pop) p.classList.add('mx-new');
      if (bb && !seen.bulk) bb.classList.add('mx-new');
    }
    seen = ids;
  }

  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; try { scan(); } catch (e) {} }); };
  if (content) new MutationObserver(schedule).observe(content, { childList: true, subtree: true });
  // overlays only need their entrance; the page scan watches #content (re-scanning every row on each drawer change was slow)
  if (layer) new MutationObserver(() => { try { scanLayer(); } catch (e) {} }).observe(layer, { childList: true });
  const head = document.getElementById('head'); if (head) new MutationObserver(schedule).observe(head, { childList: true, subtree: true });

  // ---------- pointer spotlight on glass ----------
  document.addEventListener('pointermove', e => {
    if (!full() || e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest('.glass, .tablewrap'); if (!el) return;
    const r = el.getBoundingClientRect(); el.style.setProperty('--mx', (e.clientX - r.left) + 'px'); el.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
  // Kanban drag tilt
  document.addEventListener('dragstart', e => { const c = e.target.closest && e.target.closest('.card'); if (c && on()) c.classList.add('mx-dragging'); });
  document.addEventListener('dragend', () => document.querySelectorAll('.mx-dragging').forEach(c => c.classList.remove('mx-dragging')));

  // ---------- Motion setting (in the sidebar and the Profile sheet) ----------
  const label = () => `Motion: ${mode === 'full' ? 'Full' : mode === 'calm' ? 'Calm' : 'Off'}`;
  function addToggle(root) {
    if (!root || root.querySelector('[data-mx-toggle]')) return;
    const row = root.querySelector('[data-slot="settings"]') || root.querySelector('.form-row:last-of-type'); if (!row) return;
    const b = document.createElement('button'); b.className = 'btn'; b.dataset.mxToggle = '1'; b.type = 'button'; b.textContent = label();
    b.title = 'Full: all animations. Calm: quick, no confetti. Off: none.';
    b.addEventListener('click', ev => { ev.stopPropagation(); mode = mode === 'full' ? 'calm' : mode === 'calm' ? 'off' : 'full'; try { localStorage.setItem('ks-motion', mode); } catch (x) {} applyMode(); document.querySelectorAll('[data-mx-toggle]').forEach(x => x.textContent = label()); if (mode === 'full') confetti(); });
    row.appendChild(b);
  }
  const rail = document.getElementById('rail');
  if (rail) new MutationObserver(() => addToggle(rail)).observe(rail, { childList: true });
  if (layer) new MutationObserver(() => { const m = layer.querySelector('.modal'); if (m && m.querySelector('[data-slot="settings"]')) addToggle(m); }).observe(layer, { childList: true });
  window.SolverMotion = { celebrate, confetti };
})();
