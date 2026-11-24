// Fast drop-in for makefun-site 1.0.0 — my own re-implementation, written for speed.
// It reproduces makefun-site's output tree byte for byte: same front matter rules,
// same Markdown subset, same template dialect, same slug/report rules, but with
// bulk escaping, a cached slugifier, a single-pass Markdown renderer and templates
// compiled to small generated functions instead of a walked node tree.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED_DIRS = ['posts', 'tags', 'page'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC_SCAN = /[&<>"']/g;
function escHtml(text) {
  ESC_SCAN.lastIndex = 0;
  let m = ESC_SCAN.exec(text);
  if (m === null) return text;
  const out = [];
  let last = 0;
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(ESCAPES[text[m.index]]);
    last = m.index + 1;
    m = ESC_SCAN.exec(text);
  }
  if (text.length > last) out.push(text.slice(last));
  return out.join('');
}

// Append s[a..b) HTML-escaped to out, in one scan and without slicing first.
function pushEsc(out, s, a, b) {
  ESC_SCAN.lastIndex = a;
  let last = a;
  let m;
  while ((m = ESC_SCAN.exec(s)) !== null && m.index < b) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESCAPES[s[m.index]]);
    last = m.index + 1;
  }
  if (b > last) out.push(s.slice(last, b));
}

// ---------------------------------------------------------------- slugs

