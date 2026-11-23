// A small, strict YAML reader for GitHub Actions workflow files.
//
// It covers what workflow files normally use: block mappings and sequences,
// compact "- key: value" items, flow collections on one line, single- and
// double-quoted scalars, plain scalars (including multi-line plain values),
// literal and folded block scalars, and comments.
//
// Anything else (anchors, aliases, tags, merge keys, complex keys, multiple
// documents, multi-line flow or quoted scalars, tabs in indentation) raises a
// YamlError. The policy checker treats that as a violation, so an unreadable
// file can never pass by accident. Scalars are returned as strings; `key:` with
// no value is null. Line numbers (1-based) are kept for every mapping key and
// sequence item and can be read with lineOf().

export class YamlError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

const LINES = Symbol('yaml-lite.lines');

/** Line number of a mapping key or sequence index inside a parsed container. */
export function lineOf(container, key) {
  return container?.[LINES]?.get(key);
}

function withLines(target) {
  Object.defineProperty(target, LINES, { value: new Map(), enumerable: false });
  return target;
}

function setKey(obj, key, value, line) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  obj[LINES].set(key, line);
}

function leadingSpaces(raw) {
  let n = 0;
  while (n < raw.length && raw[n] === ' ') n++;
  return n;
}

// Strip a trailing comment. A quote only opens a quoted scalar at the start of a
// token, so apostrophes inside plain words don't hide a comment.
function stripComment(text) {
  let quote = null;
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
    if ((c === '"' || c === "'") && (prev === '' || ':-[{,?'.includes(prev))) quote = c;
    if (!/\s/.test(c)) prev = c;
  }
  return text;
}

function parseDoubleQuoted(s, start, line) {
  let out = '';
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') { out += c; continue; }
    const e = s[++i];
    const simple = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', b: '\b', f: '\f', e: '\x1b', a: '\x07', v: '\v' };
    if (e in simple) out += simple[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new YamlError('bad escape in double-quoted scalar', line);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += len;
    } else throw new YamlError(`unknown escape \\${e ?? ''} in double-quoted scalar`, line);
  }
  throw new YamlError('unterminated double-quoted scalar (multi-line quoted scalars are not supported)', line);
}

function parseSingleQuoted(s, start, line) {
  let out = '';
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { out += "'"; i++; continue; }
      return { value: out, end: i + 1 };
    }
    out += s[i];
  }
  throw new YamlError('unterminated single-quoted scalar (multi-line quoted scalars are not supported)', line);
}

function rejectSpecial(c, line) {
  if (c === '&' || c === '*') throw new YamlError('anchors and aliases are not supported', line);
  if (c === '!') throw new YamlError('tags are not supported', line);
  if (c === '%' || c === '@' || c === '`') throw new YamlError(`reserved indicator ${c}`, line);
}

// ---- flow collections (single line) ----

function flowNode(s, pos, line, inMap) {
  while (s[pos] === ' ') pos++;
  const c = s[pos];
  if (c === undefined) throw new YamlError('unterminated flow collection (multi-line flow collections are not supported)', line);
  rejectSpecial(c, line);
  if (c === '{') return flowMap(s, pos, line);
  if (c === '[') return flowSeq(s, pos, line);
  if (c === '"') return parseDoubleQuoted(s, pos, line);
  if (c === "'") return parseSingleQuoted(s, pos, line);
  let end = pos;
  while (end < s.length) {
    const ch = s[end];
    if (ch === ',' || ch === ']' || ch === '}') break;
    if (inMap && ch === ':' && (end + 1 >= s.length || ' ,]}'.includes(s[end + 1]))) break;
    end++;
  }
  return { value: s.slice(pos, end).trim(), end };
}

function flowMap(s, pos, line) {
  const obj = withLines({});
  pos++;
  for (;;) {
    while (s[pos] === ' ') pos++;
    if (s[pos] === '}') return { value: obj, end: pos + 1 };
    const k = flowNode(s, pos, line, true);
    if (typeof k.value !== 'string') throw new YamlError('complex keys are not supported', line);
    pos = k.end;
    while (s[pos] === ' ') pos++;
    let value = null;
    if (s[pos] === ':') {
      pos++;
      while (s[pos] === ' ') pos++;
      if (s[pos] !== ',' && s[pos] !== '}') {
        const v = flowNode(s, pos, line, true);
        value = v.value === '' ? null : v.value;
        pos = v.end;
      }
    }
    if (Object.prototype.hasOwnProperty.call(obj, k.value)) throw new YamlError(`duplicate key "${k.value}"`, line);
    if (k.value === '<<') throw new YamlError('merge keys are not supported', line);
    setKey(obj, k.value, value, line);
    while (s[pos] === ' ') pos++;
    if (s[pos] === ',') { pos++; continue; }
    if (s[pos] === '}') return { value: obj, end: pos + 1 };
    throw new YamlError('unterminated flow mapping (multi-line flow collections are not supported)', line);
  }
}

