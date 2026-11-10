// Solver.ca docs: a rich-text editor for Doc columns and the item drawer's Doc tab (headings, lists, bold/italic,
// links, checklists). Saves itself as you type, shows others' changes live, and keeps the last 20 versions.
// The server keeps only whitelisted HTML; pasted content is cleaned here as well.
(() => {
  'use strict';
  const A = () => window.SolverApp;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = iso => { try { return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
  const isDocCol = c => !!c && (c.type === 'doc' || c.source === 'doc' || c.source === 'direct_doc');
  const docsOf = b => [...(b.columns || []).filter(isDocCol).map(c => ({ id: c.id, title: c.title, legacy: c.type !== 'doc' })), { id: '_notes', title: 'Notes' }];

  // ---------- paste cleaning (same whitelist as the server) ----------
  const OK = { P: [], BR: [], H1: [], H2: [], H3: [], UL: ['data-checklist'], OL: [], LI: ['data-checked'], B: [], STRONG: [], I: [], EM: [], U: [], S: [], A: ['href'], BLOCKQUOTE: [], CODE: [], PRE: [], HR: [], DIV: [], SPAN: [] };
  function clean(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const walk = node => {
      for (const ch of [...node.childNodes]) {
        if (ch.nodeType === 3) continue;
        if (ch.nodeType !== 1) { ch.remove(); continue; }
        const tag = ch.tagName;
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'TITLE', 'META', 'LINK'].includes(tag)) { ch.remove(); continue; }
        walk(ch);
        if (!OK[tag]) { ch.replaceWith(...ch.childNodes); continue; }
        for (const at of [...ch.attributes]) {
          if (!OK[tag].includes(at.name)) { ch.removeAttribute(at.name); continue; }
          if (at.name === 'href' && !/^(https?:|mailto:|tel:|\/(?!\/)|#)/i.test(at.value.replace(/[\u0000- ]+/g, ''))) ch.removeAttribute('href');
        }
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  // ---------- one editor per doc, kept while the page is open so re-renders don't lose typing ----------
  const eds = new Map(); // "board|item|col" -> { el, rev, dirty, timer, saving, status, banner, legacy, key, board, item, col }
  const S = () => A().S;
  const sel = () => { const s = S(); return s.docSel && s.docSel.item === s.openItem ? s.docSel.col : null; };
  function current(b, i) { const list = docsOf(b), want = sel(); return list.find(d => d.id === want) || list[0]; }
  function makeEditor(key, bid, iid, col, editable) {
    const el = document.createElement('div');
    el.className = 'doc-ed'; el.contentEditable = editable ? 'true' : 'false'; el.spellcheck = true;
    el.setAttribute('role', 'textbox'); el.setAttribute('aria-multiline', 'true'); el.setAttribute('aria-label', 'Doc'); el.dataset.placeholder = editable ? 'Start writing. Use the buttons above for headings, lists and checklists.' : 'Nothing here yet.';
    const ed = { el, key, board: bid, item: iid, col, rev: 0, dirty: false, timer: null, status: 'Loading…', banner: null, loaded: false };
    el.addEventListener('input', () => { ed.dirty = true; ed.status = 'Editing…'; paintStatus(ed); clearTimeout(ed.timer); ed.timer = setTimeout(() => save(ed), 900); });
    el.addEventListener('blur', () => { if (ed.dirty) { clearTimeout(ed.timer); save(ed); } });
    el.addEventListener('paste', e => {
      const d = e.clipboardData; if (!d) return; e.preventDefault();
      const h = d.getData('text/html'); if (h) document.execCommand('insertHTML', false, clean(h));
      else document.execCommand('insertText', false, d.getData('text/plain'));
    });
    // dragging text or a web page selection in skips the paste event: clean it the same way
    el.addEventListener('drop', e => {
      const d = e.dataTransfer; if (!d) return; e.preventDefault();
      if (el.contentEditable !== 'true') return;
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); } else el.focus();
      const h = d.getData('text/html'), t = d.getData('text/plain');
      if (h) document.execCommand('insertHTML', false, clean(h)); else if (t) document.execCommand('insertText', false, t);
    });
    el.addEventListener('click', e => {
      const li = e.target.closest && e.target.closest('ul[data-checklist] > li'); if (!li || el.contentEditable !== 'true') return;
      const r = li.getBoundingClientRect(); if (e.clientX - r.left > 26) return; // the tick box sits left of the text
      li.dataset.checked = li.dataset.checked === 'true' ? 'false' : 'true'; ed.dirty = true; clearTimeout(ed.timer); ed.timer = setTimeout(() => save(ed), 300);
    });
    el.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmd(ed, 'link'); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); clearTimeout(ed.timer); save(ed); }
    });
    eds.set(key, ed);
    load(ed);
    return ed;
  }
  const q = ed => `board=${encodeURIComponent(ed.board)}&item=${encodeURIComponent(ed.item)}&col=${encodeURIComponent(ed.col)}`;
  function load(ed) {
    return KS.api('GET', '/api/itemdoc?' + q(ed)).then(r => {
      ed.rev = r.rev; ed.legacy = r.legacy; ed.loaded = true; ed.el.innerHTML = r.html || '';
      ed.status = r.updatedAt ? `Saved ${fmt(r.updatedAt)}${r.byName ? ' by ' + r.byName : ''}` : r.legacy ? 'Copied from Monday. Edit it here to make it a Solver.ca doc.' : 'Not saved yet';
      ed.dirty = false; ed.banner = null; paintStatus(ed);
    }).catch(e => { ed.status = e.message || 'Couldn’t open this doc.'; paintStatus(ed); });
  }
  function save(ed, opts = {}) {
    if (!ed.loaded || ed.el.contentEditable !== 'true') return;
    if (ed.saving) { ed.again = true; return; }
    ed.saving = true; ed.dirty = false; ed.status = 'Saving…'; paintStatus(ed);
    const html = ed.el.innerHTML;
    KS.api('PUT', '/api/itemdoc', { board: ed.board, item: ed.item, col: ed.col, html, rev: ed.rev, ...opts }).then(r => {
      ed.rev = r.rev; ed.legacy = false; ed.status = `Saved ${fmt(new Date().toISOString())}`; ed.banner = null;
    }).catch(e => {
      ed.dirty = true;
      if (/changed this doc/.test(e.message || '')) ed.banner = { text: e.message, conflict: true };
      else ed.status = e.message || 'Didn’t save. Retrying when you type again.';
    }).finally(() => { ed.saving = false; paintStatus(ed); if (ed.again) { ed.again = false; save(ed); } });
  }
  function paintStatus(ed) {
    const st = document.querySelector(`.doc-status[data-key="${CSS.escape(ed.key)}"]`); if (st) st.textContent = ed.status;
    const bn = document.querySelector(`.doc-banner[data-key="${CSS.escape(ed.key)}"]`);
    if (bn) { bn.hidden = !ed.banner; bn.innerHTML = ed.banner ? `<span>${esc(ed.banner.text)}</span><button class="btn" data-act="doc-load-theirs">Load their version</button>${ed.banner.conflict ? '<button class="btn" data-act="doc-keep-mine">Keep mine</button>' : ''}` : ''; }
  }
  function cmd(ed, c) {
    const el = ed.el; if (el.contentEditable !== 'true') return;
    el.focus();
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}
    switch (c) {
      case 'h1': case 'h2': case 'h3': case 'p': case 'blockquote': document.execCommand('formatBlock', false, c === 'p' ? 'P' : c.toUpperCase()); break;
      case 'bold': case 'italic': case 'underline': case 'strikeThrough': document.execCommand(c); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'check': {
        const inList = () => { const s = getSelection(); const n = s && s.anchorNode; const e = n && (n.nodeType === 1 ? n : n.parentElement); return e && e.closest && e.closest('ul'); };
        let ul = inList(); if (!ul) { document.execCommand('insertUnorderedList'); ul = inList(); }
        if (ul && el.contains(ul)) { if (ul.hasAttribute('data-checklist')) ul.removeAttribute('data-checklist'); else ul.setAttribute('data-checklist', '1'); }
        break;
      }
      case 'link': {
        const s = getSelection(); const txt = s ? String(s) : '';
        let url = prompt('Link address (https://…)', /^https?:\/\//.test(txt) ? txt : 'https://'); if (!url) return;
        url = url.trim(); if (!/^(https?:|mailto:|tel:)/i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
        if (s && s.isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url)}</a>`); else document.execCommand('createLink', false, url);
        break;
      }
      case 'unlink': document.execCommand('unlink'); break;
      case 'clear': document.execCommand('removeFormat'); break;
    }
    ed.dirty = true; clearTimeout(ed.timer); ed.timer = setTimeout(() => save(ed), 500);
  }
  // keep the text selection when a toolbar button is pressed
  document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('.doc-tb button')) e.preventDefault(); });

  // live: another person saved this doc
  function onDoc(ev) {
    const key = `${ev.col.split('/')[1]}|${ev.id}|${ev.docCol}`, ed = eds.get(key); if (!ed) return;
    if (ev.rev <= ed.rev) return;
    if (document.activeElement === ed.el || ed.dirty) { ed.banner = { text: `${ev.byName || 'Someone'} just changed this doc.`, html: ev.html, rev: ev.rev }; paintStatus(ed); return; }
    ed.el.innerHTML = ev.html; ed.rev = ev.rev; ed.status = `Updated ${fmt(ev.at)}${ev.byName ? ' by ' + ev.byName : ''}`; paintStatus(ed);
  }
  let hooked = false;
  function hook() { if (!hooked && window.KS) { hooked = true; KS.on('doc', onDoc); } }

  function toolbar(editable) {
    if (!editable) return '';
    const B = (c, label, title) => `<button type="button" data-act="doc-cmd" data-cmd="${c}" title="${esc(title)}" aria-label="${esc(title)}">${label}</button>`;
    return `<div class="doc-tb" role="toolbar" aria-label="Formatting">${B('h1', 'H1', 'Big heading')}${B('h2', 'H2', 'Heading')}${B('p', '¶', 'Normal text')}<span class="sep"></span>${B('bold', '<b>B</b>', 'Bold (Ctrl+B)')}${B('italic', '<i>I</i>', 'Italic (Ctrl+I)')}${B('underline', '<u>U</u>', 'Underline')}<span class="sep"></span>${B('ul', '•', 'Bulleted list')}${B('ol', '1.', 'Numbered list')}${B('check', '☑', 'Checklist')}${B('blockquote', '❝', 'Quote')}<span class="sep"></span>${B('link', '🔗', 'Link (Ctrl+K)')}${B('unlink', '⨯🔗', 'Remove link')}</div>`;
  }

  window.SolverExt.register({
    cell(col, item, inDrawer) {
      if (!isDocCol(col)) return null;
      const v = (item.values || {})[col.id]; const txt = Array.isArray(v) ? v.map(x => x && (x.name || x.url)).join(', ') : String(v ?? '');
      return `<button class="doc-cell" data-act="doc-open" data-item="${esc(item.id)}" data-col="${esc(col.id)}" title="${esc(txt || 'Open the doc')}"><span class="doc-ic">📄</span><span class="doc-prev">${esc(txt ? txt.slice(0, 80) : inDrawer ? 'Open the doc' : '')}</span></button>`;
    },
    drawerTabs() { return [['doc', 'Doc']]; },
    drawerBody(tab, b, i) {
      if (tab !== 'doc') return null;
      hook();
      const list = docsOf(b), d = current(b, i);
      const c = d.id === '_notes' ? null : (b.columns || []).find(x => x.id === d.id);
      const s = S(), editable = d.id === '_notes' ? (s.canWrite) : (c && A().colEditable({ ...c, readonly: false }, b));
      const key = `${b.id}|${i.id}|${d.id}`;
      const ed = eds.get(key);
      return `<div class="doc-wrap" data-key="${esc(key)}" data-editable="${editable ? 1 : 0}">
        ${list.length > 1 ? `<div class="rx-row"><select class="field-input" data-doc-pick="1" aria-label="Which doc">${list.map(x => `<option value="${esc(x.id)}" ${x.id === d.id ? 'selected' : ''}>${esc(x.title)}${x.legacy ? ' (from Monday)' : ''}</option>`).join('')}</select>
          <button class="btn" data-act="doc-history">${s.docHist && s.docHist.key === key ? 'Hide history' : 'History'}</button></div>` : `<div class="rx-row"><button class="btn" data-act="doc-history">History</button></div>`}
        ${toolbar(editable)}
        <div class="doc-banner" data-key="${esc(key)}" hidden></div>
        <div class="doc-host" id="doc-host"></div>
        <div class="doc-status" data-key="${esc(key)}">${esc(ed ? ed.status : 'Loading…')}</div>
        ${s.docHist && s.docHist.key === key ? renderHistory(s.docHist) : ''}
      </div>`;
    },
    afterLayer() {
      const wrap = document.querySelector('.doc-wrap'); if (!wrap) return;
      const host = wrap.querySelector('#doc-host'), key = wrap.dataset.key, [bid, iid, col] = key.split('|');
      let ed = eds.get(key); const editable = wrap.dataset.editable === '1';
      if (!ed) ed = makeEditor(key, bid, iid, col, editable);
      ed.el.contentEditable = editable ? 'true' : 'false';
      host.appendChild(ed.el); paintStatus(ed);
    },
    onChange(e) {
      const t = e.target; if (!t.dataset || !t.dataset.docPick) return false;
      S().docSel = { item: S().openItem, col: t.value }; S().docHist = null; A().renderLayer(); return true;
    },
    onAct(a, t, e, b) {
      const s = S();
      if (a === 'doc-open') { s.openItem = t.dataset.item; s.drawerTab = 'doc'; s.docSel = { item: t.dataset.item, col: t.dataset.col }; s.docHist = null; A().renderLayer(); A().fillNames(); return true; }
      if (!a.startsWith('doc-')) return false;
      const wrap = document.querySelector('.doc-wrap'); const ed = wrap && eds.get(wrap.dataset.key); if (!ed) return true;
      if (a === 'doc-cmd') { cmd(ed, t.dataset.cmd); return true; }
      if (a === 'doc-load-theirs') { const bn = ed.banner; ed.banner = null; if (bn && bn.html != null) { ed.el.innerHTML = bn.html; ed.rev = bn.rev; ed.dirty = false; ed.status = 'Showing their version'; paintStatus(ed); } else load(ed); return true; }
      if (a === 'doc-keep-mine') { ed.banner = null; save(ed, { force: true }); return true; }
      if (a === 'doc-history') {
        if (s.docHist && s.docHist.key === ed.key) { s.docHist = null; A().renderLayer(); return true; }
        s.docHist = { key: ed.key, list: null, view: null }; A().renderLayer();
        KS.api('GET', '/api/itemdoc/versions?' + q(ed)).then(l => { if (s.docHist && s.docHist.key === ed.key) { s.docHist.list = l; A().renderLayer(); } }).catch(err => A().toast(err.message));
        return true;
      }
      if (a === 'doc-version') {
        KS.api('GET', '/api/itemdoc/version?' + q(ed) + '&id=' + encodeURIComponent(t.dataset.id)).then(v => { if (s.docHist) { s.docHist.view = v; A().renderLayer(); } }).catch(err => A().toast(err.message));
        return true;
      }
      if (a === 'doc-restore') {
        const v = s.docHist && s.docHist.view; if (!v) return true;
        ed.el.innerHTML = v.html; ed.loaded = true; save(ed, { force: true, restore: true }); s.docHist = null; A().toast('Version restored'); A().renderLayer(); return true;
      }
      return true;
    },
  });
  function renderHistory(h) {
    const list = h.list ? h.list.map(v => `<button class="li doc-v ${h.view && h.view.id === v.id ? 'on' : ''}" data-act="doc-version" data-id="${esc(v.id)}"><span class="li-main"><b>${esc(fmt(v.at))}</b> ${esc(v.byName || '')}</span></button>`).join('') || '<p class="rail-note">No versions yet. One is kept for each editing session, up to 20.</p>' : '<p class="rail-note">Loading.</p>';
    return `<div class="doc-hist"><h4 class="sec-title">Version history · last 20</h4><div class="doc-vlist">${list}</div>
      ${h.view ? `<div class="doc-vview"><div class="doc-ed ro">${h.view.html}</div>${S().canWrite ? '<button class="btn primary" data-act="doc-restore">Restore this version</button>' : ''}</div>` : ''}</div>`;
  }
  window.SolverDocs = { clean, editors: eds };
})();
