// Admin home: "Team this week" — dials, talks, pitches, sign-ups per rep (today / week) and which ads perform best.
(() => {
  'use strict';
  const S = () => (window.SolverApp && window.SolverApp.S) || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let data = null, loading = false, err = '', dim = 'campaign', got = 0;
  const n = v => v == null ? '—' : Number(v).toLocaleString('en-CA');
  const p = v => v == null ? '—' : v + '%';
  async function load(fresh) {
    if (loading) return; loading = true; err = ''; paint();
    try { data = await window.KS.api('GET', '/api/stats/admin' + (fresh ? '?fresh=1' : '')); got = Date.now(); } catch (e) { err = e.message || 'Couldn’t load stats.'; }
    loading = false; paint();
  }
  function html() {
    if (!data) return `<div class="st-card"><div class="st-h"><h2>Team this week</h2></div><p class="rail-note">${err ? esc(err) : 'Loading team stats… (first load takes ~20 s)'}</p></div>`;
    const d = data, R = d.reps, tot = k => R.reduce((a, r) => a + (r[k] || 0), 0);
    const best = (k) => R.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0))[0];
    const tiles = [
      ['Dials today', d.dialsOn ? n(tot('dialsToday')) : '—', d.dialsOn ? `${n(tot('dialsWeek'))} this week` : 'phone stats off'],
      ['Pitches today', n(tot('pitchesToday')), `${n(tot('pitchesWeek'))} this week`],
      ['Sign-ups today', n(tot('signedToday')), `${n(tot('signedWeek'))} this week`],
      ['New leads today', n(tot('leadsToday')), `${n(tot('leadsWeek'))} this week`],
    ];
    const top = best('signedWeek'), topP = best('pitchesWeek');
    const rows = R.map(r => {
      const pitchRate = r.leadsWeek ? Math.round(100 * r.pitchesWeek / r.leadsWeek) : null;
      return `<tr><td class="st-rep"><button class="linkish" data-st-open="${esc(r.board)}">${esc(r.rep)}</button>${top && r === top && r.signedWeek ? ' <span title="Most sign-ups this week">🏆</span>' : ''}</td>
        <td>${n(r.dialsToday)}<small>${r.dialsWeek == null ? '' : n(r.dialsWeek)}</small></td>
        <td>${n(r.talksToday)}<small>${r.talksWeek == null ? '' : n(r.talksWeek)}</small></td>
        <td>${n(r.pitchesToday)}<small>${n(r.pitchesWeek)}</small></td>
        <td class="st-good">${n(r.signedToday)}<small>${n(r.signedWeek)}</small></td>
        <td>${n(r.leadsToday)}<small>${n(r.leadsWeek)}</small></td>
        <td>${n(r.junkWeek)}</td><td>${n(r.callbacksWeek)}</td><td>${p(pitchRate)}</td><td>${n(r.uncontacted30)}</td></tr>`; }).join('');
    const src = d.sources.filter(s => s.dim === dim).slice(0, 12);
    const bar = (v, cls) => v == null ? '—' : `<span class="st-bar ${cls}"><i style="width:${Math.min(100, v)}%"></i><b>${v}%</b></span>`;
    return `<div class="st-card">
      <div class="st-h"><h2>Team this week</h2><span class="st-sub">Since Monday ${esc(d.weekStart)} · updated ${Math.max(0, Math.round((Date.now() - got) / 60000))} min ago</span><button class="btn" data-st-refresh>Refresh</button></div>
      <div class="st-tiles">${tiles.map(t => `<div class="st-tile"><span>${t[0]}</span><b>${t[1]}</b><small>${t[2]}</small></div>`).join('')}</div>
      ${top && top.signedWeek ? `<p class="st-callout">🏆 <b>${esc(top.rep)}</b> leads with ${top.signedWeek} sign-up${top.signedWeek > 1 ? 's' : ''} this week${topP && topP !== top && topP.pitchesWeek ? ` · most pitches: <b>${esc(topP.rep)}</b> (${topP.pitchesWeek})` : ''}.</p>` : ''}
      <div class="st-scroll"><table class="st-table"><thead><tr><th>Rep</th><th>Dials<small>today · wk</small></th><th>Talks 2m+<small>today · wk</small></th><th>Pitches<small>today · wk</small></th><th>Signed<small>today · wk</small></th><th>New leads<small>today · wk</small></th><th>Junked<small>wk</small></th><th>Callbacks<small>wk</small></th><th>Pitch rate<small>wk</small></th><th>Uncontacted<small>30 d</small></th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>
    <div class="st-card">
      <div class="st-h"><h2>Which leads perform best</h2><span class="st-sub">Leads from the last 30 days, where they are now</span>
        <span class="st-seg"><button class="${dim === 'campaign' ? 'on' : ''}" data-st-dim="campaign">Campaign</button><button class="${dim === 'ad' ? 'on' : ''}" data-st-dim="ad">Ad</button></span></div>
      <div class="st-scroll"><table class="st-table st-src"><thead><tr><th>${dim === 'ad' ? 'Ad' : 'Campaign'}</th><th>Leads</th><th>Cost / lead</th><th>Junk rate</th><th>Pitch rate</th><th>Sign-up rate</th><th>Signed</th></tr></thead>
      <tbody>${src.map((s, k) => `<tr><td class="st-name">${k === 0 && s.signRate ? '⭐ ' : ''}${esc(s.name)}<small>${esc(s.reps.join(', '))}</small></td><td>${n(s.leads)}</td><td>${s.cpl == null ? '<span class="st-muted">—</span>' : '$' + s.cpl}</td><td>${bar(s.junkRate, 'bad')}</td><td>${bar(s.pitchRate, 'mid')}</td><td>${bar(s.signRate, 'good')}</td><td>${n(s.signed)}</td></tr>`).join('') || '<tr><td colspan="7" class="st-muted">Not enough leads yet.</td></tr>'}</tbody></table></div>
      ${d.spendOn ? '' : '<p class="rail-note">Cost per lead appears once Facebook ad spend is connected.</p>'}
    </div>`;
  }
  function paint() {
    const host = document.querySelector('#content .home-top'); if (!host) return;
    let el = document.getElementById('admin-stats');
    if (!el) { el = document.createElement('section'); el.id = 'admin-stats'; host.insertAdjacentElement('afterend', el); }
    el.innerHTML = html();
  }
  function check() {
    const s = S(); if (!s.me || s.me.role !== 'admin' || s.page !== 'home') return;
    const host = document.querySelector('#content .home-top'); if (!host) return;
    if (!document.getElementById('admin-stats')) paint();
    if (!data && !loading && !err) load(false); else if (data && Date.now() - got > 10 * 60e3 && !loading) load(false);
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-st-refresh],[data-st-dim],[data-st-open]'); if (!t) return;
    if (t.dataset.stRefresh !== undefined) load(true);
    else if (t.dataset.stDim) { dim = t.dataset.stDim; paint(); }
    else if (t.dataset.stOpen && window.SolverOpen) window.SolverOpen(t.dataset.stOpen);
  });
  new MutationObserver(() => check()).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(check, 30000);
})();
