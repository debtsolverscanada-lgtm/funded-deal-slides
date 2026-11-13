// Solver.ca colour themes: Dark (default), Light, Grey, Maroon, Blue, Beige. Remembered per device (ks-theme).
// Loaded in <head> so the page never flashes the wrong colours.
//   Light / Beige: the dark design is turned light with one filter on the page; photos, videos, the gold coin and
//   Penny are turned back so they keep their real colours. Beige adds a warm paper tint on top.
//   Grey / Maroon / Blue: the dark design stays, its blacks are lifted to a tint (white text stays white).
(() => {
  'use strict';
  const THEMES = [
    ['dark', 'Dark', '#0b0b0d'], ['light', 'Light', '#f4f4f6'], ['grey', 'Grey', '#3a3b40'],
    ['maroon', 'Maroon', '#4a1020'], ['blue', 'Blue', '#102a5c'], ['beige', 'Beige', '#efe3cf'],
  ];
  const get = () => { try { const t = localStorage.getItem('ks-theme'); return THEMES.some(x => x[0] === t) ? t : 'dark'; } catch (e) { return 'dark'; } };
  const KEEP = '.home-hero, video, img, picture, canvas#coins, .pet, .penny, .penny-desk, .fx-avatar img, .mx-confetti, iframe, #newlead, .qr-box, .emo, .chip[style*="--c"], .pill[style*="--c"]';
  const css = `
  html[data-theme="light"], html[data-theme="beige"] { filter: invert(1) hue-rotate(180deg); }
  html[data-theme="light"] :is(${KEEP}):not(.home-hero *):not(.penny-desk *):not(#newlead *):not(.qr-box *), html[data-theme="beige"] :is(${KEEP}):not(.home-hero *):not(.penny-desk *):not(#newlead *):not(.qr-box *) { filter: invert(1) hue-rotate(180deg); }
  html[data-theme] { background: #000; }
  html[data-theme]:not([data-theme="dark"])::after { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
  html[data-theme="grey"]::after { background: #34353a; mix-blend-mode: screen; }
  html[data-theme="maroon"]::after { background: #3d0c19; mix-blend-mode: screen; }
  html[data-theme="blue"]::after { background: #0b1d44; mix-blend-mode: screen; }
  html[data-theme="beige"]::after { background: #302410; mix-blend-mode: screen; }
  /* the theme picker in the Profile sheet */
  .th-row { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; }
  .th-row > b { font-weight: 500; font-size: 15px; display: flex; align-items: center; gap: 10px; }
  .th-row > b::before { content: ""; width: 30px; height: 30px; flex: none; border-radius: 9px; background: rgba(255,255,255,.08) center / 17px no-repeat url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23fff" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="%23fff"/></svg>'); }
  .th-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
  .th-sw { display: flex; flex-direction: column; align-items: center; gap: 5px; border: 0; background: none; color: inherit; font: inherit; font-size: 11px; cursor: pointer; padding: 2px; min-width: 48px; }
  .th-sw i { width: 34px; height: 34px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25); box-shadow: inset 0 0 0 2px rgba(0,0,0,.35); }
  .th-sw[aria-pressed="true"] i { border-color: #fff; box-shadow: 0 0 0 3px rgba(255,255,255,.25), inset 0 0 0 2px rgba(0,0,0,.35); }
  .th-sw[aria-pressed="true"] span { font-weight: 700; }
  `;
  const st = document.createElement('style'); st.id = 'ks-theme-css'; st.textContent = css; document.head.appendChild(st);
  const meta = () => document.querySelector('meta[name="theme-color"]');
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    const m = meta(); if (m) m.setAttribute('content', (THEMES.find(x => x[0] === t) || THEMES[0])[2]);
  }
  apply(get());

  // the swatches sit under the page-wide invert / screen tint like everything else, so each one is painted with the colour
  // that comes out as its real colour after them (a colour darker than the tint cannot come out darker; it stays the tint)
  const TINT = { grey: '#34353a', maroon: '#3d0c19', blue: '#0b1d44', beige: '#302410' };
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const flip = ([r, g, b]) => { r = 1 - r; g = 1 - g; b = 1 - b; return [-0.574 * r + 1.43 * g + 0.144 * b, 0.426 * r + 0.43 * g + 0.144 * b, 0.426 * r + 1.43 * g - 0.856 * b]; }; // invert(1) hue-rotate(180deg)
  function swatch(c) {
    const t = get(); let s = rgb(c);
    if (t === 'light' || t === 'beige') s = flip(s);
    if (TINT[t]) { const o = rgb(TINT[t]); s = s.map((v, i) => 1 - (1 - v) / (1 - o[i])); }
    return 'rgb(' + s.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',') + ')';
  }

  // a "Theme" row with six swatches wherever the app has a settings slot (the Profile sheet)
  function addPicker(root) {
    root.querySelectorAll('[data-slot="settings"]').forEach(slot => { if (!slot.hidden && !slot.querySelector('.th-row')) addTo(slot); });
  }
  function addTo(slot) {
    const row = document.createElement('div'); row.className = 'th-row';
    row.innerHTML = '<b>Theme</b><div class="th-swatches" role="group" aria-label="Theme colour">' + THEMES.map(([k, l, c]) => `<button type="button" class="th-sw" data-theme-pick="${k}" aria-pressed="${get() === k}"><i data-c="${c}" style="background:${swatch(c)}"></i><span>${l}</span></button>`).join('') + '</div>';
    row.addEventListener('click', e => {
      const b = e.target.closest('[data-theme-pick]'); if (!b) return; e.stopPropagation();
      const t = b.dataset.themePick; try { localStorage.setItem('ks-theme', t); } catch (x) {}
      apply(t); row.querySelectorAll('[data-theme-pick]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.themePick === t)));
      row.querySelectorAll('.th-sw i[data-c]').forEach(i => { i.style.background = swatch(i.dataset.c); });
    });
    slot.prepend(row);
  }
  const watch = () => {
    const layer = document.getElementById('layer') || document.body;
    new MutationObserver(() => addPicker(document)).observe(layer, { childList: true, subtree: true });
    addPicker(document);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  window.SolverTheme = { apply, get, THEMES };
})();
