// Solver.ca automations: the rule schema (shared by the editor and the engines), server-side validation on save,
// a run log per rule (last 50 runs), and the opt-in "Send to a connected tool" action, which sends a signed
// automation.webhook event through the outgoing webhooks in integrations.js.
// Solver.ca still never texts or emails anyone: Monday's email/SMS actions stay logged only ("external").
'use strict';

const TRIGGERS = ['status', 'column', 'created', 'moved_group', 'button', 'date_arrives', 'sub_status', 'moved_board', 'monday_only'];
const ACTIONS = ['move_group', 'set_status', 'set_value', 'set_date', 'clear', 'assign', 'create_update', 'move_board', 'copy_to_board', 'duplicate', 'notify', 'webhook', 'external'];
const COND_OPS = ['is', 'is_not', 'empty', 'not_empty', 'contains', 'has_person', 'is_not_any'];
// Only rules copied from Monday may keep Monday-only parts (they are shown and logged, never run).
const MONDAY_ONLY_TRIGGERS = new Set(['monday_only']);
const MONDAY_ONLY_ACTIONS = new Set(['external']);
const SUB_ACTIONS = new Set(['set_status', 'set_value', 'set_date', 'clear']);
const MAX_RULES = 400, KEEP_RUNS = 50;

const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const str = (v, n) => String(v ?? '').slice(0, n);

