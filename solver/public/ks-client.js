// Solver.ca browser client: talks to the Solver.ca server (REST + live updates over server-sent events).
// It exposes the small document-store interface the CRM page uses: claude.use('db') and claude.use('user').
(() => {
  'use strict';
  const HEADERS = { 'Content-Type': 'application/json', 'X-Solver': '1' };

  async function call(method, url, body) {
    let r;
    try { r = await fetch(url, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
    catch (e) { throw { code: 'unavailable', message: 'Can’t reach the server.' }; }
    if (r.status === 401) { location.href = '/login'; throw { code: 'revoked', message: 'Signed out.' }; }
    let data = null; try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      const code = r.status === 403 ? 'invalid_argument' : r.status === 413 ? 'quota_exceeded' : r.status === 400 ? 'invalid_argument' : 'unavailable';
      throw { code, message: (data && data.error) || 'Request failed.' };
    }
    return data;
  }

  // ---- live collection cache ----
  const cols = new Map(); // collection path -> { docs: Map(id -> data), listeners: Set, loaded, pending }
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  function snapshot(entry) {
    const docs = [...entry.docs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, d]) => docSnap(id, d));
    return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: !entry.loaded, hasPendingWrites: false }, docChanges: () => [] };
  }
  function notify(entry) {
    if (entry.pending) return;
    entry.pending = true;
    queueMicrotask(() => { entry.pending = false; const s = snapshot(entry); entry.listeners.forEach(l => { try { l.next(s); } catch (e) { console.error(e); } }); });
  }
  async function load(path, entry) {
    const rows = await call('GET', '/api/col?path=' + encodeURIComponent(path));
    entry.docs = new Map(rows.map(r => [r.id, r.data]));
    entry.loaded = true;
    notify(entry);
  }

  let es = null, hadError = false;
  const listeners = {}; // live events that aren't documents, e.g. 'notify'
  const emit = (name, ev) => (listeners[name] || []).forEach(f => { try { f(ev); } catch (e) { console.error(e); } });
  function connect() {
    if (es) return;
    es = new EventSource('/api/events');
    es.onmessage = e => {
      let ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (ev.op === 'notify') { emit('notify', ev.n); return; }
      if (ev.op === 'reload') { cols.forEach((entry, path) => load(path, entry).catch(() => {})); return; }
      const entry = cols.get(ev.col); if (!entry) return;
      if (ev.op === 'set') entry.docs.set(ev.id, ev.data); else entry.docs.delete(ev.id);
      notify(entry);
    };
    es.onerror = () => { hadError = true; };
    es.onopen = () => { if (hadError) { hadError = false; cols.forEach((entry, path) => load(path, entry).catch(() => {})); emit('reconnect'); } };
  }

  function docRef(path) {
    const i = path.lastIndexOf('/');
    const col = path.slice(0, i), id = path.slice(i + 1);
    const url = '/api/doc?path=' + encodeURIComponent(path);
    const local = (data) => { const e = cols.get(col); if (e) { if (data === undefined) e.docs.delete(id); else e.docs.set(id, data); } };
    return {
      id, path,
      async get() { const r = await call('GET', url); return docSnap(id, r.exists ? r.data : undefined); },
      async set(data) { await call('PUT', url, data); local(JSON.parse(JSON.stringify(data))); },
      async update(data) { await call('PATCH', url, data); },
      async delete() { await call('DELETE', url); local(undefined); },
      collection(sub) { return colRef(path + '/' + sub); },
      onSnapshot(next, error) { const r = colRef(col).onSnapshot(s => next(s.docs.find(d => d.id === id) || docSnap(id, undefined)), error); return r; },
    };
  }
  function colRef(path) {
    return {
      path,
      doc(id) { return docRef(path + '/' + (id || ('d' + Math.random().toString(36).slice(2, 12)))); },
      async add(data) { const r = this.doc(); await r.set(data); return r; },
      async get() { const e = { docs: new Map(), listeners: new Set(), loaded: false }; await load(path, e); return snapshot(e); },
      onSnapshot(next, error) {
        connect();
        let entry = cols.get(path);
        const l = { next, error };
        if (!entry) { entry = { docs: new Map(), listeners: new Set(), loaded: false }; cols.set(path, entry); }
        entry.listeners.add(l);
        if (entry.loaded) notify(entry);
        else load(path, entry).catch(e => { if (error) error(e); });
        return () => { entry.listeners.delete(l); if (!entry.listeners.size) cols.delete(path); };
      },
    };
  }
  const db = { doc: docRef, collection: colRef };

  // ---- signed-in person ----
  let mePromise = null, team = null;
  const me = () => (mePromise = mePromise || call('GET', '/api/me'));
  const user = {
    async id() { return (await me()).id; },
    async me() { const m = await me(); return { id: m.id, name: m.name, email: m.email, role: m.role, homeBoard: m.homeBoard || '' }; },
    async isOwner() { return (await me()).role === 'admin'; },
    async canEdit() { return (await me()).role === 'admin'; },
    async can(name) { const r = (await me()).role; return name === 'data.write' ? r !== 'viewer' : r === 'admin'; },
    async profiles(ids) {
      team = team || call('GET', '/api/users').catch(() => []);
      const list = await team, out = {};
      ids.forEach(id => { const u = list.find(x => x.id === id); out[id] = { id, name: u ? u.name : '' }; });
      return out;
    },
  };

  window.KS = {
    logout: async () => { try { await call('POST', '/api/logout', {}); } catch (e) {} location.href = '/login'; },
    users: () => call('GET', '/api/users'),
    addUser: body => call('POST', '/api/users', body).then(r => { team = null; return r; }),
    api: (method, url, body) => call(method, url, body),
    summary: ws => call('GET', '/api/summary?ws=' + encodeURIComponent(ws || 'main')),
    mondayStatus: () => call('GET', '/api/admin/monday-sync'),
    mondaySync: () => call('POST', '/api/admin/monday-sync', {}),
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); connect(); },
    notifications: () => call('GET', '/api/notifications'),
    markRead: body => call('POST', '/api/notifications/read', body),
    notify: body => call('POST', '/api/notify', body),
    mondayPull: () => call('POST', '/api/admin/monday-pull', {}),
    // Uploads one file (raw body, up to 25 MB) for an item on a board. Resolves to { id, name, size, type, url }.
    async upload(file, board, item) {
      if (file.size > 25 * 1024 * 1024) throw { code: 'quota_exceeded', message: 'Files can be up to 25 MB.' };
      let r;
      try { r = await fetch('/api/files?board=' + encodeURIComponent(board) + '&item=' + encodeURIComponent(item || ''), { method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'X-Solver': '1', 'X-Filename': encodeURIComponent(file.name || 'file'), 'Content-Type': file.type || 'application/octet-stream' } }); }
      catch (e) { throw { code: 'unavailable', message: 'Can’t reach the server.' }; }
      let data = null; try { data = await r.json(); } catch (e) {}
      if (!r.ok) throw { code: 'unavailable', message: (data && data.error) || 'The upload failed.' };
      return data;
    },
    updateUser: (id, body) => call('PATCH', '/api/users/' + encodeURIComponent(id), body).then(r => { team = null; return r; }),
  };
  window.claude = { use: async name => (name === 'db' ? db : name === 'user' ? user : null) };
})();
