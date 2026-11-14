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

  // ---------- Penny's heads-ups: new leads, text/call activity, notes, moves, mentions ----------
  // Setting (Flair): all boards / only mine / off. Bursts are bundled; tap the bubble to open the lead.
  html.setAttribute('data-flair-news', get('news', 'mine'));
  const ICON = { new: '✨', text: '💬', call: '📞', email: '✉️', docs: '📎', note: '📝', moved: '➡️', mention: '👋', due: '⏰' };
  const queue = []; let showing = null, flushTimer = null;
  const me = () => (window.SolverMe ? window.SolverMe() : { name: '', homeBoard: '', boards: [] });
  function mine(ev) {
    const m = me(), first = String(m.name || '').split(/\s+/)[0].toLowerCase();
    if (m.homeBoard && ev.board === m.homeBoard) return true;
    if (first && first !== 'your' && String(ev.boardName || '').toLowerCase().includes('(' + first)) return true;
    if (first && first !== 'your' && new RegExp('^' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(leads|crm)\\b').test(String(ev.boardName || '').toLowerCase())) return true; // a rep's own lead board ("Jerico Leads", "Mariel CRM"), like the admin stats read it
    if (first && String(ev.people || '').toLowerCase().split(/,\s*/).some(p => p.split(' ')[0] === first)) return true;
    return false;
  }
  function showNews(text, sub, open) {
    if (html.getAttribute('data-flair-pet') === 'off') return;
    pet.querySelectorAll('.pet-news').forEach(b => b.remove());
    const b = document.createElement('div'); b.className = 'pet-news'; b.setAttribute('role', 'status');
    const t = document.createElement('div'); t.textContent = text; b.appendChild(t);
    if (sub && matchMedia('(hover: hover) and (pointer: fine)').matches) sub = sub.replace(/\bTap to\b/, 'Click to'); // a mouse clicks, a finger taps
    if (sub) { const s2 = document.createElement('small'); s2.textContent = sub; b.appendChild(s2); }
    const x = document.createElement('button'); x.className = 'pn-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss'); b.appendChild(x);
    b.addEventListener('click', e => { e.stopPropagation(); if (e.target === x) { b.classList.add('out'); setTimeout(() => b.remove(), 300); return; } b.remove(); if (open) open(); });
    pet.appendChild(b); wake(); mood('pet-happy', 1200); if (motionOn()) hearts(2);
    clearTimeout(showing); showing = setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 300); }, 6500);
  }
  function flush() {
    flushTimer = null; if (!queue.length) return;
    const batch = queue.splice(0);
    if (batch.length === 1) { const ev = batch[0]; showNews(`${ICON[ev.kind] || '✨'} ${ev.text}`, ev.boardName && !ev.text.includes(ev.boardName) ? ev.boardName : 'Tap to open', () => window.SolverOpen && window.SolverOpen(ev.board, ev.item)); return; }
    const byKind = {}; batch.forEach(ev => (byKind[ev.kind] = byKind[ev.kind] || []).push(ev));
    const parts = Object.entries(byKind).map(([k, v]) => k === 'new' ? `${v.length} new lead${v.length > 1 ? 's' : ''}` : k === 'text' ? `${v.length} text${v.length > 1 ? 's' : ''}` : k === 'call' ? `${v.length} call${v.length > 1 ? 's' : ''}` : k === 'note' ? `${v.length} new note${v.length > 1 ? 's' : ''}` : k === 'moved' ? `${v.length} move${v.length > 1 ? 's' : ''}` : `${v.length} update${v.length > 1 ? 's' : ''}`);
    const first = batch[batch.length - 1];
    showNews(`🎉 ${parts.join(', ')} just came in!`, `Latest: ${first.name}. Tap to open`, () => window.SolverOpen && window.SolverOpen(first.board, first.item));
  }
  function onBuzz(ev) {
    const setting = html.getAttribute('data-flair-news'); if (setting === 'off' || !ev) return;
    if (ev.by && window.SolverMe && ev.by === window.SolverMe().id) return; // not your own changes
    if (setting === 'mine' && !mine(ev)) return;
    queue.push(ev); if (queue.length > 30) queue.shift();
    if (!flushTimer) flushTimer = setTimeout(flush, 2500);
  }
  (function attach() { if (window.KS && window.KS.on) { window.KS.on('buzz', onBuzz); window.KS.on('notify', n => { if (n && /mention/i.test(n.kind || '')) onBuzz({ kind: 'mention', text: 'Psst… you were mentioned!', board: n.board, item: n.item, name: '', boardName: '', people: '' , by: '' }); }); } else setTimeout(attach, 400); })();
  // a little hello with today's follow-ups, once per day
  setTimeout(async () => {
    try {
      const today = new Date().toDateString(); if (get('hello', '') === today || html.getAttribute('data-flair-news') === 'off') return;
      const ws = (localStorage.getItem('ks-ws') || 'main'); const sm = window.KS && window.KS.summary ? await window.KS.summary(ws) : null;
      const f = sm && sm.followups; if (!f) return; set('hello', today);
      const first = String(me().name || '').split(/\s+/)[0]; const hi = first && !/^your$/i.test(first) ? `Hi ${first}! ` : 'Hi! ';
      if (f.dueToday || f.overdue) showNews(`⏰ ${hi}${f.dueToday} follow-up${f.dueToday === 1 ? '' : 's'} due today${f.overdue ? `, ${f.overdue} overdue` : ''}.`, 'Tap to see the calendar', () => document.querySelector('[data-act="go-calendar"]') && document.querySelector('[data-act="go-calendar"]').click());
      else showNews(`☀️ ${hi}No follow-ups due today. Let’s find a new deal!`);
    } catch (e) {}
  }, 4000);


  // ---------- Penny wanders: strolls along the bottom and hides behind boards, peeking over the edge ----------
  // Only with Motion: Full and "Penny wanders" on. Never while a heads-up is open, a window or drawer is open,
  // you are typing or dragging, or the tab is in the background. Tap her any time: she comes straight home.
  html.setAttribute('data-flair-roam', get('roam', 'on'));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let pos = { x: 0, y: 0 }, roaming = false, cancel = false, lastKey = 0;
  document.addEventListener('keydown', () => { lastKey = Date.now(); }, true);
  const canRoam = () => motionOn() && !html.classList.contains('pet-docked') && !html.classList.contains('mx-calm') && html.getAttribute('data-flair-roam') !== 'off' && html.getAttribute('data-flair-pet') !== 'off'
    && document.visibilityState === 'visible' && !pet.classList.contains('pet-sleep') && !pet.querySelector('.pet-news')
    && !document.querySelector('#layer .drawer, #layer .modal, .modal-wrap, .mx-banner, .mx-dragging') && Date.now() - lastKey > 8000;
  const place = (x, y, ms) => { pos = { x, y }; pet.style.transition = ms ? `transform ${ms}ms linear` : 'none'; pet.style.transform = (x || y) ? `translate(${Math.round(x)}px, ${Math.round(y)}px)` : ''; };
  const home0 = () => { const t = pet.style.transform; pet.style.transform = ''; const r = pet.getBoundingClientRect(); pet.style.transform = t; return r; };
  // a window, drawer or the bulk bar opened: Penny stops wandering at once (and CSS hides her until it closes)
  const overlayOpen = () => !!document.querySelector('#layer .drawer, #layer .modal-wrap, #layer .bulkbar, #fx-layer .modal-wrap, #fx-layer .fx-search-wrap, body > .modal-wrap, body > .fx-menu');
  // html.pet-away hides her (CSS) while any of those is open
  const away = () => { const o = overlayOpen(); html.classList.toggle('pet-away', o); if (o && (roaming || pos.x || pos.y)) { cancel = true; place(0, 0, 0); pet.classList.remove('pet-peek', 'pet-duck', 'pet-walk'); } };
  [document.getElementById('layer'), document.body].forEach(el => el && new MutationObserver(away).observe(el, { childList: true }));
  setTimeout(() => { const f = document.getElementById('fx-layer'); if (f) new MutationObserver(away).observe(f, { childList: true }); }, 0);
  async function walkTo(x, y = pos.y) {
    const dist = Math.hypot(x - pos.x, y - pos.y); if (dist < 4) return;
    pet.classList.add('pet-walk'); pet.classList.toggle('pet-lean-left', x < pos.x);
    const ms = Math.max(500, dist / 95 * 1000); place(x, y, ms);
    for (let t = 0; t < ms && !cancel; t += 100) { await wait(100); if (overlayOpen()) cancel = true; }
    pet.classList.remove('pet-walk', 'pet-lean-left');
  }
  async function goHome(quick) {
    pet.classList.remove('pet-peek', 'pet-duck');
    if (quick || pos.y) { pet.classList.add('pet-duck'); await wait(260); place(pos.x, 0, 0); await wait(30); pet.classList.remove('pet-duck'); await wait(260); }
    cancel = false; await walkTo(0, 0); place(0, 0, 0);
  }
  function hidingSpot() {
    const r0 = home0(), w = r0.width, h = r0.height, nb = document.querySelector('.bnav'), nr = nb && nb.getBoundingClientRect(), navTop = nr && nr.height > 0 ? nr.top : innerHeight;
    const spots = [...document.querySelectorAll('.hero, .ov, .qa, .li, .lane, .tablewrap, .group, .glass, .card')].map(el => el.getBoundingClientRect())
      .filter(r => r.width > w * 1.6 && r.top > 80 + h * .55 && r.top < Math.min(innerHeight, navTop) - 160 && r.left >= 0 && r.right <= innerWidth);
    if (!spots.length) return null;
    const r = spots[Math.floor(Math.random() * spots.length)];
    const left = r.left + 12 + Math.random() * Math.max(0, r.width - w - 24);
    return { x: left - r0.left, y: r.top - h * 0.52 - r0.top };
  }
  async function roam() {
    if (roaming || !canRoam()) return; roaming = true; cancel = false;
    try {
      const r0 = home0(), wide = innerWidth > 780;
      const minX = wide ? 0 : 12 - r0.left, maxX = innerWidth - 16 - r0.right;
      if (Math.random() < 0.4) {
        const spot = hidingSpot();
        if (spot) {
          await walkTo(Math.min(maxX, Math.max(minX, spot.x)), 0); if (cancel) return;
          pet.classList.add('pet-duck'); await wait(260);                       // ducks out of sight...
          place(spot.x, spot.y, 0); pet.classList.add('pet-peek'); await wait(30);
          pet.classList.remove('pet-duck');                                      // ...and peeks over the board
          const onScroll = () => { cancel = true; }; addEventListener('scroll', onScroll, { capture: true, once: true, passive: true });
          for (let t = 0, stay = 3500 + Math.random() * 3500; t < stay && !cancel; t += 100) { await wait(100); if (overlayOpen()) { cancel = true; break; } if (t === 1500 && Math.random() < .5) say(['Peekaboo!', 'You can’t see me', 'Shhh… hiding', 'Find me!'][Math.floor(Math.random() * 4)]); }
          removeEventListener('scroll', onScroll, { capture: true });
          await goHome(true); return;
        }
      }
      // a short stroll and back
      const dir = maxX < 60 ? -1 : minX > -60 ? 1 : (Math.random() < .5 ? -1 : 1); // walk toward the side with room
      const x = Math.min(maxX, Math.max(minX, dir * (60 + Math.random() * Math.min(260, innerWidth / 3))));
      await walkTo(x, 0); if (!cancel) await wait(900 + Math.random() * 1600);
      if (!cancel && Math.random() < .3) say(['Just stretching my legs', 'La la la', 'Checking on the deals', 'Hi!'][Math.floor(Math.random() * 4)]);
      if (!cancel) await wait(1200);
      await goHome(false);
    } finally { roaming = false; cancel = false; }
  }
  pet.addEventListener('click', () => { if (roaming || pos.x || pos.y) { cancel = true; setTimeout(() => { if (!roaming) goHome(true); }, 50); if (pet.classList.contains('pet-peek')) setTimeout(() => say('You found me!'), 120); } }, true);
  addEventListener('resize', () => { if (!roaming) place(0, 0, 0); });
  (function schedule() { setTimeout(() => { roam().finally(schedule); }, 22000 + Math.random() * 38000); })();

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
      <div class="fx-row"><div class="pop-section">Penny wanders</div>${seg('roam', [['on', 'Walks and hides'], ['off', 'Stays put']])}</div>
      <div class="fx-row"><div class="pop-section">Penny’s heads-ups</div>${seg('news', [['mine', 'My boards'], ['all', 'All boards'], ['off', 'Off']])}<p style="margin-top:8px">New leads, texts, calls, notes and mentions, as little bubbles. Tap one to open the lead.</p></div>
      <div class="form-row" style="margin-top:8px"><button class="btn primary" data-fx-close>Done</button><button class="btn" data-fx-party>Test confetti</button></div></div>`;
    const back = document.activeElement;
    document.body.appendChild(wrap);
    // it's aria-modal: focus moves in, Tab stays inside, and closing hands focus back to the Flair button
    const focusables = () => [...wrap.querySelectorAll('button:not([disabled])')];
    const close = () => { if (!wrap.isConnected) return; wrap.remove(); if (back && back.isConnected && back.focus) back.focus(); };
    const first = wrap.querySelector('.fx-sw[aria-pressed="true"]') || focusables()[0]; if (first) first.focus();
    wrap.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return; const f = focusables(); if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    });
    wrap.addEventListener('focusout', e => { if (wrap.isConnected && e.relatedTarget && !wrap.contains(e.relatedTarget)) { const f = focusables(); if (f[0]) f[0].focus(); } });
    wrap.addEventListener('click', e => {
      const b = e.target.closest('[data-fx-set]');
      if (b) { set(b.dataset.fxSet, b.dataset.v); wrap.querySelectorAll(`[data-fx-set="${b.dataset.fxSet}"]`).forEach(x => x.setAttribute('aria-pressed', x === b)); if (b.dataset.fxSet === 'pet' && b.dataset.v === 'on') { mood('pet-jump', 1900); say('Hi! I’m Penny'); } return; }
      if (e.target.closest('[data-fx-party]')) { window.SolverMotion && window.SolverMotion.celebrate('Funded', 'Just a test'); return; }
      if (e.target.closest('[data-fx-close]') || e.target === wrap) close();
    });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  }
  function addFlairButton(root) {
    if (!root || root.querySelector('[data-fx-open]')) return;
    const row = root.querySelector('[data-slot="settings"]') || root.querySelector('.form-row:last-of-type'); if (!row) return;
    const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.dataset.fxOpen = '1'; b.textContent = row.closest('.pf-group') ? 'Flair' : '✦ Flair'; // the profile sheet draws its own star icon
    b.addEventListener('click', e => { e.stopPropagation(); openFlair(); }); row.appendChild(b);
  }
  const layer = document.getElementById('layer');
  if (layer) new MutationObserver(() => { const m = layer.querySelector('.modal'); if (m && m.querySelector('[data-slot="settings"]')) addFlairButton(m); }).observe(layer, { childList: true });
  setTimeout(() => { decorate(); addFlairButton(rail); }, 300);
  // ---------- Penny's desk: on computers she sits at her desk in the sidebar instead of roaming over the leads ----------
  function dock() {
    const spot = document.querySelector('#rail .penny-desk .pd-spot');
    const r = spot && spot.offsetParent !== null ? spot.getBoundingClientRect() : null;
    const on = !!(r && r.width && innerWidth > 780 && html.getAttribute('data-flair-pet') !== 'off');
    html.classList.toggle('pet-docked', on);
    html.classList.toggle('pet-nodesk', !on && innerWidth > 780); // computer with no desk showing (short screen): no floating over the leads
    // phones: on a board she floats over the rows, so taps go through her to the cell underneath (her heads-ups stay tappable)
    html.classList.toggle('pet-thru', innerWidth <= 780 && !!(window.SolverApp && window.SolverApp.S && window.SolverApp.S.page === 'board'));
    if (on) { html.style.setProperty('--pd-left', Math.round(r.left) + 'px'); html.style.setProperty('--pd-bottom', Math.round(innerHeight - r.bottom) + 'px'); if (pos.x || pos.y) place(0, 0, 0); }
  }
  if (rail) new MutationObserver(() => requestAnimationFrame(dock)).observe(rail, { childList: true, subtree: true });
  addEventListener('resize', () => requestAnimationFrame(dock));
  setTimeout(dock, 300); setInterval(dock, 4000); addEventListener('click', () => setTimeout(dock, 60)); // a tap can change the page
  window.SolverFlair = { openFlair, say, set, roam };
})();
