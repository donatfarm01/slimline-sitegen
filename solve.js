// Slimline — a hand-rolled single-pass static-site engine.
//
// Written from the makefun-site 1.0.0 specification (the vendor README) and
// verified by black-box differential testing against the house baseline:
// the reference implementation's source was never read. Every behaviour in
// here — front-matter refusals, the template dialect, the Markdown subset,
// the slug rule, link resolution, collections, pagination and the report —
// was derived from the spec and confirmed against the baseline's output on
// probe cases built for that purpose.
//
// Design: one pass over the sources, templates compiled once to op lists,
// a single string-builder per rendered file, no dependencies, no regex
// backtracking in the hot paths, no per-case state kept outside run().

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const EMPTY_OPS = [];
const HAS = Object.prototype.hasOwnProperty;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TPL_NAME_RE = /^[a-z0-9-]+$/;
const SLUG_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FM_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

// HTML-escape a string, fast path when nothing needs escaping.
function esc(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let r = null;
    if (c === '&') r = '&amp;';
    else if (c === '<') r = '&lt;';
    else if (c === '>') r = '&gt;';
    else if (c === '"') r = '&quot;';
    else if (c === "'") r = '&#39;';
    if (r !== null) { out += s.slice(last, i) + r; last = i + 1; }
  }
  return out + s.slice(last);
}

function pushEsc(out, s) { out.push(esc(s)); }

// The slug rule: NFKD, drop combining marks, A-Z lowered, each run of
// non [a-z0-9] to one '-', none at the ends, cut to 64 (a trailing '-' at
// the cut is dropped), 'untitled' when empty.
function slugify(s) {
  let t = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (t.length > 64) t = t.slice(0, 64).replace(/-+$/, '');
  return t === '' ? 'untitled' : t;
}

function dateLong(d) {
  return (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
}

function validDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return false;
  return v >= '1970-01-01' && v <= '2099-12-31';
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

// Parse one quoted string value (value starts with '"'). Returns the decoded
// value, or an error string.
function parseQuoted(key, value) {
  let i = 1;
  let out = '';
  while (i < value.length) {
    const c = value[i];
    if (c === '\\') {
      const n = value[i + 1];
      if (n !== '"' && n !== '\\') {
        return { error: 'key "' + key + '": a quoted string holds an escape other than \\" or \\\\' };
      }
      out += n;
      i += 2;
    } else if (c === '"') {
      if (i === value.length - 1) return { value: out };
      const rest = value.slice(i + 1);
      if (rest.indexOf('"') >= 0) {
        return { error: 'key "' + key + '": a quoted string holds a stray quote' };
      }
      return { error: 'key "' + key + '": a quoted string is not closed' };
    } else {
      out += c;
      i++;
    }
  }
  return { error: 'key "' + key + '": a quoted string is not closed' };
}

// Validate one key's value. Returns {value} or {error}.
function validateValue(key, value) {
  if (key === 'title' || key === 'summary') {
    if (value[0] === '"') return parseQuoted(key, value);
    if (value[0] === '[') return { error: 'key "' + key + '": a bare string opens on [' };
    return { value };
  }
  if (key === 'date') {
    if (!validDate(value)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value };
  }
  if (key === 'tags') {
    if (value[0] !== '[' || value[value.length - 1] !== ']') {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = value.slice(1, -1).trim();
    if (inner === '') return { value: [] };
    const items = inner.split(',');
    const tags = [];
    for (let it of items) {
      it = it.trim();
      if (it === '' || it.indexOf('"') >= 0 || it.indexOf('[') >= 0 || it.indexOf(']') >= 0) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags.push(it);
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (value !== 'true' && value !== 'false') return { error: 'key "draft": true or false' };
    return { value: value === 'true' };
  }
  if (key === 'layout') {
    if (!TPL_NAME_RE.test(value)) return { error: 'key "layout": not a template name' };
    return { value };
  }
  if (key === 'slug') {
    if (value.length > 64 || !SLUG_KEY_RE.test(value)) return { error: 'key "slug": not a slug' };
    return { value };
  }
  return { value };
}

// Parse front matter from the source's lines. Returns
// {fm, bodyStart} or {error}.
function parseFM(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close < 0) return { error: 'the front matter is not closed' };
  const fm = {};
  const seen = new Set();
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line === '') continue;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      if (line[j] !== ' ' && line[j] !== '\t') { blank = false; break; }
    }
    if (blank) continue;
    if (line[0] === '#') continue;
    const ci = line.indexOf(':');
    if (ci < 0) return { error: 'line ' + n + ' is not "key: value"' };
    const key = line.slice(0, ci);
    if (!/^[a-z_]+$/.test(key)) return { error: 'line ' + n + ' is not "key: value"' };
    let value;
    if (ci === line.length - 1) {
      value = '';
    } else if (line[ci + 1] === ' ') {
      value = line.slice(ci + 2);
      let e = value.length;
      while (e > 0 && (value[e - 1] === ' ' || value[e - 1] === '\t')) e--;
      value = value.slice(0, e);
    } else {
      return { error: 'line ' + n + ' is not "key: value"' };
    }
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { error: 'key "' + key + '" is given twice' };
    seen.add(key);
    if (value === '') return { error: 'key "' + key + '" has no value' };
    const r = validateValue(key, value);
    if (r.error) return { error: r.error };
    fm[key] = r.value;
  }
  if (fm.title === undefined) return { error: 'no title' };
  return { fm, bodyStart: close + 1 };
}