function flowSeq(s, pos, line) {
  const arr = withLines([]);
  pos++;
  for (;;) {
    while (s[pos] === ' ') pos++;
    if (s[pos] === ']') return { value: arr, end: pos + 1 };
    const v = flowNode(s, pos, line, false);
    arr[LINES].set(arr.length, line);
    arr.push(v.value);
    pos = v.end;
    while (s[pos] === ' ') pos++;
    if (s[pos] === ',') { pos++; continue; }
    if (s[pos] === ']') return { value: arr, end: pos + 1 };
    throw new YamlError('unterminated flow sequence (multi-line flow collections are not supported)', line);
  }
}

// ---- keys ----

function matchKey(text, line) {
  let key;
  let after;
  const c = text[0];
  if (c === '?' && (text.length === 1 || text[1] === ' ')) throw new YamlError('complex keys are not supported', line);
  if (c === '"' || c === "'") {
    const q = c === '"' ? parseDoubleQuoted(text, 0, line) : parseSingleQuoted(text, 0, line);
    key = q.value;
    after = text.slice(q.end).trimStart();
    if (!after.startsWith(':') || (after.length > 1 && after[1] !== ' ')) return null;
    return { key, rest: after.slice(1).trim() };
  }
  if (c === '[' || c === '{' || c === '-' && (text.length === 1 || text[1] === ' ')) return null;
  const m = /^(.*?):(?: +(.*))?$/.exec(text);
  if (!m) return null;
  key = m[1].trim();
  if (key === '' ) return null;
  rejectSpecial(key[0], line);
  if (key === '<<') throw new YamlError('merge keys are not supported', line);
  return { key, rest: (m[2] ?? '').trim() };
}

const isSeqItem = (text) => text === '-' || text.startsWith('- ');

// ---- block parser ----

class Parser {
  constructor(src) {
    this.lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
    this.i = 0;
  }

  // Next significant line (skipping blanks and comment-only lines), without consuming it.
  peek() {
    for (let i = this.i; i < this.lines.length; i++) {
      const raw = this.lines[i];
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const ws = /^[ \t]*/.exec(raw)[0];
      if (ws.includes('\t')) throw new YamlError('tabs are not allowed in indentation', i + 1);
      const text = stripComment(raw.slice(ws.length)).trimEnd();
      return { index: i, line: i + 1, indent: ws.length, text };
    }
    return null;
  }

  parseDocument() {
    let ln = this.peek();
    if (ln && ln.indent === 0 && ln.text.startsWith('%')) throw new YamlError('directives are not supported', ln.line);
    if (ln && ln.text === '---') { this.i = ln.index + 1; ln = this.peek(); }
    const value = ln ? this.parseBlock(0) : null;
    ln = this.peek();
    if (ln && ln.text === '...') { this.i = ln.index + 1; ln = this.peek(); }
    if (ln) {
      if (ln.text === '---' || ln.text.startsWith('--- ')) throw new YamlError('multiple documents are not supported', ln.line);
      throw new YamlError('unexpected content (check the indentation)', ln.line);
    }
    return value;
  }

  parseBlock(indent) {
    const ln = this.peek();
    if (!ln || ln.indent < indent) return null;
    if (isSeqItem(ln.text)) return this.parseSeq(ln.indent);
    if (matchKey(ln.text, ln.line)) return this.parseMap(ln.indent);
    // A scalar on its own line(s), e.g. "key:\n  value".
    this.i = ln.index + 1;
    return this.inlineValue(ln.text, ln.indent - 1, ln);
  }