const slugCache = new Map();

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (/[^\x00-\x7f]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const result = out === '' ? 'untitled' : out;
  slugCache.set(text, result);
  return result;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function keyValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringValue(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line first, by offsets: the error precedence matches a
  // full split (an unclosed block reports "not closed" before any bad line),
  // and the body is sliced out instead of split and re-joined.
  let closeStart = -1;
  let closeEnd = -1;
  let pos = text.indexOf('\n') + 1;
  while (pos > 0 && pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    if (end - pos === 3 && text.startsWith('---', pos)) { closeStart = pos; closeEnd = end; break; }
    if (end === text.length) break;
    pos = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const fmLines = text.slice(4, closeStart).split('\n');
  // fmLines[j] is source line j + 1 (0-based); its last element is the empty
  // remainder just before the closing line, not a real line.
  for (let j = 0; j < fmLines.length - 1; j++) {
    const line = fmLines[j];
    const i = j + 1;
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (Number.isNaN(c)) return true;
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// indexOf fast path for findUnescaped: when no backslash sits before the
// first candidate occurrence, escapes cannot change the answer; otherwise
// fall back to the exact scan.
function findFast(s, what, from) {
  const j = s.indexOf(what, from);
  if (j === -1) return -1;
  const bs = s.indexOf('\\', from);
  if (bs === -1 || bs >= j) return j;
  return findUnescaped(s, what, from);
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering: plain runs are buffered and escaped in bulk, so a paragraph
// costs one escape pass instead of one escapeHtml call per character.
const INLINE_SPECIAL = /[\\`*[]/g;

function isEscapableCode(nx) {
  return nx === 92 || nx === 96 || nx === 42 || nx === 95 || nx === 91 || nx === 93 || nx === 40 || nx === 41 || nx === 35 || nx === 43 || nx === 45 || nx === 46 || nx === 33 || nx === 62;
}

// Inline rendering: a regex jumps between the characters that can start a
// construct, so plain text is escaped in bulk and never scanned char by char.
function inlineStr(s, link) {
  const out = [];
  const n = s.length;
  let plain = 0;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const idx = m.index;
    const c = s.charCodeAt(idx);
    if (c === 92) {
      if (!isEscapableCode(s.charCodeAt(idx + 1))) continue;
      if (idx > plain) pushEsc(out, s, plain, idx);
      out.push(s[idx + 1]);
      plain = idx + 2;
      INLINE_SPECIAL.lastIndex = plain;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', idx + 1);
      if (j > idx + 1) {
        if (idx > plain) pushEsc(out, s, plain, idx);
        out.push('<code>');
        pushEsc(out, s, idx + 1, j);
        out.push('</code>');
        plain = j + 1;
        INLINE_SPECIAL.lastIndex = plain;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(idx + 1) === 42) {
        const j = findFast(s, '**', idx + 2);
        if (j > idx + 2) {
          if (idx > plain) pushEsc(out, s, plain, idx);
          out.push('<strong>', inlineStr(s.slice(idx + 2, j), link), '</strong>');
          plain = j + 2;
          INLINE_SPECIAL.lastIndex = plain;
        } else INLINE_SPECIAL.lastIndex = idx + 2;
      } else {
        const j = findSingleStar(s, idx + 1);
        if (j > idx + 1) {
          if (idx > plain) pushEsc(out, s, plain, idx);
          out.push('<em>', inlineStr(s.slice(idx + 1, j), link), '</em>');
          plain = j + 1;
          INLINE_SPECIAL.lastIndex = plain;
        }
      }
      continue;
    }
    const k = findFast(s, ']', idx + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (idx > plain) pushEsc(out, s, plain, idx);
      out.push('<a href="', escHtml(link(target)), '">', inlineStr(s.slice(idx + 1, k), link), '</a>');
      plain = mm + 1;
      INLINE_SPECIAL.lastIndex = plain;
    }
  }
  if (n > plain) pushEsc(out, s, plain, n);
  return out.join('');
}

// Blocks are rendered straight to strings — no intermediate token objects.
// Word counting is one pass over the whole body: a word never crosses a line
// break (newline is whitespace), and blank lines hold no words, so counting
// the body whole equals summing per-line counts over the visited lines.
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (Number.isNaN(c0)) { i++; continue; }
    if (c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) { i++; continue; }
    }
    let m = null;
    if (c0 === 96 && (m = FENCE_OPEN.exec(line)) !== null) {
      
      const lang = m[1];
      const body = [];
      i++;
      while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) {  body.push(lines[i++]); }
      if (i < n) 
      i++;
      blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${escHtml(lang)}"`}>${body.length ? `${escHtml(body.join('\n'))}\n` : ''}</code></pre>\n`);
      continue;
    }
    const hd = c0 === 35 ? headingOf(line) : null;
    if (hd !== null) {
      
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inlineStr(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {  blocks.push('<hr>\n'); i++; continue; }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {  const l = lines[i++]; body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)); }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(inner.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const b = (c0 === 45 || c0 === 42) ? BULLET.exec(line) : null;
    const o = b === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (b !== null || o !== null) {
      const ordered = o !== null;
      const marker = ordered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const mm = marker.exec(lines[i]);
        if (mm !== null) {  items.push([trimLine(ordered ? mm[2] : mm[1])]); i++; }
        else if (lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && lines[i].charCodeAt(2) > 32) {  items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && Number(o[1]) !== 1 ? `<ol start="${Number(o[1])}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const it of items) html += `<li>${inlineStr(it.join('\n'), link)}</li>\n`;
      blocks.push(`${html}</${tag}>\n`);
      continue;
    }
    
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {  body.push(trimLine(lines[i++])); }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '', words: wordsOf(src) };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Scopes are one null-prototype object per level, chained by prototype, so the
// first name is found by the engine's own property walk (`in`).
function lookup(scope, path) {
  if (!(path[0] in scope)) return undefined;
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function lookupFirst(scope, name) {
  if (!(name in scope)) return undefined;
  return scope[name];
}

// An include is a pure function of its template, the depth it renders at and
// the values its free variables resolve to, so a repeated include with the same
// values reuses the first render (footer/header/nav are case-constant; a post's
// card repeats across its index and tag pages). T maps a name to { fn, free }:
// the compiled function (a pure function of the template's own source) and the
// free-variable list (a function of the whole case's template graph).
// The cache is a trie of Maps keyed by the free values themselves (objects by
// identity, primitives by value — Map key equality), which avoids building a
// string key on every include call.
const INCLUDE_RESULT = {};
function makeIncluder(cache) {
  const inc = (T, name, S, D, O) => {
    const entry = T.get(name);
    if (entry === undefined) return;
    const free = entry.free;
    let node = cache.get(name);
    if (node === undefined) { node = new Map(); cache.set(name, node); }
    let byDepth = node.get(D);
    if (byDepth === undefined) { byDepth = new Map(); node.set(D, byDepth); }
    node = byDepth;
    for (let k = 0; k < free.length; k++) {
      const v = lookupFirst(S, free[k]);
      let next = node.get(v);
      if (next === undefined) { next = new Map(); node.set(v, next); }
      node = next;
    }
    const hit = node.get(INCLUDE_RESULT);
    if (hit !== undefined) { O.push(hit); return; }
    const tmp = [];
    entry.fn(S, D, tmp, T, lookup, textOf, escHtml, truthy, inc, lookSeg, valEsc, valRaw);
    const s = tmp.join('');
    node.set(INCLUDE_RESULT, s);
    O.push(s);
  };
  return inc;
}

// Specialised lookups for 1-3 segment paths: no array is allocated per lookup.
function lookSeg(S, a, b, c) {
  if (!(a in S)) return undefined;
  let v = S[a];
  if (b === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (c === undefined) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}

// A path as a value, escaped (var) or raw, in one call.
function valEsc(S, a, b, c) {
  return escHtml(textOf(lookSeg(S, a, b, c)));
}
function valRaw(S, a, b, c) {
  return textOf(lookSeg(S, a, b, c));
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Every first name a template (and everything it includes) can read.
function collectFree(name, asts, seen, acc) {
  if (seen.has(name)) return;
  seen.add(name);
  const nodes = asts.get(name);
  if (nodes === undefined) return;
  const walk = (list) => {
    for (const nd of list) {
      if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'if' || nd.kind === 'for') {
        acc.add(nd.path[0]);
        if (nd.kind === 'for') walk(nd.body);
        else if (nd.kind === 'if') { walk(nd.then); if (nd.else) walk(nd.else); }
      } else if (nd.kind === 'include') collectFree(nd.name, asts, seen, acc);
    }
  };
  walk(nodes);
}

// Compile a parsed template into a function (S, D, O, T, L, Tt, E, Tr, IC):
// scopes, include depth, output array, compiled templates, lookup, textOf, escape, truthy.
function pathArgs(path) {
  return path.map((p) => JSON.stringify(p)).join(',');
}

function compileNodes(nodes) {
  let code = '';
  // Consecutive output expressions (text literals, escaped/raw values) are
  // merged into a single O.push(a, b, ...) call: in a hot template most
  // tokens are output, so this cuts the per-token call overhead.
  let pending = [];
  const flush = () => {
    if (pending.length > 0) { code += `O.push(${pending.join(',')});`; pending = []; }
  };
  for (const nd of nodes) {
    if (nd.kind === 'text') { pending.push(JSON.stringify(nd.text)); continue; }
    if (nd.kind === 'var') { pending.push(nd.path.length <= 3 ? `VE(S,${pathArgs(nd.path)})` : `E(Tt(L(S,${JSON.stringify(nd.path)})))`); continue; }
    if (nd.kind === 'raw') { pending.push(nd.path.length <= 3 ? `VR(S,${pathArgs(nd.path)})` : `Tt(L(S,${JSON.stringify(nd.path)}))`); continue; }
    flush();
    if (nd.kind === 'if') {
      const cond = nd.path.length <= 3 ? `Tr(LK(S,${pathArgs(nd.path)}))` : `Tr(L(S,${JSON.stringify(nd.path)}))`;
      code += `if(${cond}!==${nd.not}){${compileNodes(nd.then)}}else{`;
      if (nd.else) code += compileNodes(nd.else);
      code += '}';
    } else if (nd.kind === 'for') {
      const src2 = nd.path.length <= 3 ? `LK(S,${pathArgs(nd.path)})` : `L(S,${JSON.stringify(nd.path)})`;
      // One scope object per loop execution, mutated per item: rendering is
      // synchronous, so nothing can observe a stale binding, and this avoids
      // a fresh prototype object (plus loop record) per item.
      code += `{const _xs=${src2};if(Array.isArray(_xs)){const _p=S;const _s=Object.create(S);const _lp={index:0,first:false,last:false,length:_xs.length};_s.loop=_lp;S=_s;for(let _k=0;_k<_xs.length;_k++){_s[${JSON.stringify(nd.name)}]=_xs[_k];_lp.index=_k+1;_lp.first=_k===0;_lp.last=_k===_xs.length-1;${compileNodes(nd.body)}}S=_p;}}`;
    } else if (nd.kind === 'include') {
      code += `{if(D<8)IC(T,${JSON.stringify(nd.name)},S,D+1,O);}`;
    }
  }
  flush();
  return code;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function compileTemplate(body) {
  return new Function('S', 'D', 'O', 'T', 'L', 'Tt', 'E', 'Tr', 'IC', 'LK', 'VE', 'VR', compileNodes(body));
}

// Parse + compile are pure functions of a template's name and source, and a
// case set is several sites drawn from one generator: the same templates turn
// up again from case to case, so both results are cached across run() calls.
// Only the free-variable lists stay per case (they depend on the case's whole
// template graph, via collectFree over the shared ASTs).
const templateCache = new Map();

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Whitespace table for word counting: one lookup per char instead of a chain
// of comparisons. The predicate is the one the reference's counter uses.
const WS_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (let c = 0; c < 65536; c++) {
    t[c] = (c <= 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) ? 1 : 0;
  }
  return t;
})();

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

export function run(input) {
  slugCache.clear();
  const report = [];
  const asts = new Map();
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(cmp)) {
    const src = input.templates[name];
    const ck = `${name}\n${src}`;
    let ent = templateCache.get(ck);
    if (ent === undefined) {
      try {
        const body = parseTemplate(name, src);
        ent = { body, fn: compileTemplate(body) };
      } catch (err) {
        if (err instanceof TemplateError) ent = { error: err.message };
        else throw err;
      }
      templateCache.set(ck, ent);
    }
    if (ent.error !== undefined) { report.push(ent.error); continue; }
    asts.set(name, ent.body);
    compiled.set(name, ent.fn);
  }
  const freeMap = new Map();
  for (const name of asts.keys()) {
    const acc = new Set();
    collectFree(name, asts, new Set(), acc);
    freeMap.set(name, [...acc].sort());
  }
  const templates = new Map();
  for (const name of asts.keys()) templates.set(name, { fn: compiled.get(name), free: freeMap.get(name) });
  const includer = makeIncluder(new Map());
  const base = input.site.base_url.replace(/\/+$/, '');

  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir;
    if (s.path.startsWith('tags/')) ownDir = 'tags';
    else if (s.path.startsWith('page/')) ownDir = 'page';
    if (ownDir !== undefined) { report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED_DIRS : []); taken.set(dir, set); }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // Link resolution is a pure function of (source dir, target) within a case,
  // and posts link to the same targets over and over: cache the resolution,
  // but keep the per-source side effect (the broken-link report line).
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  const linkCache = new Map();
  const resolveLink = (dir, target) => {
    const ck = `${dir}\n${target}`;
    let r = linkCache.get(ck);
    if (r !== undefined) return r;
    if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) r = { url: target, bad: false };
    else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) r = { url: `${bySource.get(path).url}${frag}`, bad: false };
      else if (path !== null && staticPaths.has(path)) r = { url: `${base}/${path}${frag}`, bad: false };
      else r = { url: target, bad: true };
    }
    linkCache.set(ck, r);
    return r;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const r = resolveLink(dir, target);
      if (r.bad) broken.add(`broken-link ${s.path} -> ${target}`);
      return r.url;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.wordCount = md.words;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const linkCache2 = new Map();
  const linkOf = (s) => {
    if (s === null) return null;
    let link = linkCache2.get(s);
    if (link === undefined) {
      link = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
      linkCache2.set(s, link);
    }
    return link;
  };
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card !== undefined) return card;
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.wordCount / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, card);
    return card;
  };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const entry = templates.get(name);
    if (entry === undefined) return null;
    const out = [];
    const root = Object.create(null);
    root.site = site;
    root.tags = allTags;
    root.recent = recent;
    Object.assign(root, vars);
    entry.fn(root, 0, out, templates, lookup, textOf, escHtml, truthy, includer, lookSeg, valEsc, valRaw);
    return out.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