// ---------------------------------------------------------------------------
// Templates: compile to op lists
// ---------------------------------------------------------------------------

// Op kinds: 0 text, 1 escaped var, 2 raw var, 3 for, 4 if, 5 include.
function parsePath(s) {
  const t = s.trim();
  if (t === '') return null;
  const parts = t.split('.');
  for (const p of parts) if (!NAME_RE.test(p)) return null;
  return parts;
}

function compileTpl(src) {
  const n = src.length;
  let i = 0;
  const toks = [];
  while (i < n) {
    const j2 = src.indexOf('{{', i);
    const j3 = src.indexOf('{%', i);
    let j = -1, kind = 0;
    if (j2 >= 0 && (j3 < 0 || j2 <= j3)) { j = j2; kind = src[j + 2] === '{' ? 3 : 2; }
    else if (j3 >= 0) { j = j3; kind = 1; }
    if (j < 0) { toks.push({ k: 0, s: src.slice(i) }); break; }
    if (kind === 1) {
      const close = src.indexOf('%}', j + 2);
      if (close < 0) return { error: 'a {% is not closed' };
      // A {% %} tag alone on its line (only spaces/tabs beside it) takes
      // the whole line and its newline.
      const ls = src.lastIndexOf('\n', j - 1) + 1;
      const le = src.indexOf('\n', close + 2);
      const lineEnd = le < 0 ? n : le;
      const before = src.slice(ls, j);
      const after = src.slice(close + 2, lineEnd);
      let alone = true;
      for (let q = 0; q < before.length; q++) {
        if (before[q] !== ' ' && before[q] !== '\t') { alone = false; break; }
      }
      if (alone) {
        for (let q = 0; q < after.length; q++) {
          if (after[q] !== ' ' && after[q] !== '\t') { alone = false; break; }
        }
      }
      if (alone) {
        if (ls > i) toks.push({ k: 0, s: src.slice(i, ls) });
        toks.push({ k: 1, c: src.slice(j + 2, close) });
        i = lineEnd < n ? lineEnd + 1 : n;
        continue;
      }
      if (j > i) toks.push({ k: 0, s: src.slice(i, j) });
      toks.push({ k: 1, c: src.slice(j + 2, close) });
      i = close + 2;
    } else if (kind === 3) {
      const close = src.indexOf('}}}', j + 3);
      if (close < 0) return { error: 'a {{{ is not closed' };
      if (j > i) toks.push({ k: 0, s: src.slice(i, j) });
      const p = parsePath(src.slice(j + 3, close));
      if (!p) return { error: '"' + src.slice(j + 3, close).trim() + '" is not a path' };
      toks.push({ k: 2, p, raw: true });
      i = close + 3;
    } else {
      const close = src.indexOf('}}', j + 2);
      if (close < 0) return { error: 'a {{ is not closed' };
      if (j > i) toks.push({ k: 0, s: src.slice(i, j) });
      const p = parsePath(src.slice(j + 2, close));
      if (!p) return { error: '"' + src.slice(j + 2, close).trim() + '" is not a path' };
      toks.push({ k: 2, p, raw: false });
      i = close + 2;
    }
  }

  const root = [];
  const stack = [{ list: root, kind: 0, node: null, elseSeen: false }];
  let cur = stack[0];
  for (const t of toks) {
    if (t.k === 0) { if (t.s !== '') cur.list.push({ k: 0, s: t.s }); continue; }
    if (t.k === 2) { cur.list.push({ k: t.raw ? 2 : 1, p: t.p }); continue; }
    const c = t.c.trim();
    if (c === 'endfor') {
      if (cur.kind !== 1) return { error: 'an endfor with no open for' };
      stack.pop(); cur = stack[stack.length - 1]; continue;
    }
    if (c === 'endif') {
      if (cur.kind !== 2) return { error: 'an endif with no open if' };
      stack.pop(); cur = stack[stack.length - 1]; continue;
    }
    if (c === 'else') {
      if (cur.kind !== 2 || cur.elseSeen) return { error: 'an else outside an if' };
      cur.elseSeen = true;
      cur.list = cur.node.b;
      continue;
    }
    let m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(c);
    if (m) {
      const p = parsePath(m[2]);
      if (!p) return { error: '{% ' + c + ' %} is not a tag' };
      const node = { k: 3, v: m[1], p, body: [] };
      cur.list.push(node);
      const f = { list: node.body, kind: 1, node, elseSeen: false };
      stack.push(f); cur = f; continue;
    }
    m = /^if\s+(not\s+)?(.+)$/.exec(c);
    if (m) {
      const p = parsePath(m[2]);
      if (!p) return { error: '{% ' + c + ' %} is not a tag' };
      const node = { k: 4, p, neg: !!m[1], a: [], b: [] };
      cur.list.push(node);
      const f = { list: node.a, kind: 2, node, elseSeen: false };
      stack.push(f); cur = f; continue;
    }
    m = /^include\s+"([a-z0-9-]+)"$/.exec(c);
    if (m) { cur.list.push({ k: 5, name: m[1] }); continue; }
    return { error: '{% ' + c + ' %} is not a tag' };
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 1 ? 'a for is not closed' : 'a if is not closed' };
  }
  // An if with no else renders nothing on the false branch.
  return { ops: root };
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function resolvePath(p, ctx, scopes) {
  const first = p[0];
  let v;
  let found = false;
  for (let s = scopes.length - 1; s >= 0; s--) {
    if (HAS.call(scopes[s], first)) { v = scopes[s][first]; found = true; break; }
  }
  if (!found) {
    if (!HAS.call(ctx, first)) return undefined;
    v = ctx[first];
  }
  for (let i = 1; i < p.length; i++) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    if (!HAS.call(v, p[i])) return undefined;
    v = v[p[i]];
  }
  return v;
}

function truthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function valStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += valStr(v[i]);
    }
    return s;
  }
  return '';
}

function renderOps(ops, ctx, scopes, out, tpl, depth) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    if (op.k === 0) { out.push(op.s); continue; }
    if (op.k === 1 || op.k === 2) {
      const v = resolvePath(op.p, ctx, scopes);
      const s = valStr(v);
      if (op.k === 2) out.push(s); else pushEsc(out, s);
      continue;
    }
    if (op.k === 3) {
      const arr = resolvePath(op.p, ctx, scopes);
      if (Array.isArray(arr)) {
        const len = arr.length;
        for (let idx = 0; idx < len; idx++) {
          const frame = {};
          frame[op.v] = arr[idx];
          frame.loop = { index: idx + 1, first: idx === 0, last: idx === len - 1, length: len };
          scopes.push(frame);
          renderOps(op.body, ctx, scopes, out, tpl, depth);
          scopes.pop();
        }
      }
      continue;
    }
    if (op.k === 4) {
      const v = resolvePath(op.p, ctx, scopes);
      const t = truthy(v);
      renderOps(t !== op.neg ? op.a : op.b, ctx, scopes, out, tpl, depth);
      continue;
    }
    // include
    if (depth + 1 > 8) continue;
    const sub = tpl[op.name];
    if (!sub) continue;
    renderOps(sub.ops, ctx, scopes, out, tpl, depth + 1);
  }
}

