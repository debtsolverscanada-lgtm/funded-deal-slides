// "Install app": adds Solver.ca to the computer or phone. Chrome/Edge/Android get the real install prompt;
// iPhone/iPad (Safari) get the two-tap instructions. Hidden once the app is installed and running on its own.
(() => {
  'use strict';
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let prompt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; addButtons(); });
  addEventListener('appinstalled', () => { prompt = null; document.querySelectorAll('[data-install]').forEach(b => b.remove()); toast('Solver.ca is installed. Open it from your apps.'); });
  function toast(text) {
    const box = document.querySelector('.toasts') || document.body;
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text; box.appendChild(t); setTimeout(() => t.remove(), 6000);
  }
  function howTo() {
    if (ios) return toast('On iPhone or iPad: tap the Share button in Safari, then "Add to Home Screen".');
    toast('In Chrome or Edge: open the browser menu, then "Install Solver.ca" (or "Cast, save and share" > "Install page as app").');
  }
  async function install() {
    if (prompt) { prompt.prompt(); const r = await prompt.userChoice.catch(() => null); prompt = null; if (!r || r.outcome !== 'accepted') addButtons(); return; }
    howTo();
  }
  function addButtons() {
    if (standalone()) return;
    for (const root of [document.getElementById('rail'), document.querySelector('#layer .modal')]) {
      if (!root || root.querySelector('[data-install]')) continue;
      const row = root.querySelector('.form-row:last-of-type'); if (!row) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.dataset.install = '1'; b.textContent = 'Install app';
      b.title = 'Add Solver.ca to this computer or phone, with its own icon and window';
      b.addEventListener('click', ev => { ev.stopPropagation(); install(); });
      row.appendChild(b);
    }
  }
  const watch = el => el && new MutationObserver(addButtons).observe(el, { childList: true, subtree: el.id === 'layer' });
  addEventListener('DOMContentLoaded', () => { watch(document.getElementById('rail')); watch(document.getElementById('layer')); addButtons(); });
  window.SolverInstall = install;
})();
