// Admin home stats (DebtSolvers): per rep — new leads, dials, 2-min+ talks, pitches, sign-ups, junk, callbacks
// (today and this week) — plus which ad / campaign brings the best leads (junk, pitch and sign-up rates, and cost per
// lead once ad spend is known). Read-only.
//   Pitches / sign-ups / junk = leads MOVED into those groups (Monday's activity log, so it's exact per day).
//   Dials = each rep's RingCentral outbound calls, through a read-only n8n webhook (STATS_CALLS_HOOK_URL).
//   Cached 10 minutes; ?fresh=1 rebuilds.
'use strict';

module.exports = function stats({ db, q, now, HttpError, send }) {
  const env = k => String(process.env[k] || '').trim();
  const TZ = (() => { const z = env('KS_TIMEZONE') || 'America/Toronto'; try { new Intl.DateTimeFormat('en-CA', { timeZone: z }); return z; } catch (e) { return 'America/Toronto'; } })(); // the workspace zone, same as server.js TIME_ZONE
  const midnightUtc = day => { // 00:00 of that day in TZ, as a UTC ISO instant (Toronto Monday → …T05:00:00Z, Alberta → …T07:00:00Z)
    const noon = Date.parse(day + 'T12:00:00Z'), local = Date.parse(new Date(noon).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T') + 'Z');
    return new Date(Date.parse(day + 'T00:00:00Z') - (local - noon)).toISOString().replace('.000Z', 'Z');
  };
  const ymd = t => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const weekStart = () => { // Monday of this week, Toronto
    const today = ymd(Date.now()); const d = new Date(today + 'T12:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10);
  };
  const isDS = b => { const w = b.workspace || {}; return !!w.id && w.id !== 'main' && !/mortgage\s*solver/i.test(w.name || ''); };
  const colBy = (b, re, type) => (b.columns || []).find(c => re.test(c.title || '') && (!type || c.type === type));
  const kind = name => /junk|unqualif/i.test(name) ? 'junk' : /signed/i.test(name) ? 'signed' : /pitch/i.test(name) ? 'pitched' : /call\s*back/i.test(name) ? 'callback' : /flop/i.test(name) ? 'flopped' : /uncontact|new/i.test(name) ? 'new' : 'other';

  function leadBoards() {
    const out = [];
    for (const r of q.docsInCol.all('boards')) {
      const b = JSON.parse(r.data); if (!isDS(b)) continue;
      const groups = (b.groups || []).map(g => kind(g.name));
      if (!groups.includes('signed') || !groups.includes('pitched')) continue; // a lead board
      if (/limitless/i.test(b.name)) continue; // the 2024 import board
      out.push({ id: r.id, b, rep: String(b.name).replace(/\s*(Leads|CRM)\s*$/i, '').trim(), mondayId: b.mondayId || (String(r.id).startsWith('m') ? String(r.id).slice(1) : '') });
    }
    return out;
  }

  // ---------- Monday activity log: moves into groups ----------
  async function mondayMoves(boards, since) {
    const token = env('MONDAY_API_TOKEN'); if (!token) return { moves: [], note: 'No Monday key on the server.' };
    const ids = boards.map(x => x.mondayId).filter(Boolean); const moves = [];
    for (const id of ids) {
      for (let page = 1; page <= 15; page++) {
        const qy = `query { boards(ids:[${id}]) { activity_logs(from: "${midnightUtc(since)}", limit: 1000, page: ${page}) { event created_at data } } }`;
        let d; try { const r = await fetch('https://api.monday.com/v2', { method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2024-10' }, body: JSON.stringify({ query: qy }), signal: AbortSignal.timeout(30000) }); d = await r.json(); } catch (e) { break; }
        const logs = (((d.data || {}).boards || [])[0] || {}).activity_logs || []; if (!logs.length) break;
        for (const l of logs) {
          if (l.event !== 'move_pulse_from_group') continue;
          let x; try { x = JSON.parse(l.data); } catch (e) { continue; }
          const t = Math.round(Number(l.created_at) / 1e4); // monday: 1e-7 s
          moves.push({ board: 'm' + id, item: String((x.pulse || {}).id || ''), to: kind(((x.dest_group || {}).title) || ''), from: kind(((x.source_group || {}).title) || ''), day: ymd(t) });
        }
        if (logs.length < 1000) break;
      }
    }
    return { moves };
  }
  function solverMoves(boards, since) {
    const out = []; const un = v => { try { const x = JSON.parse(v); return typeof x === 'string' ? x : v; } catch (e) { return v; } };
    for (const lb of boards) {
      const gn = new Map((lb.b.groups || []).map(g => [g.id, kind(g.name)]));
      let rows = []; try { rows = db.prepare("SELECT at, item, before, after FROM item_history WHERE board = ? AND col = '__group' AND undone = 0 AND at >= ?").all(lb.id, since); } catch (e) { continue; }
      // key by the Monday id when the item has one, so a move also in Monday's log counts once
      const mid = new Map(); if (rows.length) for (const d of q.docsInCol.all(`boards/${lb.id}/items`)) { try { const x = JSON.parse(d.data); if (x.mondayId) mid.set(String(d.id), String(x.mondayId)); } catch (e) {} }
      for (const r of rows) out.push({ board: lb.id, item: mid.get(String(r.item)) || String(r.item), to: gn.get(un(r.after)) || 'other', from: gn.get(un(r.before)) || 'other', day: ymd(Date.parse(r.at)) });
    }
    return out;
  }
  async function dials(since) {
    const url = env('STATS_CALLS_HOOK_URL'); if (!url) return null;
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: midnightUtc(since) }), signal: AbortSignal.timeout(90000) }); return (await r.json()).reps || null; } catch (e) { console.error('stats dials:', e.message); return null; }
  }

  let cache = null, building = null;
  async function build() {
    const ws = weekStart(), today = ymd(Date.now()), month = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const boards = leadBoards();
    // boards copied from Monday (or written back to it) also count moves made in Monday, from Monday's log
    const wb = new Set(env('MONDAY_WRITEBACK_BOARDS').split(/[\s,]+/).filter(Boolean)), inMonday = lb => lb.mondayId && (lb.b.source === 'monday' || wb.has(lb.id));
    const [mv, dl] = await Promise.all([mondayMoves(boards.filter(inMonday), ws), dials(ws)]);
    // Solver.ca's own moves count on every board: Monday-copied boards without write-back never send them to Monday,
    // and on write-back boards the same move in Monday's log is the same item, which cnt() counts once
    mv.moves.push(...solverMoves(boards, ws));
    const reps = [], src = new Map();
    for (const lb of boards) {
      const b = lb.b, dcol = colBy(b, /date entered/i), adc = colBy(b, /^ad( name)?$/i), cpc = colBy(b, /^campaign( name)?$/i) || colBy(b, /campaign name/i), asc = colBy(b, /^ad\s*set( name)?$/i) || colBy(b, /ad\s*set name/i);
      const gk = new Map((b.groups || []).map(g => [g.id, kind(g.name)]));
      let leadsToday = 0, leadsWeek = 0, uncontacted = 0, reachedWeek = 0;
      for (const r of q.docsInCol.all(`boards/${lb.id}/items`)) {
        const it = JSON.parse(r.data), v = it.values || {}; const raw = String((dcol && v[dcol.id]) || it.createdAt || '');
        const ent = /T\d\d:\d\d/.test(raw) && !isNaN(Date.parse(raw)) ? ymd(Date.parse(raw)) : raw.slice(0, 10); // a timestamp → its Toronto day, not the UTC one
        const k = gk.get(it.group) || 'other';
        if (ent === today) leadsToday++; if (ent >= ws) { leadsWeek++; if (['pitched', 'signed', 'flopped', 'callback'].includes(k)) reachedWeek++; }
        if (k === 'new' && ent >= month) uncontacted++;
        if (ent >= month && /@|\d/.test(JSON.stringify(v))) {
          for (const [dim, col] of [['ad', adc], ['adset', asc], ['campaign', cpc]]) {
            const name = String((col && v[col.id]) || '').trim() || '(no ad info)'; const key = dim + '|' + name;
            const s = src.get(key) || { dim, name, leads: 0, junk: 0, pitched: 0, signed: 0, reps: new Set() };
            s.leads++; if (k === 'junk') s.junk++; if (['pitched', 'signed', 'flopped', 'callback'].includes(k)) s.pitched++; if (k === 'signed') s.signed++; s.reps.add(lb.rep); src.set(key, s);
          }
        }
      }
      const mine = mv.moves.filter(m => m.board === lb.id);
      // a pitch = a lead moved into Pitched from New/Uncontacted (moving between Callbacks and Pitched isn't a new pitch)
      const cnt = (to, fromDay) => new Set(mine.filter(m => m.to === to && m.day >= fromDay && (to !== 'pitched' || m.from === 'new' || m.from === 'other')).map(m => m.item)).size;
      const dr = dl && Object.entries(dl).find(([n]) => lb.rep.toLowerCase().startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(lb.rep.toLowerCase().split(' ')[0]));
      const days = dr ? dr[1].byDay || {} : null, sumD = (k, from) => days ? Object.entries(days).filter(([d]) => d >= from).reduce((a, [, o]) => a + (o[k] || 0), 0) : null;
      const pitchRateWeek = leadsWeek ? Math.round(100 * reachedWeek / leadsWeek) : null;
      reps.push({ board: lb.id, rep: lb.rep, leadsToday, leadsWeek, uncontacted30: uncontacted, pitchRateWeek,
        dialsToday: sumD('dials', today), dialsWeek: sumD('dials', ws), talksToday: sumD('talks', today), talksWeek: sumD('talks', ws),
        pitchesToday: cnt('pitched', today), pitchesWeek: cnt('pitched', ws), signedToday: cnt('signed', today), signedWeek: cnt('signed', ws),
        junkWeek: cnt('junk', ws), callbacksWeek: cnt('callback', ws) });
    }
    const pct = (a, b) => b ? Math.round(1000 * a / b) / 10 : null;
    const sources = [...src.values()].filter(s => s.leads >= 3).map(s => ({ dim: s.dim, name: s.name, leads: s.leads, junkRate: pct(s.junk, s.leads), pitchRate: pct(s.pitched, s.leads), signRate: pct(s.signed, s.leads), signed: s.signed, reps: [...s.reps].sort(), cpl: null }))
      .sort((a, b) => ((a.name === '(no ad info)') - (b.name === '(no ad info)')) || (b.signRate - a.signRate) || (b.leads - a.leads));
    const active = reps.filter(r => r.leadsWeek || r.dialsWeek || r.pitchesWeek || r.signedWeek || r.uncontacted30);
    return { at: now(), weekStart: ws, today, reps: active.sort((a, b) => (b.signedWeek - a.signedWeek) || (b.pitchesWeek - a.pitchesWeek)), sources, dialsOn: !!dl, movesNote: mv.note || null, spendOn: false };
  }

  async function handle(req, res, url, user) {
    if (url.pathname !== '/api/stats/admin' || req.method !== 'GET') return false;
    if (!user || user.role !== 'admin') throw new HttpError(403, 'Only admins see team stats.');
    const fresh = url.searchParams.get('fresh') === '1';
    if (!fresh && cache && Date.now() - cache.t < 10 * 60e3) return send(res, 200, cache.v), true;
    if (!building) building = build().then(v => { cache = { t: Date.now(), v }; return v; }).finally(() => { building = null; });
    try { return send(res, 200, await building), true; } catch (e) { if (cache) return send(res, 200, cache.v), true; throw e; }
  }
  return { handle, _build: build };
};