// Returns a cleaned copy of one rule or throws a message. strict: also check that columns, groups and boards exist.
function cleanRule(r, b, { strict, boardExists }) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw 'An automation must be an object.';
  const fromMonday = r.source === 'monday';
  const out = { ...r };
  if (!ID.test(String(r.id || ''))) throw 'Each automation needs an id.';
  out.id = String(r.id);
  if (r.title != null) out.title = str(r.title, 300);
  if (r.on != null) out.on = r.on !== false;
  // Rules made before the editor existed: { col, label, action: 'move'|'set', target / targetCol, targetLabel }
  if (!r.trigger) {
    if (!['move', 'set'].includes(r.action)) throw `“${out.title || out.id}” has no trigger.`;
    return out;
  }
  const name = `“${out.title || 'Automation'}”`;
  if (!TRIGGERS.includes(r.trigger)) throw `${name} has an unknown trigger (${str(r.trigger, 40)}).`;
  if (MONDAY_ONLY_TRIGGERS.has(r.trigger) && !fromMonday) throw `${name}: that trigger only exists in Monday.`;
  const cols = (b.columns || []), subCols = (b.subColumns || []), groups = (b.groups || []);
  const col = id => cols.find(c => c.id === id), subCol = id => subCols.find(c => c.id === id);
  const groupOk = g => g === '__top__' || groups.some(x => x.id === g);
  const need = (ok, msg) => { if (strict && !ok) throw `${name}: ${msg}`; };
  switch (r.trigger) {
    case 'status': need(col(r.col) && col(r.col).type === 'status', 'pick a status column.'); if (strict && r.value != null && r.value !== '') need((col(r.col).labels || []).some(l => l.id === String(r.value)), 'pick a label from that column.'); break;
    case 'column': need(!!col(r.col), 'pick a column.'); break;
    case 'created': if (r.group) need(groupOk(r.group), 'that group no longer exists.'); break;
    case 'moved_group': need(!r.group || groupOk(r.group), 'that group no longer exists.'); break;
    case 'button': need(col(r.col) && col(r.col).type === 'button', 'pick a button column.'); break;
    case 'date_arrives': need(col(r.col) && col(r.col).type === 'date', 'pick a date column.'); out.when = str(r.when, 120); if (strict) need(/^(on the date|\d{1,3} day\(s\) (before|after) the date)(, at \d{1,2}:\d{2}.*)?$/.test(out.when) || !out.when, 'say when (on the date, or N days before/after, at a time).'); break;
    case 'sub_status': need(subCol(r.col) && subCol(r.col).type === 'status', 'pick a subitem status column.'); break;
  }
  if (r.value != null) out.value = typeof r.value === 'boolean' ? r.value : str(r.value, 500);
  // conditions: status is / column empty / person is / group is (and a few more)
  if (r.conditions != null && !Array.isArray(r.conditions)) throw `${name}: conditions must be a list.`;
  out.conditions = (r.conditions || []).slice(0, 20).map(c => {
    if (!c || typeof c !== 'object') throw `${name}: a condition is broken.`;
    const op = c.op || 'is';
    if (!COND_OPS.includes(op)) throw `${name}: unknown condition (${str(op, 30)}).`;
    const cc = { col: str(c.col, 200), op };
    if (cc.col === '__group') { need(groupOk(c.value), 'the group in a condition no longer exists.'); cc.value = str(c.value, 200); return cc; }
    need(!!col(cc.col), 'a condition uses a column that no longer exists.');
    if (op === 'has_person') need(col(cc.col) && col(cc.col).type === 'person', '“person is” needs a person column.');
    if (!['empty', 'not_empty'].includes(op)) { if (Array.isArray(c.value)) cc.value = c.value.slice(0, 50).map(v => str(v, 200)); else cc.value = str(c.value, 500); if (strict) need(cc.value !== '' && !(Array.isArray(cc.value) && !cc.value.length), 'a condition needs a value.'); }
    return cc;
  });
  if (!Array.isArray(r.actions)) throw `${name} needs at least one action.`;
  if (strict && !r.actions.length) throw `${name} needs at least one action.`;
  out.actions = r.actions.slice(0, 20).map(a => {
    if (!a || typeof a !== 'object' || !ACTIONS.includes(a.type)) throw `${name} has an unknown action (${str(a && a.type, 40)}).`;
    if (MONDAY_ONLY_ACTIONS.has(a.type) && !fromMonday) throw `${name}: emails, texts and Monday integrations aren’t run by Solver.ca. Use “Send to a connected tool” instead.`;
    const x = { ...a };
    const c = r.trigger === 'sub_status' ? subCol(a.col) : col(a.col);
    if (r.trigger === 'sub_status' && strict && !SUB_ACTIONS.has(a.type)) throw `${name}: subitem automations can set, date or clear subitem columns only.`;
    switch (a.type) {
      case 'move_group': need(groupOk(a.group), 'pick a group to move to.'); break;
      case 'set_status': need(c && c.type === 'status', 'pick a status column to set.'); if (c && strict) need((c.labels || []).some(l => l.id === String(a.value)), 'pick the label to set.'); x.value = str(a.value, 200); break;
      case 'set_value': need(!!c && !['formula', 'button', 'item_id', 'created', 'ai'].includes(c.type), 'pick a column to set.'); x.value = typeof a.value === 'boolean' ? a.value : str(a.value, 2000); break;
      case 'set_date': need(c && c.type === 'date', 'pick a date column.'); x.offset = Math.max(-3650, Math.min(3650, Math.round(Number(a.offset) || 0))); break;
      case 'clear': need(!!c, 'pick a column to clear.'); break;
      case 'assign': need(c && c.type === 'person', 'pick a person column.'); x.value = str(a.value, 200).trim(); need(!!x.value, 'say who to assign.'); break;
      case 'create_update': x.value = str(a.value ?? a.message, 4000); need(!!x.value.trim(), 'write the update to post.'); break;
      case 'move_board': case 'copy_to_board': need(!!a.board && boardExists(String(a.board)), 'pick a board.'); if (a.map != null && (typeof a.map !== 'object' || Array.isArray(a.map))) throw `${name}: the column mapping is broken.`; break;
      case 'duplicate': x.withUpdates = !!a.withUpdates; break;
      case 'notify': x.to = str(a.to, 500); x.message = str(a.message, 2000); need(!!x.to.trim(), 'say who to notify.'); break;
      case 'webhook': x.hook = a.hook ? str(a.hook, 60) : ''; x.note = str(a.note, 300); break;
      case 'external': x.label = str(a.label, 200); break;
    }
    return x;
  });
  if (r.trigger === 'date_arrives') out.mondayActive = r.mondayActive;
  return out;
}

