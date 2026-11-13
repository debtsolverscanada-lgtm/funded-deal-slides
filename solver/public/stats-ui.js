// Admin home: "Team this week" — dials, talks, pitches, sign-ups per rep (today / week) and which ads perform best.
(() => {
  'use strict';
  const S = () => (window.SolverApp && window.SolverApp.S) || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let data = null, loading = false, err = '', dim = 'campaign', got = 0;
  const n = v => v == null ? '—' : Number(v).toLocaleString('en-CA');
  const p = v => v == null ? '—' : v + '%';
  const built = () => { const t = data && Date.parse(data.at); return t > 0 ? t : got; }; // the server's build time (the data may come from its 10-min cache)
  const ago = () => `updated ${Math.max(0, Math.round((Date.now() - built()) / 60000))} min ago`;
  async function load(fresh) {
    if (loading) return; loading = true; err = ''; paint();
    try { data = await window.KS.api('GET', '/api/stats/admin' + (fresh ? '?fresh=1' : '')); got = Date.now(); } catch (e) { err = e.message || 'Couldn’t load stats.'; }
    loading = false; paint();
  }
  function html() {
    if (!data) return `<div class="st-card"><div class="st-h"><h2>Team this week</h2></div><p class="rail-note">${err ? esc(err) : 'Loading team stats… (first load takes ~20 s)'}</p></div>`;
    const d = data, R = d.reps, tot = k => R.reduce((a, r) => a + (r[k] || 0), 0);
    const dOn = d.dialsOn && R.some(r => r.dialsToday != null || r.dialsWeek != null); // no rep matched the phone data = phone stats off, not 0 dials
    const best = (k) => R.slice().sort((a, b) => (b[k] || 0) - (a[k] || 0))[0];
    const tiles = [
      ['Dials today', dOn ? n(tot('dialsToday')) : '—', dOn ? `${n(tot('dialsWeek'))} this week` : 'phone stats off'],
      ['Pitches today', n(tot('pitchesToday')), `${n(tot('pitchesWeek'))} this week`],
      ['Sign-ups today', n(tot('signedToday')), `${n(tot('signedWeek'))} this week`],
      ['New leads today', n(tot('leadsToday')), `${n(tot('leadsWeek'))} this week`],
    ];
    const top = best('signedWeek'), topP = best('pitchesWeek');
    const bub = (label, today, week, cls = '') => `<div class="st-bub ${cls}"><span title="${label}">${label}</span><b>${today}</b>${week !== undefined ? `<small>${week}</small>` : ''}</div>`;
    const cards = R.map(r => {
      const pitchRate = r.pitchRateWeek;
      return `<div class="st-rep-card${top && r === top && r.signedWeek ? ' st-top' : ''}">
        <div class="st-rep-h"><span class="st-av">${esc((r.rep || '?').slice(0, 1))}</span><button class="linkish" data-st-open="${esc(r.board)}">${esc(r.rep)}</button>${top && r === top && r.signedWeek ? '<span class="st-badge">🏆 Top this week</span>' : ''}</div>
        <div class="st-bubs">
          ${bub('📞 Dials', n(r.dialsToday), r.dialsWeek == null ? 'phone stats off' : n(r.dialsWeek) + ' this week', 'b-blue')}
          ${bub('🗣 Talks 2m+', n(r.talksToday), r.talksWeek == null ? '' : n(r.talksWeek) + ' this week', 'b-teal')}
          ${bub('🎯 Pitches', n(r.pitchesToday), n(r.pitchesWeek) + ' this week', 'b-amber')}
          ${bub('✅ Signed', n(r.signedToday), n(r.signedWeek) + ' this week', 'b-green')}
          ${bub('✨ New leads', n(r.leadsToday), n(r.leadsWeek) + ' this week', 'b-violet')}
          ${bub('📈 Pitch rate', p(pitchRate), 'of this week’s new leads', 'b-amber')}
          ${bub('🔁 Callbacks', n(r.callbacksWeek), 'this week', 'b-teal')}
          ${bub('🗑 Junked', n(r.junkWeek), 'this week', 'b-red')}
          ${bub('⏳ Uncontacted', n(r.uncontacted30), 'last 30 days', 'b-grey')}
        </div></div>`; }).join('');
    const src = d.sources.filter(s => s.dim === dim).slice(0, 12);
    const bar = (v, cls) => v == null ? '—' : `<span class="st-bar ${cls}"><i style="width:${Math.round(Math.max(0, Math.min(100, v)) * 0.6)}px"></i><b>${v}%</b></span>`;
    return `<div class="st-card">
      <div class="st-h"><h2>Team this week</h2><span class="st-sub">Since Monday ${esc(d.weekStart)} · <span data-st-ago>${ago()}</span></span><button class="btn" data-st-refresh>Refresh</button></div>
      <div class="st-tiles">${tiles.map(t => `<div class="st-tile"><span>${t[0]}</span><b>${t[1]}</b><small>${t[2]}</small></div>`).join('')}</div>
      ${top && top.signedWeek ? `<p class="st-callout">🏆 <b>${esc(top.rep)}</b> leads with ${top.signedWeek} sign-up${top.signedWeek > 1 ? 's' : ''} this week${topP && topP !== top && topP.pitchesWeek ? ` · most pitches: <b>${esc(topP.rep)}</b> (${topP.pitchesWeek})` : ''}.</p>` : ''}
      <div class="st-reps">${cards}</div>
    </div>
    <div class="st-card">
      <div class="st-h"><h2>Which leads perform best</h2><span class="st-sub">Leads from the last 30 days, where they are now</span>
        <span class="st-seg"><button class="${dim === 'campaign' ? 'on' : ''}" data-st-dim="campaign">Campaign</button><button class="${dim === 'adset' ? 'on' : ''}" data-st-dim="adset">Ad set</button><button class="${dim === 'ad' ? 'on' : ''}" data-st-dim="ad">Ad</button></span></div>
      <div class="st-scroll"><table class="st-table st-src${d.spendOn ? '' : ' st-nospend'}"><thead><tr><th>${dim === 'ad' ? 'Ad' : dim === 'adset' ? 'Ad set' : 'Campaign'}</th><th>Leads</th><th>Cost / lead</th><th>Junk rate</th><th>Pitch rate</th><th>Sign-up rate</th><th>Signed</th></tr></thead>
      <tbody>${src.map((s, k) => `<tr><td class="st-name">${k === 0 && s.signRate && s.name !== '(no ad info)' ? '⭐ ' : ''}${esc(s.name)}<small>${esc(s.reps.join(', '))}</small></td><td>${n(s.leads)}</td><td>${s.cpl == null ? '<span class="st-muted">—</span>' : '$' + s.cpl}</td><td>${bar(s.junkRate, 'bad')}</td><td>${bar(s.pitchRate, 'mid')}</td><td>${bar(s.signRate, 'good')}</td><td>${n(s.signed)}</td></tr>`).join('') || '<tr><td colspan="7" class="st-muted">Not enough leads yet.</td></tr>'}</tbody></table></div>
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
  setInterval(() => { check(); const a = data && document.querySelector('#admin-stats [data-st-ago]'); if (a && a.textContent !== ago()) a.textContent = ago(); }, 30000);
})();