function renderTpl(all, name, ctx) {
  const out = [];
  renderOps(all[name].ops, ctx, [], out, all, 0);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

function isBreakLine(line) {
  if (line === '---' || line === '***') return true;
  if (line.startsWith('---')) {
    for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
    return true;
  }
  if (line.startsWith('***')) {
    for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
    return true;
  }
  return false;
}

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
    c === '_' || c === '+' || c === '-';
}

// Fence opener: ``` + optional language + spaces/tabs only. Returns the
// language ('' when none) or null.
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  for (let k = j; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return null;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Heading: 1-6 '#' + >=1 space/tab + text (trailing spaces/tabs dropped).
// Returns {level, text} or null.
function headingMatch(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  let j = n;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let e = line.length;
  while (e > j && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === j) return null;
  return { level: n, text: line.slice(j, e) };
}

// List item: '- '/'* ' bullet or digits+'. ' ordered. Returns
// {kind, num, text} or null.
function listMatch(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') {
    return { kind: 'ul', num: 0, text: line.slice(2) };
  }
  if (line[0] >= '0' && line[0] <= '9') {
    let i = 0;
    while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
    if (line[i] === '.' && line[i + 1] === ' ') {
      return { kind: 'ol', num: parseInt(line.slice(0, i), 10), text: line.slice(i + 2) };
    }
  }
  return null;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

// --- inline parsing --------------------------------------------------------

// Find the next backtick at or after `from` (caller passes opener+2, so at
// least one character sits between opener and closer). Escapes are not
// honoured here: the next backtick closes the span.
function findBacktick(s, from, end) {
  let k = from;
  while (k < end) {
    if (s[k] === '`') return k;
    k++;
  }
  return -1;
}

// Find the next '**' at or after `from` (the content start), skipping
// escaped characters. The closer must start at >= from+1, so at least one
// character sits between opener and closer.
function findStrong(s, from, end) {
  let k = from;
  while (k + 1 < end) {
    if (s[k] === '\\' && k + 1 < end) { k += 2; continue; }
    if (s[k] === '*' && s[k + 1] === '*' && k >= from + 1) return k;
    k++;
  }
  return -1;
}

// Find the next lone '*' at or after `from` (the content start): escaped
// characters are skipped, and a '**' pair is skipped as a unit, so neither
// of its stars can close an emphasis. The closer must sit at >= from+1, so
// at least one character sits between opener and closer.
function findEm(s, from, end) {
  let k = from;
  while (k < end) {
    if (s[k] === '\\' && k + 1 < end) { k += 2; continue; }
    if (s[k] === '*' && s[k + 1] === '*') { k += 2; continue; }
    if (s[k] === '*' && k >= from + 1) return k;
    k++;
  }
  return -1;
}

function hasWhitespace(s, a, b) {
  for (let i = a; i < b; i++) if (isWs(s[i])) return true;
  return false;
}

// Try to parse a link starting at s[i] === '['. On success appends the
// anchor to out and returns the index after the closing ')'; else -1.
function tryLink(s, i, end, out, link) {
  let j = i + 1;
  while (j < end) {
    if (s[j] === '\\' && j + 1 < end) { j += 2; continue; }
    if (s[j] === ']') break;
    j++;
  }
  if (j >= end || s[j + 1] !== '(') return -1;
  let k = j + 2;
  while (k < end && s[k] !== ')') k++;
  if (k >= end) return -1;
  if (k === j + 2 || hasWhitespace(s, j + 2, k)) return -1;
  const target = s.slice(j + 2, k);
  const href = link(target);
  out.push('<a href="');
  pushEsc(out, href);
  out.push('">');
  parseInline(s, i + 1, j, out, link);
  out.push('</a>');
  return k + 1;
}

// Inline markup over s[a..b). Appends rendered HTML to out.
function parseInline(s, a, b, out, link) {
  let i = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\') {
      const n = i + 1 < b ? s[i + 1] : '';
      if (ESCAPABLE.has(n)) {
        if (n === '>') out.push('&gt;');
        else out.push(n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === '`') {
      // A backtick opens a code span only when the next character is not
      // itself a backtick; the closer is the next backtick after it.
      if (s[i + 1] === '`') {
        out.push('`');
        i++;
      } else {
        const j = findBacktick(s, i + 2, b);
        if (j >= 0) {
          out.push('<code>');
          pushEscRange(out, s, i + 1, j);
          out.push('</code>');
          i = j + 1;
        } else {
          out.push('`');
          i++;
        }
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        // Strong: only when the run of stars here is at most three. A run
        // of four or more leaves its first two stars literal.
        if (s[i + 2] === '*' && s[i + 3] === '*') {
          out.push('**');
          i += 2;
        } else {
          const j = findStrong(s, i + 2, b);
          if (j >= 0) {
            out.push('<strong>');
            parseInline(s, i + 2, j, out, link);
            out.push('</strong>');
            i = j + 2;
          } else {
            out.push('**');
            i += 2;
          }
        }
      } else {
        const j = findEm(s, i + 1, b);
        if (j >= 0) {
          out.push('<em>');
          parseInline(s, i + 1, j, out, link);
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else if (c === '[') {
      const r = tryLink(s, i, b, out, link);
      if (r < 0) { out.push('['); i++; }
      else i = r;
    } else if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (c === '&') out.push('&amp;');
      else if (c === '<') out.push('&lt;');
      else if (c === '>') out.push('&gt;');
      else if (c === '"') out.push('&quot;');
      else out.push('&#39;');
      i++;
    } else {
      // A run of plain characters: push it as one slice instead of one
      // array entry per character.
      let j = i + 1;
      while (j < b) {
        const d = s[j];
        if (d === '\\' || d === '`' || d === '*' || d === '[' || d === '&' || d === '<' || d === '>' || d === '"' || d === "'") break;
        j++;
      }
      out.push(s.slice(i, j));
      i = j;
    }
  }
}

// HTML-escape the slice s[a..b) into out.
function pushEscRange(out, s, a, b) {
  let last = a;
  for (let i = a; i < b; i++) {
    const c = s[i];
    let r = null;
    if (c === '&') r = '&amp;';
    else if (c === '<') r = '&lt;';
    else if (c === '>') r = '&gt;';
    else if (c === '"') r = '&quot;';
    else if (c === "'") r = '&#39;';
    if (r !== null) {
      out.push(s.slice(last, i), r);
      last = i + 1;
    }
  }
  out.push(s.slice(last, b));
}

// Render a body's lines (lines[start..end)) to HTML. Returns
// {html, excerpt, toc}.
function renderMd(lines, start, end, link) {
  const out = [];
  let excerpt = '';
  const toc = [];
  const ids = new Map();
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < end && !isFenceClose(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < end) i++; // closing fence
      out.push('<pre><code');
      if (lang !== '') { out.push(' class="language-'); pushEsc(out, lang); out.push('"'); }
      out.push('>');
      for (const bl of body) { pushEscRange(out, bl, 0, bl.length); out.push('\n'); }
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingMatch(line);
    if (h) {
      const baseId = slugify(h.text);
      const seen = ids.get(baseId) || 0;
      const id = seen > 0 ? baseId + '-' + (seen + 1) : baseId;
      ids.set(baseId, seen + 1);
      const inner = [];
      parseInline(h.text, 0, h.text.length, inner, link);
      const html = inner.join('');
      // The table of contents holds level 2 and 3 headings only.
      if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html });
      out.push('<h' + h.level + ' id="' + id + '">' + html + '</h' + h.level + '>\n');
      i++;
      continue;
    }
    if (isBreakLine(line)) { out.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const q = [];
      while (i < end && lines[i][0] === '>') {
        let t = lines[i].slice(1);
        if (t[0] === ' ') t = t.slice(1);
        t = trimLine(t);
        if (t !== '') q.push(t);
        i++;
      }
      if (q.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const qtext = q.join('\n');
        const inner = [];
        parseInline(qtext, 0, qtext.length, inner, link);
        out.push('<blockquote>\n<p>' + inner.join('') + '</p>\n</blockquote>\n');
      }
      continue;
    }
    const li = listMatch(line);
    if (li) {
      const items = [];
      const kind = li.kind;
      let firstNum = li.num;
      let cur = trimLine(li.text);
      i++;
      while (i < end) {
        const l2 = lines[i];
        if (isBlankLine(l2)) break;
        const m2 = listMatch(l2);
        if (m2 && m2.kind === kind) {
          items.push(cur);
          cur = trimLine(m2.text);
          i++;
          continue;
        }
        if (l2.length >= 2 && l2[0] === ' ' && l2[1] === ' ' && trimLine(l2) !== '') {
          cur += '\n' + trimLine(l2);
          i++;
          continue;
        }
        break;
      }
      items.push(cur);
      out.push(kind === 'ul' ? '<ul>\n' : (firstNum === 1 ? '<ol>\n' : '<ol start="' + firstNum + '">\n'));
      for (const it of items) {
        const inner = [];
        parseInline(it, 0, it.length, inner, link);
        out.push('<li>' + inner.join('') + '</li>\n');
      }
      out.push(kind === 'ul' ? '</ul>\n' : '</ol>\n');
      continue;
    }
    // Paragraph: this line plus following lines up to a blank line, a
    // fence, a heading or a thematic break.
    const parts = [trimLine(line)];
    i++;
    while (i < end) {
      const l2 = lines[i];
      if (isBlankLine(l2)) break;
      if (fenceLang(l2) !== null) break;
      if (headingMatch(l2)) break;
      if (isBreakLine(l2)) break;
      parts.push(trimLine(l2));
      i++;
    }
    const text = parts.join('\n');
    const inner = [];
    parseInline(text, 0, text.length, inner, link);
    const html = inner.join('');
    if (excerpt === '') excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), excerpt, toc };
}

