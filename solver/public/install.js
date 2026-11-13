// "Install app": adds Solver.ca to the computer or phone. Chrome/Edge/Android get the real install prompt;
// iPhone/iPad (Safari) get the two-tap instructions. Hidden once the app is installed and running on its own.
(() => {
  'use strict';
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /android/i.test(navigator.userAgent);
  let prompt = null, installed = false;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); prompt = e; installed = false; addButtons(); });
  addEventListener('appinstalled', () => { prompt = null; installed = true; document.querySelectorAll('[data-install]').forEach(b => b.remove()); toast('Solver.ca is installed. Open it from your apps.'); });
  function toast(text, ms = 6000) {
    const box = document.querySelector('.toasts') || document.body;
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text; box.appendChild(t); setTimeout(() => t.remove(), ms);
  }
  function howTo() {
    if (ios) return toast('On iPhone or iPad, in Safari: tap the Share button, or the ≡ menu in the address bar and then Share. Choose "Add to Home Screen" (under "View More" if you don\'t see it), leave "Open as Web App" on, and tap Add.', 12000);
    if (android) return toast('On Android, in Chrome: tap the ⋮ menu at the top right and choose "Add to Home screen" or "Install app", then tap Install.', 10000);
    toast('In Chrome or Edge: click the install icon at the right of the address bar, or open the browser menu and choose "Install Solver.ca" (in Chrome: "Cast, save and share" > "Install page as app").', 10000);
  }
  async function install() {
    if (prompt) { prompt.prompt(); const r = await prompt.userChoice.catch(() => null); prompt = null; if (!r || r.outcome !== 'accepted') addButtons(); return; }
    howTo();
  }
  function addButtons() {
    if (standalone() || installed) return;
    // only the sidebar and the Profile sheet have the settings slot (Motion, Flair, Install app)
    for (const root of [document.getElementById('rail'), document.querySelector('#layer .modal')]) {
      if (!root || root.querySelector('[data-install]')) continue;
      const row = root.querySelector('[data-slot="settings"]'); if (!row) continue;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.dataset.install = '1'; b.textContent = 'Install app';
      b.title = 'Add Solver.ca to this computer or phone, with its own icon and window';
      b.addEventListener('click', ev => { ev.stopPropagation(); install(); });
      row.appendChild(b);
    }
  }
  const watch = el => el && new MutationObserver(addButtons).observe(el, { childList: true });
  addEventListener('DOMContentLoaded', () => { watch(document.getElementById('rail')); watch(document.getElementById('layer')); addButtons(); });
  window.SolverInstall = install;
})();
