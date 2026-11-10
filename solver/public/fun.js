// Solver.ca flair: neon themes, 3D tilt, avatar rings, shimmering name, and Penny the money pet.
// Purely visual. Preferences are saved per person in this browser.
(() => {
  'use strict';
  const html = document.documentElement, reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const get = (k, d) => { try { return localStorage.getItem('fx-' + k) || d; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem('fx-' + k, v); } catch (e) {} html.setAttribute('data-flair-' + k, v); };
  ['theme:classic', 'ring:spin', 'name:shimmer', 'pet:on'].forEach(p => { const [k, d] = p.split(':'); html.setAttribute('data-flair-' + k, get(k, d)); });
  const motionOn = () => !reduce.matches && !html.classList.contains('mx-off');

  // ---------- 3D tilt + light sweep ----------
  const TILT = '.btn, .qa, .li, .hero, .ov, .card, .bnav-plus';
  let hot = null;
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !motionOn()) return;
    const el = e.target.closest && e.target.closest(TILT);
    if (hot && hot !== el) { hot.classList.remove('fx-hot'); hot.style.removeProperty('--rx'); hot.style.removeProperty('--ry'); hot = null; }
    if (!el) return;
    if (!el.classList.contains('fx-tilt')) el.classList.add('fx-tilt');
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
    const amt = el.matches('.hero, .ov') ? 4 : el.matches('.li, .card') ? 3 : 9;
    el.style.setProperty('--rx', (-y * amt).toFixed(2) + 'deg'); el.style.setProperty('--ry', (x * amt).toFixed(2) + 'deg');
    el.style.setProperty('--sx', (150 - (x + .5) * 200).toFixed(0) + '%');
    el.classList.add('fx-hot'); hot = el;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { if (hot) { hot.classList.remove('fx-hot'); hot = null; } }, true);

  // ---------- avatar ring on the "who am I" card ----------
  function decorate() {
    const w = document.querySelector('.whoami'); if (!w || w.querySelector('.fx-avatar')) return;
    const name = (w.querySelector('b') || {}).textContent || '';
    const a = document.createElement('span'); a.className = 'fx-avatar'; a.setAttribute('aria-hidden', 'true');
    a.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || '★';
    w.prepend(a);
  }
  const rail = document.getElementById('rail');
  if (rail) new MutationObserver(() => { decorate(); addFlairButton(rail); }).observe(rail, { childList: true });

  // ---------- Penny the money pet (original character) ----------
  const pet = document.createElement('div'); pet.className = 'pet'; pet.setAttribute('role', 'button'); pet.setAttribute('aria-label', 'Penny, your money pet. Tap her for a cheer.'); pet.tabIndex = 0;
  pet.innerHTML = `<svg viewBox="0 0 80 92" aria-hidden="true">
    <defs><radialGradient id="pg" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#d8dbe4"/><stop offset="1" stop-color="#8d92a3"/></radialGradient>
      <linearGradient id="pr" x1="0" x2="1"><stop offset="0" stop-color="var(--neon, #fff)"/><stop offset="1" stop-color="var(--neon-2, #ccd)"/></linearGradient></defs>
    <ellipse cx="40" cy="88" rx="20" ry="3.5" fill="rgba(255,255,255,.12)"/>
    <g class="pet-feet"><ellipse cx="29" cy="82" rx="7" ry="4.5" fill="#9aa0b1"/><ellipse cx="51" cy="82" rx="7" ry="4.5" fill="#9aa0b1"/></g>
    <path d="M14 30 Q10 18 18 16 Q22 22 22 27 Z" fill="#c9cdd8"/><path d="M66 30 Q70 18 62 16 Q58 22 58 27 Z" fill="#c9cdd8"/>
    <circle cx="40" cy="48" r="33" fill="url(#pg)" stroke="url(#pr)" stroke-width="2.5"/>
    <circle cx="40" cy="48" r="26" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1" stroke-dasharray="2 3"/>
    <g class="pet-eyes"><g class="pet-eye" data-x="29" data-y="41"><ellipse cx="29" cy="41" rx="5" ry="6" fill="#141418"/><circle class="pet-pupil" cx="30.5" cy="39" r="1.8" fill="#fff"/><rect class="pet-lid" x="23" y="34" width="12" height="13" rx="6" fill="#d3d7e1"/></g>
      <g class="pet-eye" data-x="51" data-y="41"><ellipse cx="51" cy="41" rx="5" ry="6" fill="#141418"/><circle class="pet-pupil" cx="52.5" cy="39" r="1.8" fill="#fff"/><rect class="pet-lid" x="45" y="34" width="12" height="13" rx="6" fill="#d3d7e1"/></g></g>
    <ellipse cx="22" cy="50" rx="4.5" ry="2.6" fill="var(--neon, #fff)" opacity=".45"/><ellipse cx="58" cy="50" rx="4.5" ry="2.6" fill="var(--neon, #fff)" opacity=".45"/>
    <path class="pet-mouth" d="M35 51 Q40 56 45 51" fill="none" stroke="#141418" stroke-width="2" stroke-linecap="round"/>
    <text x="40" y="71" text-anchor="middle" font-size="13" font-weight="800" font-family="-apple-system, system-ui, sans-serif" fill="#5d6274">$</text>
    <text class="pet-zzz" x="66" y="14" font-size="11" font-weight="700" fill="var(--neon, #fff)">z</text>
  </svg>`;
  document.body.appendChild(pet);
  const LINES = ['You got this!', 'One more call?', 'Money moves!', 'Nice work today', 'Follow-ups = funded', 'Let’s close one!', 'Proud of you', 'Coffee break?', 'Stay hydrated!', 'Big deal energy'];
  const say = (t) => { pet.querySelectorAll('.pet-bubble').forEach(b => b.remove()); const b = document.createElement('div'); b.className = 'pet-bubble'; b.textContent = t; pet.appendChild(b); setTimeout(() => b.remove(), 2900); };
  const hearts = (n = 5) => { for (let i = 0; i < n; i++) { const h = document.createElement('span'); h.className = 'pet-heart'; h.textContent = i % 2 ? '♥' : '$'; h.style.setProperty('--dx', ((Math.random() - .5) * 60).toFixed(0) + 'px'); h.style.animationDelay = (i * 0.12) + 's'; pet.appendChild(h); setTimeout(() => h.remove(), 1700 + i * 120); } };
  const mood = (cls, ms) => { pet.classList.remove('pet-happy', 'pet-jump'); void pet.offsetWidth; pet.classList.add(cls); setTimeout(() => pet.classList.remove(cls), ms); };
  let lastActive = Date.now();
  const wake = () => { lastActive = Date.now(); if (pet.classList.contains('pet-sleep')) { pet.classList.remove('pet-sleep'); say('I’m up! I’m up!'); } };
  pet.addEventListener('click', e => { e.stopPropagation(); wake(); mood('pet-happy', 1300); hearts(4); say(LINES[Math.floor(Math.random() * LINES.length)]); });
  pet.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pet.click(); } });
  // eyes follow the pointer
  document.addEventListener('pointermove', e => {
    lastActive = Date.now(); if (pet.classList.contains('pet-sleep')) wake();
    if (!motionOn()) return;
    const r = pet.getBoundingClientRect();
    pet.querySelectorAll('.pet-eye').forEach(eye => {
      const ex = r.left + (Number(eye.dataset.x) / 80) * r.width, ey = r.top + (Number(eye.dataset.y) / 92) * r.height;
      const a = Math.atan2(e.clientY - ey, e.clientX - ex), d = 2.2;
      const p = eye.querySelector('.pet-pupil'); p.setAttribute('cx', (Number(eye.dataset.x) + 1.5 + Math.cos(a) * d).toFixed(1)); p.setAttribute('cy', (Number(eye.dataset.y) - 2 + Math.sin(a) * d).toFixed(1));
    });
  }, { passive: true });
  document.addEventListener('keydown', () => { lastActive = Date.now(); });
  // blink now and then; nap after 3 idle minutes
  setInterval(() => { if (!motionOn() || pet.classList.contains('pet-sleep')) return; pet.classList.add('pet-blink'); setTimeout(() => pet.classList.remove('pet-blink'), 140); }, 4200);
  setInterval(() => { if (Date.now() - lastActive > 180000 && !pet.classList.contains('pet-sleep')) pet.classList.add('pet-sleep'); }, 15000);
  // cheer when a deal hits Funded / Closed / Approved (hooks the celebration from motion.js)
  const hook = () => {
    const M = window.SolverMotion; if (!M || M.__pet) return;
    const orig = M.celebrate; M.celebrate = (label, name, color) => { orig(label, name, color); wake(); mood('pet-jump', 1900); hearts(8); setTimeout(() => say(`${label}! Let’s go!`), 300); }; M.__pet = true;
  };
  hook(); setTimeout(hook, 500);

  // ---------- Flair picker ----------
  const THEMES = [['classic', 'Classic', '#ffffff'], ['cyan', 'Cyan', '#3ef2ff'], ['magenta', 'Magenta', '#ff4fd8'], ['lime', 'Lime', '#b6ff3e'], ['aurora', 'Aurora', '#9fd8ff']];
  function openFlair() {
    const wrap = document.createElement('div'); wrap.className = 'modal-wrap'; wrap.dataset.fx = '1';
    const cur = k => html.getAttribute('data-flair-' + k);
    const seg = (k, opts) => `<div class="tabs" role="group">${opts.map(([v, l]) => `<button class="tab" data-fx-set="${k}" data-v="${v}" aria-pressed="${cur(k) === v}">${l}</button>`).join('')}</div>`;
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Flair">
      <h3>Flair</h3><p>Make Solver.ca yours. Free, just for you, saved on this device.</p>
      <div class="fx-row"><div class="pop-section">Neon theme</div><div class="fx-swatches">${THEMES.map(([v, l, c]) => `<button class="fx-sw" data-fx-set="theme" data-v="${v}" aria-pressed="${cur('theme') === v}" aria-label="${l}"><i style="color:${c};background:${v === 'aurora' ? 'linear-gradient(135deg,#6dffcf,#b07bff)' : c}"></i><span>${l}</span></button>`).join('')}</div></div>
      <div class="fx-row"><div class="pop-section">Avatar ring</div>${seg('ring', [['spin', 'Neon spin'], ['sparkle', 'Spin + sparkle'], ['off', 'None']])}</div>
      <div class="fx-row"><div class="pop-section">Name</div>${seg('name', [['shimmer', 'Shimmer'], ['plain', 'Plain']])}</div>
      <div class="fx-row"><div class="pop-section">Penny the money pet</div>${seg('pet', [['on', 'Show Penny'], ['off', 'Hide']])}</div>
      <div class="form-row" style="margin-top:8px"><button class="btn primary" data-fx-close>Done</button><button class="btn" data-fx-party>Test confetti</button></div></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-fx-set]');
      if (b) { set(b.dataset.fxSet, b.dataset.v); wrap.querySelectorAll(`[data-fx-set="${b.dataset.fxSet}"]`).forEach(x => x.setAttribute('aria-pressed', x === b)); if (b.dataset.fxSet === 'pet' && b.dataset.v === 'on') { mood('pet-jump', 1900); say('Hi! I’m Penny'); } return; }
      if (e.target.closest('[data-fx-party]')) { window.SolverMotion && window.SolverMotion.celebrate('Funded', 'Just a test'); return; }
      if (e.target.closest('[data-fx-close]') || e.target === wrap) wrap.remove();
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', esc); } });
  }
  function addFlairButton(root) {
    if (!root || root.querySelector('[data-fx-open]')) return;
    const row = root.querySelector('.form-row:last-of-type'); if (!row) return;
    const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.dataset.fxOpen = '1'; b.textContent = '✦ Flair';
    b.addEventListener('click', e => { e.stopPropagation(); openFlair(); }); row.appendChild(b);
  }
  const layer = document.getElementById('layer');
  if (layer) new MutationObserver(() => { const m = layer.querySelector('.modal'); if (m && /Sign out/.test(m.textContent)) addFlairButton(m); }).observe(layer, { childList: true, subtree: true });
  setTimeout(() => { decorate(); addFlairButton(rail); }, 300);
  window.SolverFlair = { openFlair, say, set };
})();
