// Address suggestions: in any field whose column name has "address" in it (Property Address, Address(es)…), typing
// 4+ characters shows matching Canadian addresses; pick one (click, or arrows + Enter) and the full address is filled
// in and saved like a normal edit. Uses Photon (photon.komoot.io, OpenStreetMap data, free, no key); only what was
// typed in that box is sent. Never fills anything on its own.
(() => {
  'use strict';
  const PROV = { Alberta: 'AB', 'British Columbia': 'BC', Saskatchewan: 'SK', Manitoba: 'MB', Ontario: 'ON', Quebec: 'QC', 'Québec': 'QC', 'New Brunswick': 'NB', 'Nova Scotia': 'NS', 'Prince Edward Island': 'PE', 'Newfoundland and Labrador': 'NL', Yukon: 'YT', 'Northwest Territories': 'NT', Nunavut: 'NU' };
  const isAddr = el => el && el.matches && el.matches('input.cell-input[data-edit="value"]:not([readonly])') && /address|street|property\s*location/i.test(el.getAttribute('aria-label') || '') && !/e-?mail/i.test(el.getAttribute('aria-label') || '');
  let pop = null, field = null, list = [], on = -1, timer = 0, ctl = null;
  const close = () => { if (pop) pop.remove(); pop = null; list = []; on = -1; };
  const fmt = p => {
    const line1 = [p.housenumber, p.street].filter(Boolean).join(' ') || p.name || '';
    const prov = PROV[p.state] || p.state || '';
    return [line1, p.city || p.town || p.village || p.district, [prov, p.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  };
  function show(el, items) {
    close(); if (!items.length || document.activeElement !== el) return;
    field = el; list = items; pop = document.createElement('div'); pop.className = 'addr-pop'; pop.setAttribute('role', 'listbox');
    pop.innerHTML = items.map((t, k) => `<button type="button" role="option" data-k="${k}">${t.main.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}<small>${t.sub.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</small></button>`).join('') + '<div class="addr-note">Address suggestions · OpenStreetMap</div>';
    const r = el.getBoundingClientRect(); pop.style.left = Math.round(r.left) + 'px'; pop.style.width = Math.max(280, Math.round(r.width)) + 'px';
    const below = innerHeight - r.bottom > 240; pop.style.top = below ? Math.round(r.bottom + 4) + 'px' : ''; pop.style.bottom = below ? '' : Math.round(innerHeight - r.top + 4) + 'px';
    pop.addEventListener('mousedown', e => e.preventDefault());
    pop.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) pick(+b.dataset.k); });
    document.body.appendChild(pop);
  }
  function pick(k) {
    const it = list[k]; if (!it || !field) return close();
    field.value = it.full; close();
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function lookup(el) {
    const q = el.value.trim(); if (q.length < 4) return close();
    if (ctl) ctl.abort(); ctl = new AbortController();
    try {
      const u = 'https://photon.komoot.io/api/?limit=6&lang=en&bbox=-141.1,41.6,-52.6,83.2&q=' + encodeURIComponent(q);
      const d = await (await fetch(u, { signal: ctl.signal })).json();
      const seen = new Set(), items = [];
      for (const f of (d.features || [])) {
        const p = f.properties || {}; if (p.countrycode && p.countrycode !== 'CA') continue;
        const full = fmt(p); if (!full || seen.has(full)) continue; seen.add(full);
        const parts = full.split(', '); items.push({ full, main: parts[0], sub: parts.slice(1).join(', ') });
      }
      show(el, items);
    } catch (e) { if (e.name !== 'AbortError') close(); }
  }
  document.addEventListener('input', e => { if (!isAddr(e.target)) return; clearTimeout(timer); const el = e.target; timer = setTimeout(() => lookup(el), 280); });
  document.addEventListener('keydown', e => {
    if (!pop || e.target !== field) return;
    const btns = [...pop.querySelectorAll('[data-k]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); on = (on + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length; btns.forEach((b, k) => b.classList.toggle('on', k === on)); }
    else if (e.key === 'Enter' && on >= 0) { e.preventDefault(); e.stopPropagation(); pick(on); }
    else if (e.key === 'Escape') { close(); }
  }, true);
  document.addEventListener('focusout', e => { if (e.target === field) setTimeout(close, 150); });
  addEventListener('scroll', () => close(), true); addEventListener('resize', close);
})();