// Reading minutes: the body's words — runs of non-whitespace in the raw
// body — over 200, rounded up, at least 1.
function readingMinutes(lines, start) {
  let words = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      if (isWs(line[j])) { inWord = false; }
      else if (!inWord) { words++; inWord = true; }
    }
  }
  return Math.max(1, Math.ceil(words / 200));
}

// ---------------------------------------------------------------------------
// Link resolution
// ---------------------------------------------------------------------------

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function makeLink(sourcePath, sourceDir, pageBySource, staticByPath, base, report, broken) {
  return function (target) {
    if (target[0] === '#' || target[0] === '/') return target;
    if (SCHEME_RE.test(target)) return target;
    let path = target;
    let frag = '';
    const hi = target.indexOf('#');
    if (hi >= 0) { path = target.slice(0, hi); frag = target.slice(hi); }
    const parts = sourceDir === '' ? [] : sourceDir.split('/');
    const segs = path.split('/');
    let above = false;
    for (const seg of segs) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) { above = true; break; }
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    if (!above) {
      const resolved = parts.join('/');
      const page = pageBySource.get(resolved);
      if (page) return page.url + frag;
      if (staticByPath.has(resolved)) return base + '/' + resolved + frag;
    }
    const key = sourcePath + '\0' + target;
    if (!broken.has(key)) {
      broken.add(key);
      report.push('broken-link ' + sourcePath + ' -> ' + target);
    }
    return target;
  };
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export function run(input) {
  const site = input.site;
  const tpls = input.templates;
  const files = input.files;
  const base = String(site.base_url).replace(/\/+$/, '');
  const report = [];
  const broken = new Set();
  const out = {};

  // Sort files in code-unit order; split sources from statics.
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) sources.push(f);
    else statics.push(f);
  }
  const staticByPath = new Set();
  for (const f of statics) staticByPath.add(f.path);

  // Parse templates in name order; an unparsable template is reported and
  // left out.
  const names = Object.keys(tpls).sort();
  const compiled = {};
  for (const name of names) {
    const r = compileTpl(tpls[name]);
    if (r.error) report.push('template "' + name + '": ' + r.error);
    else compiled[name] = r;
  }

  // Parse sources, in path order, and assign slugs per directory.
  const pages = [];
  const pageBySource = new Map();
  const usedSlugs = new Map();
  for (const f of sources) {
    const content = f.content.replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const r = parseFM(lines);
    if (r.error) { report.push('refused ' + f.path + ': ' + r.error); continue; }
    const fm = r.fm;
    const isPost = f.path.startsWith('posts/');
    const dir = isPost ? 'posts' : dirOf(f.path);
    const first = f.path.split('/')[0];
    if (first === 'tags' || first === 'page') {
      report.push('refused ' + f.path + ': ' + first + '/ is the generator\'s own');
      continue;
    }
    if (isPost && !fm.date) { report.push('refused ' + f.path + ': a post needs a date'); continue; }
    const layout = fm.layout || (isPost ? 'post' : 'page');
    if (!compiled[layout]) {
      report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft) { report.push('draft ' + f.path); continue; }
    let used = usedSlugs.get(dir);
    if (!used) {
      used = new Set();
      if (dir === '') { used.add('posts'); used.add('tags'); used.add('page'); }
      usedSlugs.set(dir, used);
    }
    const baseSlug = fm.slug || slugify(fm.title);
    let slug = baseSlug;
    let n = 2;
    while (used.has(slug)) { slug = baseSlug + '-' + n; n++; }
    used.add(slug);
    const url = base + '/' + (dir === '' ? '' : dir + '/') + slug + '/';
    const page = {
      source: f.path, isPost, dir, slug, url,
      title: fm.title, summary: fm.summary || '', date: fm.date || '',
      tags: fm.tags || [], layout, lines, bodyStart: r.bodyStart,
      newer: null, older: null,
    };
    pages.push(page);
    pageBySource.set(f.path, page);
  }

  // Render every page's body (Markdown + link resolution).
  for (const page of pages) {
    const link = makeLink(page.source, dirOf(page.source), pageBySource, staticByPath, base, report, broken);
    const md = renderMd(page.lines, page.bodyStart, page.lines.length, link);
    page.content = md.html;
    page.excerpt = md.excerpt;
    page.toc = md.toc;
    page.readingMinutes = readingMinutes(page.lines, page.bodyStart);
    page.dateLong = page.date === '' ? '' : dateLong(page.date);
  }

  // A source may list the same tag twice; each tag counts once per page,
  // in the order first written.
  for (const p of pages) {
    const seen = new Set();
    const entries = [];
    for (const name of p.tags) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({ name, slug });
    }
    p.tagEntries = entries;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = [];
  for (const p of pages) if (p.isPost) posts.push(p);
  posts.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // Tags: first spelling kept, walking posts in collection order; ordered
  // by post count desc, then slug.
  const tagMap = new Map();
  for (const p of posts) {
    for (const e of p.tagEntries) {
      const slug = e.slug;
      let tag = tagMap.get(slug);
      if (!tag) {
        tag = { name: e.name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] };
        tagMap.set(slug, tag);
      }
      tag.count++;
      tag.posts.push(p);
    }
  }
  const tagList = Array.from(tagMap.values());
  tagList.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Cards.
  function cardOf(p) {
    const tags = [];
    for (const e of p.tagEntries) {
      const slug = e.slug;
      const tag = tagMap.get(slug);
      // A tag's name is the first spelling met walking the posts; a tag no
      // post carries keeps the spelling the source wrote.
      tags.push({ name: tag ? tag.name : e.name, slug, url: tag ? tag.url : '' });
    }
    return {
      title: p.title, url: p.url, date: p.date, date_long: p.dateLong,
      summary: p.summary, excerpt: p.excerpt, reading_minutes: p.readingMinutes,
      tags,
    };
  }
  function pageObj(p) {
    const c = cardOf(p);
    c.slug = p.slug;
    c.content = p.content;
    c.toc = p.toc;
    c.newer = p.newer ? {
      title: p.newer.title, url: p.newer.url, date: p.newer.date, date_long: p.newer.dateLong,
    } : null;
    c.older = p.older ? {
      title: p.older.title, url: p.older.url, date: p.older.date, date_long: p.older.dateLong,
    } : null;
    c.is_post = p.isPost;
    return c;
  }

  const siteCtx = { title: site.title, base_url: base };
  const tagsCtx = tagList.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recentN = site.recent || 0;
  const recentCards = posts.slice(0, recentN).map(cardOf);

  // Render pages and posts through their layout.
  let pageCount = 0;
  for (const p of pages) {
    if (!p.isPost) pageCount++;
    const ctx = { site: siteCtx, tags: tagsCtx, recent: recentCards, page: pageObj(p) };
    const s = renderTpl(compiled, p.layout, ctx);
    out[(p.dir === '' ? '' : p.dir + '/') + p.slug + '/index.html'] = s;
  }

  // Index pages.
  if (compiled.index) {
    const perPage = site.per_page || 5;
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let n = 1; n <= total; n++) {
      const slice = posts.slice((n - 1) * perPage, n * perPage).map(cardOf);
      const pager = {
        number: n, total,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n === 1 ? '' : (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/'),
        older_url: n === total ? '' : base + '/page/' + (n + 1) + '/',
      };
      const ctx = { site: siteCtx, tags: tagsCtx, recent: recentCards, posts: slice, pager };
      const s = renderTpl(compiled, 'index', ctx);
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = s;
    }
  }

  // Tag pages and the tags index.
  if (compiled.tag) {
    for (const t of tagList) {
      const tagPosts = t.posts.map(cardOf);
      const ctx = {
        site: siteCtx, tags: tagsCtx, recent: recentCards,
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: tagPosts },
        posts: tagPosts,
      };
      out['tags/' + t.slug + '/index.html'] = renderTpl(compiled, 'tag', ctx);
    }
  }
  if (compiled.tags) {
    const ctx = { site: siteCtx, tags: tagsCtx, recent: recentCards };
    out['tags/index.html'] = renderTpl(compiled, 'tags', ctx);
  }

  // Static files at their own path, unless a built page has that path.
  for (const f of statics) {
    if (HAS.call(out, f.path) || f.path === 'build-report.txt') {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      out[f.path] = f.content;
    }
  }

  // The report: every reported line, sorted, then the summary line.
  report.sort();
  const summary = 'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' +
    tagList.length + ' tags and ' + statics.length + ' static files';
  out['build-report.txt'] = (report.length > 0 ? report.join('\n') + '\n' : '') + summary + '\n';
  return out;
}
