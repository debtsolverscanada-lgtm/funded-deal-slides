// Solver.ca motion graphics, on top of motion.js (which does entrances, count-ups, status pops, confetti, spotlight).
// Adds: Home banner light sweep, gold dust and pointer tilt, the motto typing in, sparkline draw-in and ring sweep,
// a sliding underline under the view tabs, click ripples, a shine on the main buttons, and a paper plane when an email
// or a mass send goes out. Follows the Motion setting (Full / Calm / Off) and the device's "reduce motion":
// Calm keeps only the gentle bits (draw-ins, tab underline); Off and reduce-motion add nothing. Never changes data.
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mode = () => { try { return localStorage.getItem('ks-motion') || 'full'; } catch (e) { return 'full'; } };
  const on = () => mode() !== 'off' && !reduce.matches;
  const full = () => mode() === 'full' && !reduce.matches;

  const css = `
  /* light sweep across the Home greeting */
  html:not(.mx-off):not(.mx-calm) .home-hero h1 { background: linear-gradient(100deg, #fff 0%, #fff 40%, #f3dfb0 48%, #ffffff 52%, #fff 60%, #fff 100%); background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: fxSweep 7s ease-in-out 0.6s infinite; }
  @keyframes fxSweep { 0% { background-position: 100% 0; } 35%, 100% { background-position: 0% 0; } }
  .fx-dust { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0 !important; mix-blend-mode: screen; }
  .home-hero .hero-vid { transition: transform .6s cubic-bezier(.2,.7,.2,1); transform: scale(1.06); }
  .home-hero .hero-in { transition: transform .6s cubic-bezier(.2,.7,.2,1); }
  .fx-caret { display: inline-block; width: 1px; height: 1em; margin-left: 2px; background: rgba(255,255,255,.8); vertical-align: -2px; animation: fxBlink .8s steps(1) infinite; }
  @keyframes fxBlink { 50% { opacity: 0; } }
  /* sliding underline under the view tabs */
  .head .hd-tabs .tabs { position: relative; }
  .head .hd-tabs .tab[aria-pressed="true"] { border-bottom-color: transparent !important; }
  .fx-ink { position: absolute; bottom: -1px; height: 2px; border-radius: 2px; background: linear-gradient(90deg, #fff, #f3dfb0); box-shadow: 0 0 12px rgba(255,255,255,.45); transition: left .38s cubic-bezier(.2,.8,.2,1), width .38s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
  html.mx-off .fx-ink { transition: none; }
  /* click ripple */
  .fx-rip-host { position: relative; overflow: hidden; }
  .fx-rip { position: absolute; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, rgba(255,255,255,.35) 0%, rgba(255,255,255,.12) 45%, transparent 70%); transform: scale(0); animation: fxRip .6s ease-out forwards; }
  .btn.primary .fx-rip { background: radial-gradient(circle, rgba(0,0,0,.18) 0%, rgba(0,0,0,.06) 45%, transparent 70%); }
  @keyframes fxRip { to { transform: scale(1); opacity: 0; } }
  /* shine across the main buttons every few seconds */
  html:not(.mx-off):not(.mx-calm) .btn.primary { position: relative; overflow: hidden; }
  html:not(.mx-off):not(.mx-calm) .btn.primary::after { content: ''; position: absolute; top: -50%; bottom: -50%; width: 40%; left: -60%; transform: skewX(-20deg); background: linear-gradient(90deg, transparent, rgba(255,255,255,.0) 20%, rgba(200,205,220,.55) 50%, transparent 80%); animation: fxShine 6s ease-in-out 1.2s infinite; pointer-events: none; }
  @keyframes fxShine { 0% { left: -60%; } 22%, 100% { left: 130%; } }
  /* paper plane */
  .fx-plane { position: fixed; z-index: 120; width: 34px; height: 34px; pointer-events: none; filter: drop-shadow(0 6px 14px rgba(255,255,255,.35)); }
  .fx-plane svg { width: 100%; height: 100%; fill: #fff; }
  .fx-trail { position: fixed; z-index: 119; width: 4px; height: 4px; border-radius: 50%; background: rgba(255,255,255,.7); pointer-events: none; animation: fxTrail .7s ease-out forwards; }
  @keyframes fxTrail { to { opacity: 0; transform: scale(.2); } }
  @media (prefers-reduced-motion: reduce) { .home-hero h1 { animation: none !important; } .btn.primary::after { display: none; } .fx-ink { transition: none; } }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------- Home banner: gold dust, pointer tilt, the motto typing in ----------
  let dustStop = null;
  function dust(hero) {
    if (dustStop) dustStop();
    if (!full()) return;
    const c = document.createElement('canvas'); c.className = 'fx-dust'; c.setAttribute('aria-hidden', 'true');
    const vid = hero.querySelector('.hero-vid'); if (vid) vid.after(c); else hero.prepend(c);
    const g = c.getContext('2d'); let w = 0, h = 0, dpr = Math.min(2, devicePixelRatio || 1), alive = true, raf = 0;
    const size = () => { w = hero.clientWidth; h = hero.clientHeight; c.width = w * dpr; c.height = h * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    const P = Array.from({ length: Math.round(Math.min(70, w / 14)) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: .4 + Math.random() * 1.6, vy: -.08 - Math.random() * .25, vx: (Math.random() - .5) * .12, a: Math.random() * Math.PI * 2, gold: Math.random() < .6 }));
    const tick = () => {
      if (!alive || !hero.isConnected || !full()) return stop(); // Motion switched down (or reduced motion turned on): stop at once
      if (document.hidden) { raf = requestAnimationFrame(tick); return; }
      g.clearRect(0, 0, w, h);
      for (const p of P) {
        p.x += p.vx; p.y += p.vy; p.a += .03; if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; } if (p.x < -4) p.x = w + 4; if (p.x > w + 4) p.x = -4;
        const tw = .35 + .65 * (0.5 + 0.5 * Math.sin(p.a));
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fillStyle = p.gold ? `rgba(243,214,160,${.55 * tw})` : `rgba(255,255,255,${.45 * tw})`; g.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    const ro = new ResizeObserver(size); ro.observe(hero);
    const stop = () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); c.remove(); dustStop = null; };
    dustStop = stop; raf = requestAnimationFrame(tick);
  }
  function tilt(hero) {
    if (hero.dataset.fxTilt) return; hero.dataset.fxTilt = '1';
    hero.addEventListener('pointermove', e => {
      if (!full() || e.pointerType === 'touch') return;
      const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      const v = hero.querySelector('.hero-vid'), inner = hero.querySelector('.hero-in');
      if (v) v.style.transform = `scale(1.08) translate(${(-x * 14).toFixed(1)}px, ${(-y * 8).toFixed(1)}px)`;
      if (inner) inner.style.transform = `translate(${(x * 6).toFixed(1)}px, ${(y * 4).toFixed(1)}px)`;
    });
    hero.addEventListener('pointerleave', () => { const v = hero.querySelector('.hero-vid'), inner = hero.querySelector('.hero-in'); if (v) v.style.transform = ''; if (inner) inner.style.transform = ''; });
  }
  // the motto types itself in once per visit; if the page redraws meanwhile, typing carries on in the new copy
  const ty = { text: '', i: 0, state: 'idle', el: null };
  function paint() { const q = ty.el; if (!q || !q.isConnected) return; q.textContent = ty.text.slice(0, ty.i); if (ty.state === 'typing') { const c = document.createElement('span'); c.className = 'fx-caret'; q.appendChild(c); } }
  function typeQuote(hero) {
    const q = hero.querySelector('.hero-quote'); if (!q || q === ty.el) return;
    if (ty.state === 'done') return;
    if (ty.state === 'idle') { if (!full()) { ty.state = 'done'; return; } ty.text = q.textContent; ty.state = 'typing'; ty.el = q; paint();
      const step = () => { ty.i++; paint(); if (ty.i < ty.text.length) setTimeout(step, 28 + Math.random() * 40); else { ty.state = 'done'; setTimeout(paint, 1400); } };
      setTimeout(step, 600); return; }
    ty.el = q; paint(); // a redraw during typing: keep going in the new copy
  }

  // ---------- charts: sparkline draws in, ring sweeps ----------
  function drawCharts(root) {
    if (!on()) return;
    root.querySelectorAll('svg.spark:not([data-fx])').forEach(s => {
      s.dataset.fx = '1'; const line = s.querySelector('path[stroke]'), area = s.querySelector('path[fill^="url"]'); if (!line || !line.getTotalLength) return;
      const L = line.getTotalLength(); line.style.strokeDasharray = L; line.style.strokeDashoffset = L; if (area) { area.style.opacity = 0; area.style.transition = 'opacity .9s ease .7s'; }
      line.getBoundingClientRect(); line.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(.3,.7,.2,1)';
      requestAnimationFrame(() => { line.style.strokeDashoffset = 0; if (area) area.style.opacity = 1; });
    });
    root.querySelectorAll('svg.ring:not([data-fx])').forEach(s => {
      s.dataset.fx = '1'; const arc = s.querySelectorAll('circle')[1]; if (!arc) return;
      const target = arc.getAttribute('stroke-dashoffset'), full_ = arc.getAttribute('stroke-dasharray'); arc.style.strokeDashoffset = full_; arc.getBoundingClientRect();
      arc.style.transition = 'stroke-dashoffset 1.3s cubic-bezier(.3,.7,.2,1) .2s'; requestAnimationFrame(() => { arc.style.strokeDashoffset = target; });
    });
  }

  // ---------- sliding underline under the view tabs ----------
  let lastInk = null;
  function ink() {
    const bar = document.querySelector('.head .hd-tabs .tabs'); if (!bar) return;
    const act = bar.querySelector('.tab[aria-pressed="true"]'); let el = bar.querySelector('.fx-ink');
    if (!act) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'fx-ink'; bar.appendChild(el); if (lastInk && on()) { el.style.transition = 'none'; el.style.left = lastInk.left + 'px'; el.style.width = lastInk.width + 'px'; el.getBoundingClientRect(); el.style.transition = ''; } }
    const left = act.offsetLeft, width = act.offsetWidth; el.style.left = left + 'px'; el.style.width = width + 'px'; lastInk = { left, width };
    el.style.bottom = 'auto'; el.style.top = (act.offsetTop + act.offsetHeight - 1) + 'px'; // under the active tab, also when the tabs wrap to a 2nd row
  }

  // ---------- click ripple ----------
  document.addEventListener('pointerdown', e => {
    if (!on() || e.button > 0) return;
    const t = e.target.closest('.btn, .bb-btn, .rl-link, .head .tab, .name-open, .tm-status, .pf-row, .li'); if (!t || t.disabled) return;
    const r = t.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span'); s.className = 'fx-rip'; s.style.width = s.style.height = d + 'px'; s.style.left = (e.clientX - r.left - d / 2) + 'px'; s.style.top = (e.clientY - r.top - d / 2) + 'px';
    const had = t.classList.contains('fx-rip-host'); if (!had && getComputedStyle(t).position === 'static') t.classList.add('fx-rip-host');
    t.appendChild(s); setTimeout(() => { s.remove(); if (!had && !t.querySelector('.fx-rip')) t.classList.remove('fx-rip-host'); }, 650);
  }, { passive: true });

  // ---------- paper plane when an email or a mass send goes out ----------
  function plane() {
    if (!full()) return;
    const p = document.createElement('div'); p.className = 'fx-plane'; p.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 11.5 21.5 3l-6.8 18.5-3.2-7.3L2 11.5zm9.7 2.4 2 4.6 4.4-12-6.4 7.4z"/></svg>';
    document.body.appendChild(p);
    const x0 = innerWidth / 2 - 17, y0 = innerHeight * .62, x1 = innerWidth + 60, y1 = -60, t0 = performance.now(), dur = 1300;
    let lastTrail = 0;
    (function f(t) {
      const k = Math.min(1, (t - t0) / dur), e = k * k * (3 - 2 * k), x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e - Math.sin(k * Math.PI) * 120;
      p.style.transform = `translate(${x}px, ${y}px) rotate(${-25 + 40 * k}deg) scale(${1 + .4 * Math.sin(k * Math.PI)})`;
      if (t - lastTrail > 30 && k < .9) { lastTrail = t; const d = document.createElement('span'); d.className = 'fx-trail'; d.style.left = (x + 6) + 'px'; d.style.top = (y + 24) + 'px'; document.body.appendChild(d); setTimeout(() => d.remove(), 720); }
      if (k < 1) requestAnimationFrame(f); else p.remove();
    })(t0);
  }
  const toasts = document.getElementById('toasts');
  if (toasts) new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && /^(Email sent|Sending to)/.test(n.textContent || '')) plane(); }).observe(toasts, { childList: true });

  // ---------- watch the page ----------
  let queued = false;
  const scan = () => {
    queued = false;
    const hero = document.querySelector('.home-hero');
    if (hero) { if (!hero.querySelector('.fx-dust')) dust(hero); tilt(hero); typeQuote(hero); } else if (dustStop) dustStop();
    drawCharts(document);
    ink();
  };
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(scan); } };
  const content = document.getElementById('content'), head = document.getElementById('head');
  if (content) new MutationObserver(later).observe(content, { childList: true, subtree: true });
  if (head) new MutationObserver(later).observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  addEventListener('resize', later);
  later();
  window.SolverFX = { plane };
})();
