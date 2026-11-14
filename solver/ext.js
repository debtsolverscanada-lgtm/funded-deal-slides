// Wires the add-on server modules into server.js with a few small hooks:
//   automation.js (rule checks, run log, "Send to a connected tool"), ai.js (AI columns), docs.js (rich-text docs),
//   push.js (phone/desktop alerts), alerts.js (staff email alerts, off until set up), comms.js (calls & texts panel).
'use strict';

module.exports = function ext(ctx) {
  const { integHooks } = ctx;
  const automation = require('./automation.js')(ctx);
  const ai = require('./ai.js')(ctx);
  const docs = require('./docs.js')(ctx);
  const push = require('./push.js')({ ...ctx, safeUrl: ctx.integ.safeUrl });
  const alerts = require('./alerts.js')(ctx);
  const comms = require('./comms.js')(ctx);
  const email = require('./email.js')(ctx);
  const blast = require('./blast.js')(ctx, email);
  const apps = require('./apps.js')(ctx, email);
  const newleads = require('./newleads.js')(ctx);
  const sequences = require('./sequences.js')(ctx, email);
  const crossboard = require('./crossboard.js')(ctx, integHooks);
  const stats = require('./stats.js')(ctx);
  const mondaywrite = require('./mondaywrite.js')(ctx);
  integHooks.updateAdded = (bid, iid, upd) => mondaywrite.onNote(bid, iid, upd); // notes the server posts (emails, texts, replies)

  // integrations.js calls these for rules run through the API, date reminders and /api/v1/events
  integHooks.ruleRan = (bid, rid, iid, itemName, result, via) => automation.logRun(bid, rid, iid, itemName, result, true, via);
  integHooks.sendWebhook = (bid, iid, rule, item, via) => automation.sendWebhook(bid, iid, rule, item, via);
  integHooks.webhookThrottled = (bid, iid, rule) => automation.throttled(bid, iid, rule);
  integHooks.onEvent = (body, hits, actor) => comms.onEvent(body, hits, actor);
  integHooks.newItem = (bid, iid, doc) => newleads.noteItem(bid, iid, doc); // NEW LEAD banners
  integHooks.itemSaved = (bid, iid, before, after) => sequences.onItem(bid, iid, before, after); // email sequences
  // "When the lead replies" rules (Monday's "When a new email arrives → notify"): run on the server as the reply is logged.
  // REPLY_AUTOMATIONS=off stops them (the reply is still logged on the lead).
  integHooks.leadReplied = (bid, iid, kind) => {
    if (String(process.env.REPLY_AUTOMATIONS || '').trim().toLowerCase() === 'off') return;
    const br = ctx.q.doc.get('boards/' + bid), ir = ctx.q.doc.get(`boards/${bid}/items/${iid}`); if (!br || !ir) return;
    const b = { id: bid, ...JSON.parse(br.data) };
    if (!(b.automations || []).some(r => r.on !== false && (r.trigger === 'replied' || (r.trigger === 'monday_only' && r.note === 'email_received')))) return;
    const before = JSON.parse(ir.data), item = JSON.parse(ir.data), notes = [];
    ctx.integ.runRules(b, item, { type: 'replied', value: kind }, { role: 'admin', name: kind === 'text' ? 'a text reply' : 'an email reply', via: 'reply', noteKind: 'automation' }, notes, iid);
    if (JSON.stringify(before) !== JSON.stringify(item)) {
      const path = `boards/${bid}/items/${iid}`;
      ctx.q.upsertDoc.run(path, `boards/${bid}/items`, iid, JSON.stringify(item), ctx.now(), 'automation');
      ctx.broadcast({ op: 'set', col: `boards/${bid}/items`, id: iid, data: item });
      ctx.integ.itemChanged(path, before, item, 'automation');
      sequences.onItem(bid, iid, before, item); mondaywrite.onSaved(bid, iid, before, item, { name: 'Automation' });
    }
    ctx.integ.sendNotes(b, iid, item, notes);
  };

  const modules = [automation, ai, docs, push, alerts, comms, email, blast, apps, newleads, sequences, crossboard, stats, mondaywrite];
  return {
    // signed-in API routes; returns false when none of them matched
    async handle(req, res, url, user) {
      for (const m of modules) { const r = await m.handle(req, res, url, user); if (r !== false) return true; }
      return false;
    },
    // a board is about to be saved through /api/doc: check its automations
    checkBoard: (data, before) => automation.checkBoard(data, before),
    // an item was saved by a person through /api/doc
    itemSaved(dp, before, after, user) { try { ai.itemSaved(dp, before, after, user); } catch (e) { console.error('ai autorun:', e.message); }
      const m = /^boards\/([^/]+)\/items\/([^/]+)$/.exec(String(dp || '')); if (m) { sequences.onItem(m[1], m[2], before, after); mondaywrite.onSaved(m[1], m[2], before, after, user); } },
    // an in-app notification was made for this person
    onNotify(user, n) {
      try { push.onNotify(user, n); } catch (e) { console.error('push:', e.message); }
      try { alerts.onNotify(user, n); } catch (e) { console.error('alerts:', e.message); }
    },
    automation, ai, docs, push, alerts, comms, email, blast, apps, newleads, sequences,
  };
};