// The groups and columns a rule points at that aren't on the board (copied rules often keep the old board's ids).
function missingRefs(r, b) {
  const cols = new Set((b.columns || []).map(c => c.id)), subCols = new Set((b.subColumns || []).map(c => c.id)), groups = new Set((b.groups || []).map(g => g.id));
  const out = [], colOk = id => !id || (r.trigger === 'sub_status' ? subCols.has(id) : cols.has(id)), grpOk = g => !g || g === '__top__' || groups.has(g);
  if (['status', 'column', 'button', 'date_arrives', 'sub_status'].includes(r.trigger) && !colOk(r.col)) out.push('a column');
  if (['created', 'moved_group'].includes(r.trigger) && !grpOk(r.group)) out.push('a group');
  for (const c of Array.isArray(r.conditions) ? r.conditions : []) { if (c && c.col === '__group') { if (!grpOk(c.value)) out.push('a group (in a condition)'); } else if (c && !cols.has(c.col)) out.push('a column (in a condition)'); }
  for (const a of Array.isArray(r.actions) ? r.actions : []) {
    if (!a) continue;
    if (a.type === 'move_group' && !grpOk(a.group)) out.push('a group (in “move to group”)');
    if (['set_status', 'set_value', 'set_date', 'clear', 'assign'].includes(a.type) && !colOk(a.col)) out.push('a column (in an action)');
  }
  return [...new Set(out)];
}
// Checks a board's automations when they are saved. Only rules that are new or changed are held to the strict
// checks, so an old Monday copy that points at a column someone deleted can still be switched on or off.
function validateAutomations(list, board, before, boardExists) {
  if (!Array.isArray(list)) throw new Error('Automations must be a list.');
  if (list.length > MAX_RULES) throw new Error(`A board can have up to ${MAX_RULES} automations.`);
  const old = new Map(((before && before.automations) || []).map(r => [r && r.id, JSON.stringify(r)]));
  const seen = new Set();
  return list.map(r => {
    const id = r && String(r.id);
    if (seen.has(id)) throw new Error('Two automations share an id.');
    seen.add(id);
    const unchanged = old.get(id) === JSON.stringify(r);
    // toggling On/Off alone is not an edit
    const sameButSwitch = old.has(id) && (() => { try { const a = JSON.parse(old.get(id)); delete a.on; const c = { ...r }; delete c.on; return JSON.stringify(a) === JSON.stringify(c); } catch (e) { return false; } })();
    try { return cleanRule(r, board, { strict: !unchanged && !sameButSwitch, boardExists }); }
    catch (e) {
      const msg = typeof e === 'string' ? e : e.message;
      // a copied rule (from Monday or another board) that still points at what isn't here: say so plainly
      const gone = r && typeof r === 'object' ? missingRefs(r, board) : [];
      if (gone.length) throw new Error(`“${str((r && r.title) || 'This automation', 120)}” points at ${gone.join(' and ')} that isn’t on this board any more (it was probably copied from Monday or another board). In the editor, pick a group and columns that exist on this board, then save. Switching it on or off still works without that. (${msg})`);
      throw new Error(msg);
    }
  });
}