  parseMap(indent) {
    const obj = withLines({});
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError('unexpected indentation', ln.line);
      if (ln.text === '---' || ln.text === '...') break;
      const m = matchKey(ln.text, ln.line);
      if (!m) throw new YamlError(isSeqItem(ln.text) ? 'sequence item where a key was expected' : 'expected "key: value"', ln.line);
      if (Object.prototype.hasOwnProperty.call(obj, m.key)) throw new YamlError(`duplicate key "${m.key}"`, ln.line);
      this.i = ln.index + 1;
      let value;
      if (m.rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) value = this.parseBlock(next.indent);
        else if (next && next.indent === indent && isSeqItem(next.text)) value = this.parseSeq(indent);
        else value = null;
      } else {
        value = this.inlineValue(m.rest, indent, ln);
      }
      setKey(obj, m.key, value, ln.line);
    }
    return obj;
  }

  parseSeq(indent) {
    const arr = withLines([]);
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError('unexpected indentation', ln.line);
      if (!isSeqItem(ln.text)) break;
      const after = ln.text.slice(1);
      const content = after.trimStart();
      let value;
      if (content === '') {
        this.i = ln.index + 1;
        const next = this.peek();
        value = next && next.indent > indent ? this.parseBlock(next.indent) : null;
      } else if (isSeqItem(content) || matchKey(content, ln.line)) {
        // Compact form: turn "- key: v" into "  key: v" and parse it as a nested node.
        const raw = this.lines[ln.index];
        this.lines[ln.index] = `${raw.slice(0, indent)} ${raw.slice(indent + 1)}`;
        value = this.parseBlock(indent + 1 + (after.length - content.length));
      } else {
        this.i = ln.index + 1;
        value = this.inlineValue(content, indent, ln);
      }
      arr[LINES].set(arr.length, ln.line);
      arr.push(value);
    }
    return arr;
  }

  // Value written after "key:" or "- " on the same line. parentIndent is the
  // indentation of the key or dash; continuation lines must be deeper.
  inlineValue(text, parentIndent, ln) {
    const c = text[0];
    if (c === '|' || c === '>') return this.blockScalar(text, parentIndent, ln);
    rejectSpecial(c, ln.line);
    if (c === '"' || c === "'" || c === '{' || c === '[') {
      const r = c === '"' ? parseDoubleQuoted(text, 0, ln.line)
        : c === "'" ? parseSingleQuoted(text, 0, ln.line)
          : c === '{' ? flowMap(text, 0, ln.line) : flowSeq(text, 0, ln.line);
      if (text.slice(r.end).trim() !== '') throw new YamlError('unexpected text after value', ln.line);
      return r.value;
    }
    // Plain scalar, possibly continued on deeper lines (folded with spaces).
    let value = text;
    let blank = 0;
    let j = this.i;
    for (; j < this.lines.length; j++) {
      const raw = this.lines[j];
      const trimmed = raw.trim();
      if (trimmed === '') { blank++; continue; }
      if (trimmed.startsWith('#') || leadingSpaces(raw) <= parentIndent) break;
      const part = stripComment(trimmed).trimEnd();
      value += blank > 0 ? '\n'.repeat(blank) + part : ` ${part}`;
      blank = 0;
      this.i = j + 1;
    }
    return value;
  }

  blockScalar(header, parentIndent, ln) {
    const m = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header.trim());
    if (!m || (m[2] && m[4])) throw new YamlError(`bad block scalar header "${header}"`, ln.line);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    let contentIndent = m[3] ? parentIndent + Number(m[3]) : -1;
    const body = [];
    let j = ln.index + 1;
    for (; j < this.lines.length; j++) {
      const raw = this.lines[j];
      if (raw.trim() === '') { body.push(''); continue; }
      const ind = leadingSpaces(raw);
      if (contentIndent < 0) {
        if (ind <= parentIndent) break;
        contentIndent = ind;
      }
      if (ind < contentIndent) break;
      body.push(raw.slice(contentIndent));
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    this.i = j - trailing;
    let text;
    if (!folded) text = body.join('\n');
    else {
      text = '';
      let prev = null;
      for (const l of body) {
        if (l === '') { text += '\n'; prev = 'empty'; } else if (/^\s/.test(l)) {
          text += (prev === 'text' || prev === 'more' ? '\n' : '') + l; prev = 'more';
        } else {
          text += (prev === 'text' ? ' ' : prev === 'more' ? '\n' : '') + l; prev = 'text';
        }
      }
    }
    if (body.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }
}

/** Parse one YAML document (workflow-file subset). Throws YamlError. */
export function parseYaml(src) {
  return new Parser(String(src)).parseDocument();
}
