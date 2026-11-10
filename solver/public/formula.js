// Solver.ca formula engine: evaluates Monday-style column formulas such as
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

  const BLANK = { blank: true };
  // An empty Number column. Monday's engine sees it as null: it counts as 0 in arithmetic and in < > comparisons,
  // but null = "" and null = 0 are both false (only null = null is true). So IF({n}="", a, b) takes b when {n} is empty.
  const NUL = { nul: true };
  const isBlank = v => v === BLANK;
  const plain = v => (isBlank(v) || v === NUL ? '' : v);
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
  // Decimal-safe rounding like Excel/Monday: 15 significant digits first, then shift the decimal point in the
  // number's text (so ROUND(1.005, 2) is 1.01, not 1.00), halves away from zero.
  const shift = (n, e) => { const [m, x] = String(n).split('e'); return Number(m + 'e' + (Number(x || 0) + e)); };
  function roundWith(v, d, how) {
    let x = num(v); const k = Math.trunc(num(d)); if (!Number.isFinite(x) || !Number.isFinite(k)) return NaN;
    x = Number(x.toPrecision(15));
    const s = Math.sign(x), a = shift(Math.abs(x), k);
    const r = how === 'up' ? Math.ceil(Number(a.toPrecision(15))) : how === 'down' ? Math.floor(Number(a.toPrecision(15))) : Math.round(a);
    return s * shift(r, -k) || 0;
  }
  // "14:30", "2:30 PM", "14:30:15" -> minutes of the day; anything else -> null
  function timeOnly(v) {
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/.exec(String(v ?? ''));
    if (!m) return null;
    let h = Number(m[1]); const ap = (m[4] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    return h * 60 + Number(m[2]);
  }
  // TEXT(value, format): number formats like "$#,##0.00", "0.0%", "000"; date formats like "YYYY-MM-DD", "MM/DD/YYYY"
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function textFmt(v, f) {
    if (f === undefined || f === '') return String(v ?? '');
    f = String(f);
    if (isDate(v) && /[YyDd]/.test(f)) {
      const d = toDate(v), p = n => String(n).padStart(2, '0');
      return f.replace(/YYYY|yyyy|YY|yy|MMMM|MMM|MM|M|DD|dd|D|d/g, t => {
        switch (t.toUpperCase()) {
          case 'YYYY': return String(d.getFullYear()); case 'YY': return p(d.getFullYear() % 100);
          case 'MMMM': return d.toLocaleString('en-US', { month: 'long' }); case 'MMM': return MONTHS[d.getMonth()];
          case 'MM': return p(d.getMonth() + 1); case 'M': return String(d.getMonth() + 1);
          case 'DD': return p(d.getDate()); default: return String(d.getDate());
        }
      });
    }
    const n = num(v); if (v === '' || !Number.isFinite(n)) return String(v ?? '');
    const m = /^([^#0.,]*)([#0,]*)(?:\.([0#]+))?([^#0.,]*)$/.exec(f);
    if (!m || !m[2]) return String(v);
    const pct = /%/.test(m[1] + m[4]), x = pct ? n * 100 : n;
    const dec = (m[3] || '').length, minDec = (m[3] || '').replace(/#+$/, '').length;
    let [ip, fp = ''] = Math.abs(roundWith(x, dec)).toFixed(dec).split('.');
    fp = fp.replace(new RegExp(`0{0,${dec - minDec}}$`), '');
    ip = ip.padStart((m[2].replace(/[#,]/g, '').length) || 0, '0'); if (/^0+$/.test(ip) && !/0/.test(m[2])) ip = '';
    if (m[2].includes(',')) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (x < 0 && roundWith(x, dec) !== 0 ? '-' : '') + m[1] + ip + (fp ? '.' + fp : '') + m[4];
  }
  const FN = {
    IF: (c, a = '', b = false) => (truthy(c) ? a : b),
    SWITCH: (v, ...a) => { for (let i = 0; i + 1 < a.length; i += 2) if (String(v).toLowerCase() === String(a[i]).toLowerCase()) return a[i + 1]; return a.length % 2 ? a[a.length - 1] : ''; },
    XOR: (...a) => a.filter(truthy).length % 2 === 1,
    AND: (...a) => a.every(truthy), OR: (...a) => a.some(truthy), NOT: a => !truthy(a),
    TODAY: () => ymd(new Date()), NOW: () => new Date().toISOString(),
    DAYS: (end, start) => { const a = toDate(start), b = toDate(end); return a && b ? Math.round((b - a) / 864e5) : ''; },
    WORKDAYS: workdays,
    // date-times are compared as instants; time-only values ("14:30", "2:30 PM") as times of the same day
    HOURS_DIFF: (a, b) => { const mins = v => { const t0 = timeOnly(v); if (t0 != null) return t0; const t = Date.parse(v); return Number.isFinite(t) ? Math.floor(t / 60000) : NaN; }; const x = mins(a), y = mins(b); if (!Number.isFinite(x) || !Number.isFinite(y)) return ''; const d = x - y, m = Math.abs(d); return `${d < 0 ? '-' : ''}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; },
    MIN: (...a) => { const n = a.filter(v => v !== '').map(num).filter(Number.isFinite); return n.length ? Math.min(...n) : ''; },
    MAX: (...a) => { const n = a.filter(v => v !== '').map(num).filter(Number.isFinite); return n.length ? Math.max(...n) : ''; },
    SUM: (...a) => a.reduce((s, v) => s + num(v), 0),
    AVERAGE: (...a) => { const n = a.filter(v => v !== '').map(num); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : ''; },
    ROUND: (v, d = 0) => roundWith(v, d, 'half'),
    ROUNDUP: (v, d = 0) => roundWith(v, d, 'up'), // away from zero, like Excel
    ROUNDDOWN: (v, d = 0) => roundWith(v, d, 'down'), // toward zero
    // MOD takes the divisor's sign, like Excel: MOD(-3, 2) = 1, MOD(3, -2) = -1
    ABS: v => Math.abs(num(v)), MOD: (a, b) => { const x = num(a), y = num(b); if (y === 0) return ''; const r = x - y * Math.floor(x / y); return Number(r.toPrecision(15)); }, POWER: (a, b) => num(a) ** num(b), SQRT: v => Math.sqrt(num(v)),
    CONCATENATE: (...a) => a.map(v => (v === null || v === undefined ? '' : String(v))).join(''),
    LEN: v => String(v ?? '').length, LEFT: (v, n = 1) => String(v ?? '').slice(0, num(n)), RIGHT: (v, n = 1) => { const s = String(v ?? ''); return s.slice(Math.max(0, s.length - num(n))); },
    UPPER: v => String(v ?? '').toUpperCase(), LOWER: v => String(v ?? '').toLowerCase(), TRIM: v => String(v ?? '').trim(),
    TEXT: textFmt, YEAR: v => { const d = toDate(v); return d ? d.getFullYear() : ''; }, MONTH: v => { const d = toDate(v); return d ? d.getMonth() + 1 : ''; }, DAY: v => { const d = toDate(v); return d ? d.getDate() : ''; },
    ADD_DAYS: (v, n) => { const d = toDate(v); if (!d) return ''; d.setDate(d.getDate() + num(n)); return ymd(d); },
    SUBTRACT_DAYS: (v, n) => { const d = toDate(v); if (!d) return ''; d.setDate(d.getDate() - num(n)); return ymd(d); },
  };

  function evalNode(n, getRef, depth) {
    if ('lit' in n) return n.lit;
    if ('ref' in n) { const v = getRef(n.ref, depth + 1); return v === undefined || v === null ? '' : (v && v.formulaBlank ? BLANK : v && v.emptyNumber ? NUL : v); }
    if (n.fn) {
      const f = FN[n.fn]; if (!f) throw new Error('Unsupported function ' + n.fn);
      if (n.fn === 'IF') { const c = plain(evalNode(n.args[0], getRef, depth)); return evalNode(truthy(c) ? n.args[1] || { lit: '' } : n.args[2] || { lit: false }, getRef, depth); }
      return f(...n.args.map(a => plain(evalNode(a, getRef, depth))));
    }
    if (n.op === 'neg') { const x = evalNode(n.l, getRef, depth); return isBlank(x) ? BLANK : -num(plain(x)); }
    let a = evalNode(n.l, getRef, depth), b = evalNode(n.r, getRef, depth);
    if ((isBlank(a) || isBlank(b)) && ['+', '-', '*', '/', '^'].includes(n.op)) return BLANK;
    if ((a === NUL || b === NUL) && (n.op === '=' || n.op === '<>')) { const eq = a === b; return n.op === '=' ? eq : !eq; }
    a = plain(a); b = plain(b);
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
      case '/': { const d = num(b); return d === 0 ? BLANK : num(a) / d; }
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
    try { const v = plain(evalNode(c.ast, getRef, depth)); return { value: typeof v === 'number' && !Number.isFinite(v) ? '' : v }; }
    catch (e) { return { error: e.message }; }
  }
  function format(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : '';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return v.toLocaleString('en-CA');
      return Math.abs(v) < 10 ? String(Math.round(v * 1000) / 1000) : v.toLocaleString('en-CA', { maximumFractionDigits: 2 });
    }
    return String(v);
  }
  // A date column with a time (Monday keeps the instant in "<col>__dt"): the shown day plus the local time and its
  // UTC offset, e.g. "2026-03-01T21:30:00-05:00". Day functions (DAYS, WORKDAYS, YEAR…) read the first 10 characters,
  // so they use the local day people see; HOURS_DIFF reads the exact instant. tz: an IANA zone, or the runtime's own.
  function dateRef(day, iso, tz) {
    if (!iso) return day || '';
    const d = new Date(iso); if (isNaN(d)) return day || '';
    let parts;
    try { parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value])); }
    catch (e) { return day || ''; }
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    const off = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000), a = Math.abs(off), p2 = n => String(n).padStart(2, '0');
    return `${parts.year}-${parts.month}-${parts.day}T${p2(+parts.hour % 24)}:${parts.minute}:${parts.second}${off < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
  }
  // {ref} in a formula: a column id, or else a column title (any case)
  function findCol(cols, ref) {
    cols = cols || []; const r = String(ref || '').trim();
    return cols.find(c => c.id === r) || cols.find(c => String(c.title || '').trim().toLowerCase() === r.toLowerCase()) || null;
  }
  root.KSFormula = { evaluate, format, parse, dateRef, findCol, BLANK_REF: { formulaBlank: true }, EMPTY_NUMBER: { emptyNumber: true } };
  if (typeof module !== 'undefined') module.exports = root.KSFormula;
})(typeof window !== 'undefined' ? window : globalThis);
