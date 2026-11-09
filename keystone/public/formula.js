// Keystone formula engine: evaluates Monday-style column formulas such as
//   IF({date_x}="", "", WORKDAYS(TODAY(), {date_x}) - 1)
// getRef(columnId) must return the column's value: a number, a string ("YYYY-MM-DD" for dates), a boolean, or "" when empty.
(function (root) {
  'use strict';

  function tokenize(src) {
    const t = []; let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new Error('Missing }'); t.push({ k: 'ref', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
      if (c === '"' || c === "'") { let j = i + 1, out = ''; while (j < src.length && src[j] !== c) { out += src[j]; j++; } t.push({ k: 'str', v: out }); i = j + 1; continue; }
      if (/[0-9.]/.test(c)) { let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++; t.push({ k: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue; }
      if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; t.push({ k: 'id', v: src.slice(i, j).toUpperCase() }); i = j; continue; }
      const two = src.slice(i, i + 2);
      if (['<>', '<=', '>=', '!=', '=='].includes(two)) { t.push({ k: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two }); i += 2; continue; }
      if ('+-*/^&=<>(),%'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
      throw new Error('Unexpected character ' + c);
    }
    return t;
  }

  // Recursive-descent parser producing a small AST.
  function parse(src) {
    const t = tokenize(src); let p = 0;
    const peek = () => t[p], eat = v => { if (t[p] && t[p].v === v) { p++; return true; } return false; };
    const expect = v => { if (!eat(v)) throw new Error('Expected ' + v); };
    function cmp() { let l = cat(); for (;;) { const o = peek(); if (o && o.k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(o.v)) { p++; l = { op: o.v, l, r: cat() }; } else return l; } }
    function cat() { let l = add(); while (eat('&')) l = { op: '&', l, r: add() }; return l; }
    function add() { let l = mul(); for (;;) { if (eat('+')) l = { op: '+', l, r: mul() }; else if (eat('-')) l = { op: '-', l, r: mul() }; else return l; } }
    function mul() { let l = pow(); for (;;) { if (eat('*')) l = { op: '*', l, r: pow() }; else if (eat('/')) l = { op: '/', l, r: pow() }; else return l; } }
    function pow() { let l = unary(); while (eat('^')) l = { op: '^', l, r: unary() }; return l; }
    function unary() { if (eat('-')) return { op: 'neg', l: unary() }; if (eat('+')) return unary(); return post(); }
    function post() { let e = prim(); if (eat('%')) e = { op: '/', l: e, r: { lit: 100 } }; return e; }
    function prim() {
      const x = t[p++];
      if (!x) throw new Error('Unexpected end');
      if (x.k === 'num' || x.k === 'str') return { lit: x.v };
      if (x.k === 'ref') return { ref: x.v };
      if (x.k === 'id') {
        if (eat('(')) { const args = []; if (!eat(')')) { do { args.push(cmp()); } while (eat(',')); expect(')'); } return { fn: x.v, args }; }
        if (x.v === 'TRUE') return { lit: true }; if (x.v === 'FALSE') return { lit: false };
        throw new Error('Unknown name ' + x.v);
      }
      if (x.v === '(') { const e = cmp(); expect(')'); return e; }
      throw new Error('Unexpected ' + x.v);
    }
    const ast = cmp(); if (p < t.length) throw new Error('Unexpected ' + t[p].v); return ast;
  }

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
  const toDate = v => { if (v instanceof Date) return v; if (isDate(v)) { const [y, m, d] = v.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); } return null; };
  const num = v => { if (v === '' || v === null || v === undefined) return 0; if (typeof v === 'boolean') return v ? 1 : 0; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false');
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function workdays(end, start) {
    const a = toDate(start), b = toDate(end); if (!a || !b) return '';
    const sign = b >= a ? 1 : -1; let from = sign > 0 ? a : b, to = sign > 0 ? b : a, n = 0;
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return sign * n;
  }
  const FN = {
    IF: (c, a = '', b = '') => (truthy(c) ? a : b),
    AND: (...a) => a.every(truthy), OR: (...a) => a.some(truthy), NOT: a => !truthy(a),
    TODAY: () => ymd(new Date()), NOW: () => new Date().toISOString(),
    DAYS: (end, start) => { const a = toDate(start), b = toDate(end); return a && b ? Math.round((b - a) / 864e5) : ''; },
    WORKDAYS: workdays,
    HOURS_DIFF: (a, b) => { const x = Date.parse(a), y = Date.parse(b); if (!x || !y) return ''; const m = Math.round(Math.abs(x - y) / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; },
    MIN: (...a) => { const n = a.filter(v => v !== '').map(num).filter(Number.isFinite); return n.length ? Math.min(...n) : ''; },
    MAX: (...a) => { const n = a.filter(v => v !== '').map(num).filter(Number.isFinite); return n.length ? Math.max(...n) : ''; },
    SUM: (...a) => a.reduce((s, v) => s + num(v), 0),
    AVERAGE: (...a) => { const n = a.filter(v => v !== '').map(num); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : ''; },
    ROUND: (v, d = 0) => { const f = 10 ** num(d); return Math.round(num(v) * f) / f; },
    ROUNDUP: (v, d = 0) => { const f = 10 ** num(d); return Math.ceil(num(v) * f) / f; },
    ROUNDDOWN: (v, d = 0) => { const f = 10 ** num(d); return Math.floor(num(v) * f) / f; },
    ABS: v => Math.abs(num(v)), MOD: (a, b) => num(a) % num(b), POWER: (a, b) => num(a) ** num(b), SQRT: v => Math.sqrt(num(v)),
    CONCATENATE: (...a) => a.map(v => (v === null || v === undefined ? '' : String(v))).join(''),
    LEN: v => String(v ?? '').length, LEFT: (v, n = 1) => String(v ?? '').slice(0, num(n)), RIGHT: (v, n = 1) => { const s = String(v ?? ''); return s.slice(Math.max(0, s.length - num(n))); },
    UPPER: v => String(v ?? '').toUpperCase(), LOWER: v => String(v ?? '').toLowerCase(), TRIM: v => String(v ?? '').trim(),
    TEXT: v => String(v ?? ''), YEAR: v => { const d = toDate(v); return d ? d.getFullYear() : ''; }, MONTH: v => { const d = toDate(v); return d ? d.getMonth() + 1 : ''; }, DAY: v => { const d = toDate(v); return d ? d.getDate() : ''; },
    ADD_DAYS: (v, n) => { const d = toDate(v); if (!d) return ''; d.setDate(d.getDate() + num(n)); return ymd(d); },
    SUBTRACT_DAYS: (v, n) => { const d = toDate(v); if (!d) return ''; d.setDate(d.getDate() - num(n)); return ymd(d); },
  };

  function evalNode(n, getRef, depth) {
    if ('lit' in n) return n.lit;
    if ('ref' in n) { const v = getRef(n.ref, depth + 1); return v === undefined || v === null ? '' : v; }
    if (n.fn) {
      const f = FN[n.fn]; if (!f) throw new Error('Unsupported function ' + n.fn);
      if (n.fn === 'IF') { const c = evalNode(n.args[0], getRef, depth); return evalNode(truthy(c) ? n.args[1] || { lit: '' } : n.args[2] || { lit: '' }, getRef, depth); }
      return f(...n.args.map(a => evalNode(a, getRef, depth)));
    }
    if (n.op === 'neg') return -num(evalNode(n.l, getRef, depth));
    const a = evalNode(n.l, getRef, depth), b = evalNode(n.r, getRef, depth);
    switch (n.op) {
      case '&': return String(a ?? '') + String(b ?? '');
      case '=': case '<>': {
        let eq;
        if (a === '' || b === '') eq = String(a) === String(b);
        else if (typeof a === 'number' || typeof b === 'number') eq = num(a) === num(b);
        else eq = String(a).toLowerCase() === String(b).toLowerCase();
        return n.op === '=' ? eq : !eq;
      }
      case '<': case '>': case '<=': case '>=': {
        const x = isDate(a) && isDate(b) ? a : num(a), y = isDate(a) && isDate(b) ? b : num(b);
        return n.op === '<' ? x < y : n.op === '>' ? x > y : n.op === '<=' ? x <= y : x >= y;
      }
      case '+': if (isDate(a) && !isDate(b)) return FN.ADD_DAYS(a, b); return num(a) + num(b);
      case '-': if (isDate(a) && isDate(b)) return FN.DAYS(a, b); if (isDate(a)) return FN.SUBTRACT_DAYS(a, b); return num(a) - num(b);
      case '*': return num(a) * num(b);
      case '/': { const d = num(b); return d === 0 ? '' : num(a) / d; }
      case '^': return num(a) ** num(b);
    }
    throw new Error('Bad operator');
  }

  const cache = new Map();
  function compile(src) {
    if (!cache.has(src)) { try { cache.set(src, { ast: parse(src) }); } catch (e) { cache.set(src, { error: e.message }); } }
    return cache.get(src);
  }
  // Returns { value } or { error }.
  function evaluate(src, getRef, depth = 0) {
    if (depth > 12) return { error: 'Formula refers to itself' };
    const c = compile(String(src || ''));
    if (c.error) return { error: c.error };
    try { const v = evalNode(c.ast, getRef, depth); return { value: typeof v === 'number' && !Number.isFinite(v) ? '' : v }; }
    catch (e) { return { error: e.message }; }
  }
  function format(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return v.toLocaleString('en-CA');
      return Math.abs(v) < 10 ? String(Math.round(v * 1000) / 1000) : v.toLocaleString('en-CA', { maximumFractionDigits: 2 });
    }
    return String(v);
  }
  root.KSFormula = { evaluate, format, parse };
  if (typeof module !== 'undefined') module.exports = root.KSFormula;
})(typeof window !== 'undefined' ? window : globalThis);
