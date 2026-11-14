// Solver.ca page add-ons: a small registry the main page calls at a few points (modals, clicks, cells, the item
// drawer, Profile). The add-ons (automations.js, editor.js, extras.js) register here; the page's internals they
// need are on window.SolverApp, which the page sets up as it starts.
(() => {
  'use strict';
  const parts = [];
  const first = (fn, ...a) => { for (const p of parts) if (typeof p[fn] === 'function') { try { const r = p[fn](...a); if (r != null && r !== false) return r; } catch (e) { console.error(e); } } return null; };
  const all = (fn, ...a) => { const out = []; for (const p of parts) if (typeof p[fn] === 'function') { try { const r = p[fn](...a); if (r != null) out.push(r); } catch (e) { console.error(e); } } return out; };
  window.SolverExt = {
    register: p => { parts.push(p); },
    renderModal: (m, b) => first('renderModal', m, b),
    onAct: (a, t, e, b) => !!first('onAct', a, t, e, b),
    onChange: e => !!first('onChange', e),
    onInput: e => !!first('onInput', e),
    cell: (col, item, inDrawer) => first('cell', col, item, inDrawer),
    drawerTabs: (b, i) => all('drawerTabs', b, i).flat(),
    drawerBody: (tab, b, i) => first('drawerBody', tab, b, i),
    afterLayer: () => { all('afterLayer'); },
    profile: () => all('profile').join(''),
    colSettings: (c, b) => all('colSettings', c, b).join(''),
    ruleRan: (b, item, rule, texts) => { all('ruleRan', b, item, rule, texts); },
    after: (x, b, item) => !!first('after', x, b, item),
    types: () => Object.assign({}, ...all('types')),
  };
})();