module.exports = function automation({ db, q, now, HttpError, readBody, send, boardInfo, mustSee, itemVisible, canWrite, integ }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, rule TEXT NOT NULL, item TEXT, item_name TEXT,
      at TEXT NOT NULL, result TEXT, ok INTEGER NOT NULL DEFAULT 1, via TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_runs_rule ON automation_runs(board, rule, id);
  `);
  const ins = db.prepare('INSERT INTO automation_runs (board, rule, item, item_name, at, result, ok, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const trim = db.prepare('DELETE FROM automation_runs WHERE board = ? AND rule = ? AND id NOT IN (SELECT id FROM automation_runs WHERE board = ? AND rule = ? ORDER BY id DESC LIMIT ?)');
  function logRun(board, rule, item, itemName, result, ok = true, via = 'app') {
    try {
      ins.run(String(board), String(rule), item ? String(item) : null, str(itemName, 200), now(), str(result, 600), ok ? 1 : 0, str(via, 40));
      trim.run(String(board), String(rule), String(board), String(rule), KEEP_RUNS);
    } catch (e) { console.error('automation log:', e.message); }
  }
  const boardDoc = id => { const r = q.doc.get('boards/' + id); return r ? JSON.parse(r.data) : null; };
  const itemDoc = (bid, iid) => { const r = ID.test(String(iid)) && q.doc.get(`boards/${bid}/items/${iid}`); return r ? JSON.parse(r.data) : null; };
  const boardExists = id => ID.test(id) && !!q.doc.get('boards/' + id);
  const lastSent = new Map(); // board|item|rule -> time, so a rule can't flood a connected tool

  // Called from /api/doc before a board is saved. Returns the cleaned list, or throws a 400.
  function checkBoard(data, before) {
    if (!data || !Array.isArray(data.automations)) return;
    try { data.automations = validateAutomations(data.automations, data, before, boardExists); }
    catch (e) { const err = new HttpError(400, e.message); err.code = 'invalid_rule'; throw err; }
  }

  // Sends the signed automation.webhook event for one rule run (from the app, the API or a date reminder).
  function sendWebhook(bid, iid, rule, item, via) {
    const b = boardDoc(bid); if (!b) return 0;
    const key = `${bid}|${iid}|${rule.id}`, t = Date.now();
    if (t - (lastSent.get(key) || 0) < 3000) return 0;
    const acts = (rule.actions || []).filter(a => a.type === 'webhook');
    let n = 0;
    for (const a of acts) n += integ.emit('automation.webhook', bid, iid, b, item, { automation: { id: rule.id, title: rule.title || null, note: a.note || null, via } }, a.hook ? { hook: a.hook } : {});
    if (n) { lastSent.set(key, t); if (lastSent.size > 5000) lastSent.clear(); }
    return n;
  }

  async function handle(req, res, url, user) {
    const p = url.pathname, method = req.method;
    if (!p.startsWith('/api/automations/')) return false;
    // ---- the run log for one rule ----
    if (p === '/api/automations/runs' && method === 'GET') {
      const bid = url.searchParams.get('board') || '', rule = url.searchParams.get('rule') || '';
      if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
      const info = mustSee(user, bid);
      const rows = rule ? db.prepare('SELECT * FROM automation_runs WHERE board = ? AND rule = ? ORDER BY id DESC LIMIT 50').all(bid, rule)
        : db.prepare('SELECT * FROM automation_runs WHERE board = ? ORDER BY id DESC LIMIT 200').all(bid);
      // people who only see their own items don't see runs for items that are gone (their names could be anyone's)
      const limitedView = user.role !== 'admin' && (((info.perms || {}).assignedOnly) || []).length > 0;
      const out = rows.filter(r => { if (!r.item) return true; const it = itemDoc(bid, r.item); return it ? itemVisible(user, info, it) : !limitedView; })
        .map(r => ({ id: r.id, rule: r.rule, item: r.item, itemName: r.item_name, at: r.at, result: r.result, ok: !!r.ok, via: r.via }));
      return send(res, 200, out);
    }
    // ---- the page ran rules: write them to the log ----
    if (p === '/api/automations/runs' && method === 'POST') {
      if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
      const body = await readBody(req); const bid = String(body.board || '');
      if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
      const info = mustSee(user, bid), b = boardDoc(bid), ids = new Set((b.automations || []).map(r => r.id));
      let n = 0;
      for (const r of (Array.isArray(body.runs) ? body.runs : []).slice(0, 50)) {
        if (!r || !ids.has(String(r.rule))) continue;
        const it = r.item ? itemDoc(bid, r.item) : null; if (it && !itemVisible(user, info, it)) continue;
        logRun(bid, r.rule, r.item ? String(r.item) : null, (it && it.name) || r.itemName || '', r.result || 'Ran', r.ok !== false, 'app · ' + (user.name || 'someone'));
        n++;
      }
      return send(res, 200, { ok: true, logged: n });
    }
    // ---- "Send to a connected tool": the page asks the server to send the signed webhook for a rule it ran ----
    if (p === '/api/automations/webhook' && method === 'POST') {
      if (!canWrite(user)) throw new HttpError(403, 'Your account can view boards but not change them.');
      const body = await readBody(req); const bid = String(body.board || ''), iid = String(body.item || ''), rid = String(body.rule || '');
      if (!ID.test(bid) || !boardInfo(bid)) throw new HttpError(404, 'No such board.');
      const info = mustSee(user, bid), b = boardDoc(bid);
      const it = itemDoc(bid, iid); if (!it || !itemVisible(user, info, it)) throw new HttpError(404, 'No such item.');
      const rule = (b.automations || []).find(r => r.id === rid);
      if (!rule || rule.on === false || !(rule.actions || []).some(a => a.type === 'webhook')) throw new HttpError(400, 'That automation doesn’t send to a connected tool.');
      const sent = sendWebhook(bid, iid, rule, it, 'app');
      logRun(bid, rid, iid, it.name, sent ? `Sent to ${sent === 1 ? 'a connected tool' : sent + ' connected tools'}` : 'No connected tool is listening (add an outgoing webhook for “Automation sent to a tool”)', !!sent, 'webhook');
      return send(res, 200, { ok: true, sent });
    }
    // ---- what the editor needs: connected tools to pick from (names only) ----
    if (p === '/api/automations/meta' && method === 'GET') {
      if (user.role === 'guest') throw new HttpError(403, 'Guests can’t see the workspace’s connected tools.');
      const hooks = db.prepare("SELECT id, name, events, board, active FROM hooks WHERE kind = 'out'").all()
        .map(h => ({ id: h.id, name: h.name, active: !!h.active, listens: (() => { const ev = JSON.parse(h.events || '[]'); return !ev.length || ev.includes('automation.webhook'); })(), board: h.board || null }));
      return send(res, 200, { triggers: TRIGGERS, actions: ACTIONS, ops: COND_OPS, hooks });
    }
    return false;
  }

  return { handle, checkBoard, logRun, sendWebhook };
};
module.exports.validateAutomations = validateAutomations;
module.exports.missingRefs = missingRefs;
module.exports.TRIGGERS = TRIGGERS;
module.exports.ACTIONS = ACTIONS;
module.exports.COND_OPS = COND_OPS;
