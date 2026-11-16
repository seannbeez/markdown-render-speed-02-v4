// parse.js — dependency-free CommonMark/GFM parser, compatible with
// marked 18.1.3 default options (GFM on). Written from scratch for the
// markdown-render-speed-02 competition. parse(markdown) -> HTML string.

'use strict';

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

// ASCII punctuation (Unicode P/S categories for code < 128).
const PUNCT_ASCII = new Uint8Array(128);
for (const c of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") PUNCT_ASCII[c.charCodeAt(0)] = 1;

const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const RE_ALPHA_NUM = /[\p{L}\p{N}]/u;
const RE_NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;

function isPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? PUNCT_ASCII[c] === 1 : RE_PUNCT.test(ch);
}
// whitespace (JS \s) or punctuation (P/S).
function isPunctSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || PUNCT_ASCII[c] === 1;
  }
  return RE_PUNCT_SPACE.test(ch);
}
// not whitespace and not punctuation (P/S).
function isNotPunctSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return !(c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || PUNCT_ASCII[c] === 1);
  }
  return RE_NOT_PUNCT_SPACE.test(ch);
}
function isSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return /\s/.test(ch);
}
function isAlphaNum(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 128 && RE_ALPHA_NUM.test(ch));
}
// \w = [A-Za-z0-9_]
function isWordChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
// punctuation as used by marked's `punctuation` rule: punctSpace but NOT * or _.
function isPunctNoDelim(ch) {
  return ch !== '*' && ch !== '_' && isPunctSpace(ch);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const RE_NO_ENCODE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const RE_ENCODE = /[&<>"']/g;
// marked's unescape (numeric character references + bare &).
const RE_UNESCAPE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;

function escChar(ch) {
  switch (ch) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    case "'": return '&#39;';
    default: return ch;
  }
}

// Escape < > " ' and bare & (named entities left as-is). Used for text.
function escapeNoEncode(s) {
  return s.replace(RE_NO_ENCODE, escChar);
}
// Escape every & < > " '. Used for code spans / code blocks.
function escapeEncode(s) {
  return s.replace(RE_ENCODE, escChar);
}

// Decode numeric character references (&#65; &#x41;) and bare & -> &amp;.
// Named entities are left as-is. Out of range / surrogate -> U+FFFD.
function unescapeText(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(RE_UNESCAPE, (m, dec, hex) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
      return String.fromCodePoint(cp);
    }
    return '&amp;';
  });
}

// href encoding: encodeURI, then %25 -> % (literal % stays %).
function cleanUrl(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Normalize a link reference label: unescape \[ \], collapse whitespace,
// trim, lowercase.
function normalizeLabel(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // only \[, \] and \\ are unescaped in a label (other escapes like \! stay)
    if (ch === '\\' && i + 1 < s.length && (s[i + 1] === '[' || s[i + 1] === ']' || s[i + 1] === '\\')) {
      out += s[i + 1];
      i++;
    } else if (isSpace(ch)) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  // Unicode case folding: ß/ẞ fold to ss (toLowerCase alone gives ß)
  return out.replace(/ +/g, ' ').trim().toLowerCase().replace(/\u00df/g, 'ss').replace(/\u1e9e/g, 'ss');
}

// ---------------------------------------------------------------------------
// Mask (emStrongMask): hide delimiters inside links / code spans / html tags
// so the emStrong / del forward scans cannot see them. Same length as input.
// ---------------------------------------------------------------------------

// Is `ch` an ASCII punctuation char (for backslash escapes).
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && PUNCT_ASCII[c] === 1;
}

// Find the end of a backtick run starting at `i` (src[i] === '`').
function backtickRun(src, i) {
  let j = i;
  while (j < src.length && src[j] === '`') j++;
  return j - i;
}

// Match a code span starting at `i` (src[i] === '`').
// Returns { end, contentStart, contentEnd } or null.
function matchCodeSpan(src, i) {
  const n = src.length;
  const openLen = backtickRun(src, i);
  let j = i + openLen;
  // content must contain a non-backtick char
  while (j < n) {
    if (src[j] === '`') {
      const closeLen = backtickRun(src, j);
      if (closeLen === openLen) {
        // content = src[i+openLen .. j]; must have a non-backtick char
        let hasNonTick = false;
        for (let k = i + openLen; k < j; k++) {
          if (src[k] !== '`') { hasNonTick = true; break; }
        }
        if (hasNonTick && (j + closeLen >= n || src[j + closeLen] !== '`')) {
          return { end: j + closeLen, contentStart: i + openLen, contentEnd: j };
        }
        // a run of a different length: skip it
        j += closeLen;
        continue;
      }
      j += closeLen;
      continue;
    }
    j++;
  }
  return null;
}

// Match an html tag starting at `i` (src[i] === '<') for masking purposes:
// `<(?! )[^<>]*?>` — returns the end index (exclusive) or -1.
function matchHtmlTag(src, i) {
  const n = src.length;
  if (i + 1 >= n || src[i + 1] === ' ') return -1;
  let j = i + 1;
  while (j < n && src[j] !== '<' && src[j] !== '>') j++;
  if (j < n && src[j] === '>') return j + 1;
  return -1;
}

// Does the text starting at `i` look like `[...](...)` (link shape, valid or
// not)? If yes, return the end index (exclusive) of the whole shape.
// Label may contain code spans but not bare [ or ].
// Mask-shape match (marked's blockSkip regex): the label closes at the
// FIRST ] (no bracket balance), then (...). This is intentionally
// different from matchLinkShape: a nested link inside an outer label
// masks only up to its own ] so a delimiter after it stays visible to
// the emStrong scan (e.g. [foo *[bar [baz](/uri)](/uri)*](/uri)).
function matchLinkShapeMask(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      const cs = matchCodeSpan(src, j);
      if (cs) { j = cs.end; continue; }
      j++;
      continue;
    }
    if (ch === ']') break;
    j++;
  }
  if (j >= n || src[j] !== ']') return -1;
  j++;
  if (j >= n || src[j] !== '(') return -1;
  j++;
  let paren = 0;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '(') { paren++; j++; continue; }
    if (ch === ')') {
      if (paren === 0) return j + 1;
      paren--;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

function matchLinkShape(src, i) {
  const n = src.length;
  // label
  let j = i + 1;
  let depth = 0;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      const cs = matchCodeSpan(src, j);
      if (cs) { j = cs.end; continue; }
      j++;
      continue;
    }
    if (ch === '[') { depth++; j++; continue; }
    if (ch === ']') {
      if (depth === 0) break;
      depth--;
      j++;
      continue;
    }
    j++;
  }
  if (j >= n || src[j] !== ']') return -1;
  const closeBracket = j;
  j++;
  if (j >= n || src[j] !== '(') return -1;
  // destination: balanced parens, backslash escapes allowed, may contain spaces
  j++;
  let paren = 0;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '(') { paren++; j++; continue; }
    if (ch === ')') {
      if (paren === 0) return j + 1;
      paren--;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// marked's linkInText: does the label text contain a link (inline or ref)
// that is NOT an image, NOT inside a code span, NOT an autolink / bare url?
function linkInText(label, refs) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    const ch = label[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const cs = matchCodeSpan(label, i);
      if (cs) { i = cs.end; continue; }
      i++;
      continue;
    }
    if (ch === '<') {
      const t = matchHtmlTag(label, i);
      if (t > 0) { i = t; continue; }
      i++;
      continue;
    }
    if (ch === '[') {
      // inline link shape?
      const shape = matchLinkShape(label, i);
      if (shape > 0) return true;
      // full ref [text][label] ?
      let j = i + 1;
      let depth = 0;
      let closed = -1;
      while (j < n) {
        const c2 = label[j];
        if (c2 === '\\') { j += 2; continue; }
        if (c2 === '`') { const cs = matchCodeSpan(label, j); if (cs) { j = cs.end; continue; } j++; continue; }
        if (c2 === '[') { depth++; j++; continue; }
        if (c2 === ']') { if (depth === 0) { closed = j; break; } depth--; j++; continue; }
        j++;
      }
      if (closed > 0 && closed + 1 < n && label[closed + 1] === '[') {
        let k = closed + 2;
        while (k < n && label[k] !== ']') k++;
        if (k < n) {
          const lab = normalizeLabel(label.slice(closed + 2, k));
          if (refs.has(lab)) return true;
        }
      } else if (closed > 0) {
        // collapsed [] or shortcut
        if (closed + 2 < n && label[closed + 1] === '[' && label[closed + 2] === ']') {
          const lab = normalizeLabel(label.slice(i + 1, closed));
          if (refs.has(lab)) return true;
        } else {
          const lab = normalizeLabel(label.slice(i + 1, closed));
          if (refs.has(lab)) return true;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return false;
}

// reflinkSearch masking: mask defined reference links' labels.
function maskReflinks(src, refs) {
  const n = src.length;
  let out = '';
  let i = 0;
  let last = 0;
  while (i < n) {
    if (src[i] !== '[' && src[i] !== '!') { i++; continue; }
    const isImg = src[i] === '!';
    const start = i;
    if (isImg) i++;
    if (i >= n || src[i] !== '[') { i = start + 1; continue; }
    // find the closing ] of the label (no nesting except code spans)
    let j = i + 1;
    let depth = 0;
    let closed = -1;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') { const cs = matchCodeSpan(src, j); if (cs) { j = cs.end; continue; } j++; continue; }
      if (ch === '[') { depth++; j++; continue; }
      if (ch === ']') { if (depth === 0) { closed = j; break; } depth--; j++; continue; }
      j++;
    }
    if (closed < 0) { i = start + 1; continue; }
    const labelText = src.slice(i + 1, closed);
    // full ref: [label][ref]
    let refLabel = null;
    let matchEnd = closed + 1;
    let isFull = false;
    if (closed + 1 < n && src[closed + 1] === '[') {
      let k = closed + 2;
      while (k < n && src[k] !== ']' && src[k] !== '\n') k++;
      if (k < n && src[k] === ']') {
        refLabel = src.slice(closed + 2, k);
        matchEnd = k + 1;
        isFull = true;
      }
    }
    let key;
    let labelPart = labelText;
    if (isFull) {
      key = normalizeLabel(refLabel);
    } else if (closed + 2 < n && src[closed + 1] === '[' && src[closed + 2] === ']') {
      // collapsed
      key = normalizeLabel(labelText);
      matchEnd = closed + 3;
    } else {
      // shortcut
      key = normalizeLabel(labelText);
    }
    if (!refs.has(key)) { i = start + 1; continue; }
    // defined: mask it
    out += src.slice(last, start);
    const totalLen = matchEnd - start;
    if (isFull && !isImg && closed - i > 1 && linkInText(labelPart, refs)) {
      // label contains a link: mask the label part recursively, mask the ref part
      const maskedLabel = maskReflinks(labelPart, refs);
      const refLen = matchEnd - (closed + 1);
      out += '[' + maskedLabel + '][' + 'a'.repeat(Math.max(0, refLen - 2)) + ']';
    } else {
      out += '[' + 'a'.repeat(Math.max(0, totalLen - 2)) + ']';
    }
    last = matchEnd;
    i = matchEnd;
  }
  out += src.slice(last);
  return out;
}

// anyPunctuationOutsideCode masking: escapes -> '+', code span inner backticks -> '+'.
function maskPunctOutsideCode(src) {
  const n = src.length;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
      out += src.slice(last, i) + '++';
      last = i + 2;
      i += 2;
      continue;
    }
    if (ch === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) {
        // keep the backtick runs, replace inner backticks with '+'
        let inner = src.slice(cs.contentStart, cs.contentEnd).replace(/`/g, '+');
        out += src.slice(last, i) + src.slice(i, cs.contentStart) + inner + src.slice(cs.contentEnd, cs.end);
        last = cs.end;
        i = cs.end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  out += src.slice(last);
  return out;
}

// blockSkip masking: [...](...) shapes, code spans, <...> tags -> [aaa...].
function maskBlockSkip(src) {
  const n = src.length;
  let out = '';
  let last = 0;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '[') {
      const end = matchLinkShapeMask(src, i);
      if (end > 0) {
        out += src.slice(last, i) + '[' + 'a'.repeat(Math.max(0, end - i - 2)) + ']';
        last = end;
        i = end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const cs = matchCodeSpan(src, i);
      if (cs) {
        // keep one preceding char if it has not been consumed yet and is
        // not a backtick (marked keeps the char before the code span)
        let keep = 0;
        if (i > last && i > 0 && src[i - 1] !== '`') keep = 1;
        const start = i - keep;
        out += src.slice(last, start) + src.slice(start, i) + '[' + 'a'.repeat(Math.max(0, cs.end - i - 2)) + ']';
        last = cs.end;
        i = cs.end;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '<') {
      const end = matchHtmlTag(src, i);
      if (end > 0) {
        out += src.slice(last, i) + '[' + 'a'.repeat(Math.max(0, end - i - 2)) + ']';
        last = end;
        i = end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  out += src.slice(last);
  return out;
}

function computeMask(src, refs) {
  let t = src;
  if (refs.size > 0 && t.indexOf('[') >= 0) t = maskReflinks(t, refs);
  t = maskPunctOutsideCode(t);
  t = maskBlockSkip(t);
  return t;
}

// Last possible closer index for delimiter `delim` in the masked source:
// the last run whose preceding char is not whitespace (fe()).
function lastPossibleCloser(masked, delim) {
  const n = masked.length;
  let last = -1;
  for (let s = 0; s < n; s++) {
    if (masked[s] !== delim) continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last = s;
    }
    while (s + 1 < n && masked[s + 1] === delim) s++;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Find all candidate closing ] positions for a label starting at src[pos].
// Handles nested [ ] and skips code spans / escapes.
function labelEndCandidates(src, pos) {
  const n = src.length;
  const cands = [];
  let depth = 0;
  let j = pos + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      const cs = matchCodeSpan(src, j);
      if (cs) { j = cs.end; continue; }
      j++;
      continue;
    }
    if (ch === '[') { depth++; j++; continue; }
    if (ch === ']') {
      if (depth === 0) cands.push(j);
      else depth--;
      j++;
      continue;
    }
    j++;
  }
  return cands;
}

// Unescape backslash-escaped punctuation: \x -> x for ASCII punct.
function unescapePunct(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Parse a title starting at src[j] (after whitespace). Returns {title, end}
// or null. Title forms: "..." '...' (...), with backslash escapes.
function parseTitle(src, j) {
  const n = src.length;
  if (j >= n) return null;
  const q = src[j];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let k = j + 1;
  let title = '';
  while (k < n) {
    const ch = src[k];
    if (ch === '\\' && k + 1 < n) { title += src[k] + src[k + 1]; k += 2; continue; }
    if (ch === close) return { title: unescapePunct(title), end: k + 1 };
    title += ch;
    k++;
  }
  return null;
}

// Skip spaces/tabs/newlines, return the new index.
function skipSpaceNL(src, j) {
  const n = src.length;
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
  return j;
}

// Parse the (dest title) part of an inline link, starting at the '('.
// Returns {dest, title, end} (end = index just after the closing ')') or null.
function parseLinkParens(src, openParen) {
  const n = src.length;
  let j = skipSpaceNL(src, openParen + 1);
  if (j >= n) return null;
  let dest = '';
  let title = '';
  if (src[j] === '<') {
    // angle destination: <...> (no newline, no unescaped < > inside)
    let k = j + 1;
    let d = '';
    let ok = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '\n') return null;
      if (ch === '\\' && k + 1 < n) { d += src[k] + src[k + 1]; k += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<') return null;
      d += ch;
      k++;
    }
    if (!ok) return null;
    dest = d;
    j = k + 1;
  } else if (src[j] === ')') {
    dest = '';
  } else {
    // bare destination: run of non-space chars, balanced parens
    let k = j;
    let depth = 0;
    let d = '';
    while (k < n) {
      const ch = src[k];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && k + 1 < n) { d += src[k] + src[k + 1]; k += 2; continue; }
      if (ch === '(') { depth++; d += ch; k++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        d += ch;
        k++;
        continue;
      }
      d += ch;
      k++;
    }
    if (depth > 0) return null; // unclosed paren in dest
    dest = d;
    j = k;
  }
  // optional title
  let afterDest = j;
  let k2 = j;
  let hasWS = false;
  while (k2 < n && (src[k2] === ' ' || src[k2] === '\t')) { hasWS = true; k2++; }
  if (k2 < n && src[k2] === '\n') {
    hasWS = true;
    k2++;
    while (k2 < n && (src[k2] === ' ' || src[k2] === '\t')) k2++;
  }
  if (hasWS && k2 < n && (src[k2] === '"' || src[k2] === "'" || src[k2] === '(')) {
    const t = parseTitle(src, k2);
    if (t) {
      title = t.title;
      afterDest = t.end;
    } else {
      return null; // looks like a title but malformed -> reject the link
    }
  }
  // skip trailing whitespace/newlines, expect ')'
  let k3 = skipSpaceNL(src, afterDest);
  if (k3 >= n || src[k3] !== ')') return null;
  return { dest, title, end: k3 + 1 };
}

// Be(): does the label contain an html tag / autolink that extends past the
// label's end? `src` is the full remaining source, `labelStart` the index of
// the label text inside src, `label` the label text.
function tagExtendsPastLabel(src, labelStart, label) {
  if (label.indexOf('<') < 0) return false;
  const n = label.length;
  for (let s = 0; s < n; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const cs = matchCodeSpan(label, s);
      if (cs) { s = cs.end - 1; continue; }
      continue;
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelStart + s);
    const tag = matchInlineTag(rest);
    const m = tag !== null ? { raw: tag } : matchAutolink(rest);
    if (m) {
      if (m.raw.length > n - s) return true;
      s += m.raw.length - 1;
    }
  }
  return false;
}

// Match an inline html tag at the start of `s`. Returns the matched text or null.
function matchInlineTag(s) {
  // comments, processing instructions, declarations, CDATA
  let m = /^(?:<!--(?:>|->|-->|[\s\S]*?-->)|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/.exec(s);
  if (m) return m[0];
  // open/close tag, parsed strictly per CommonMark:
  //   <name (ws attr)* ws? /? >   (close: </name ws? > -- no attributes)
  if (s[0] !== '<') return null;
  let i = 1;
  let closing = false;
  if (s[i] === '/') { closing = true; i++; }
  if (i >= s.length || !isAsciiLetter(s[i])) return null;
  while (i < s.length && (isAsciiLetter(s[i]) || isDigit(s[i]) || s[i] === '-')) i++;
  // after the tag name there must be whitespace, '>' or '/'
  if (closing) {
    // closing tag: only optional whitespace, then '>'
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
    if (i < s.length && s[i] === '>') return s.slice(0, i + 1);
    return null;
  }
  // open tag: attributes
  for (;;) {
    // skip whitespace (incl. newlines)
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
    if (j >= s.length) return null;
    if (s[j] === '>') return s.slice(0, j + 1);
    if (s[j] === '/') {
      if (j + 1 < s.length && s[j + 1] === '>') return s.slice(0, j + 2);
      return null;
    }
    // an attribute must be preceded by whitespace
    if (j === i) return null;
    i = j;
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!(isAsciiLetter(s[i]) || s[i] === '_' || s[i] === ':')) return null;
    i++;
    while (i < s.length && (isAsciiLetter(s[i]) || isDigit(s[i]) || s[i] === '_' || s[i] === ':' || s[i] === '.' || s[i] === '-')) i++;
    // optional whitespace, optional = value
    let k = i;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if (k < s.length && s[k] === '=') {
      k++;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (k >= s.length) return null;
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k];
        k++;
        while (k < s.length && s[k] !== q) k++;
        if (k >= s.length) return null; // unclosed quote
        k++;
      } else {
        // unquoted value: no whitespace, ", ', =, <, >, `
        if (s[k] === '"' || s[k] === "'" || s[k] === '=' || s[k] === '<' || s[k] === '>' || s[k] === '`') return null;
        while (k < s.length && !isSpace(s[k]) && s[k] !== '"' && s[k] !== "'" && s[k] !== '=' && s[k] !== '<' && s[k] !== '>' && s[k] !== '`') k++;
        if (k === i) return null;
      }
      i = k;
    }
    // no '=': valueless attribute; i stays at the end of the name so the
    // next iteration's whitespace skip still sees the separating space
  }
}

function isAsciiLetter(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

// Match an autolink <scheme:...> or <email> at the start of `s`.
// Returns {raw, text, href} or null.
function matchAutolink(s) {
  const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/.exec(s);
  if (m) return { raw: m[0], text: m[1], href: m[1] };
  const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/.exec(s);
  if (em) return { raw: em[0], text: em[1], href: 'mailto:' + em[1] };
  return null;
}

// Match a bare URL / www. / email at the start of `s` (GFM url rule).
// Returns {raw, text, href} or null. Applies the backpedal trim.
function matchUrl(s) {
  const m = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[A-Za-z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/.exec(s);
  if (!m) return null;
  let raw = m[0];
  let href;
  if (m[2] === '@') {
    href = 'mailto:' + raw;
    return { raw, text: raw, href };
  }
  // backpedal: repeatedly trim trailing punctuation
  const backpedal = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
  let prev;
  do {
    prev = raw;
    const b = backpedal.exec(raw);
    raw = b ? b[0] : '';
  } while (raw !== prev);
  if (m[1] === 'www.') href = 'http://' + raw;
  else href = raw;
  return { raw, text: raw, href };
}

// Escape token: \ + ASCII punct.
function matchEscape(src, i) {
  if (src[i] !== '\\') return null;
  const next = src[i + 1];
  if (next === undefined) return null;
  if (isAsciiPunct(next)) return { raw: '\\' + next, text: next };
  return null;
}

// Code span token starting at src[i] === '`'. Returns {raw, text} or null.
function matchCodeSpanToken(src, i) {
  const cs = matchCodeSpan(src, i);
  if (!cs) return null;
  let text = src.slice(cs.contentStart, cs.contentEnd).replace(/\n/g, ' ');
  if (text.length > 0 && text[0] === ' ' && text[text.length - 1] === ' ' && /[^ ]/.test(text)) {
    text = text.slice(1, -1);
  }
  return { raw: src.slice(i, cs.end), text };
}

// Hard break: 2+ spaces + newline, or backslash + newline, when a non-blank
// line follows.
function matchBr(src, i) {
  if (src[i] === '\\' && src[i + 1] === '\n') {
    let j = i + 2;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j < src.length && src[j] !== '\n') return { raw: '\\\n', len: 2 };
    return null;
  }
  if (src[i] === ' ') {
    let j = i;
    while (j < src.length && src[j] === ' ') j++;
    if (j - i >= 2 && j < src.length && src[j] === '\n') {
      let k = j + 1;
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < src.length && src[k] !== '\n') return { raw: src.slice(i, j + 1), len: j + 1 - i };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// emStrong / del forward scans (run on the MASKED source)
// ---------------------------------------------------------------------------

// Classify a delimiter run in the masked source by its flanking.
// Returns 1..6 (RDelim groups), or 0 when no group matches.
//   1: prev punct, next space/end            (closer-only)
//   2: prev notPunctSpace, next punctSpace/end (closer-only)
//   3: prev punctSpace, next notPunctSpace    (opener-only)
//   4: prev whitespace, next punct           (opener-only)
//   5: prev punct, next punct                (both)
//   6: prev notPunctSpace, next notPunctSpace (both)
function rdelimGroup(masked, runStart, runEnd) {
  const prev = runStart === 0 ? '' : masked[runStart - 1];
  const next = runEnd >= masked.length ? '' : masked[runEnd];
  if (prev === '') return 0; // no preceding char in the string
  const prevPunct = isPunct(prev);
  const prevNotPS = isNotPunctSpace(prev);
  const prevPS = isPunctSpace(prev);
  const prevSpace = isSpace(prev);
  const nextSpace = next === '' || isSpace(next);
  const nextPS = next === '' || isPunctSpace(next);
  const nextNotPS = next !== '' && isNotPunctSpace(next);
  const nextPunct = next !== '' && isPunct(next);
  if (prevPunct && nextSpace) return 1;
  if (prevNotPS && nextPS) return 2;
  if (prevPS && nextNotPS) return 3;
  if (prevSpace && nextPunct) return 4;
  if (prevPunct && nextPunct) return 5;
  if (prevNotPS && nextNotPS) return 6;
  return 0;
}

// Length of the first code point of `s` in UTF-16 code units (1 or 2).
function firstCodePointLen(s) {
  const c = s.charCodeAt(0);
  return c >= 0xD800 && c <= 0xDBFF && s.length > 1 ? 2 : 1;
}

// Match the LDelim at src[pos] (src[pos] is * or _).
// Returns {len, group, after} or null. group: 1/2 for *, 3/4 for _
// (1/3 = following char is punct, 2/4 = following char is non-punct non-space).
function matchLDelim(src, pos) {
  const r = src[pos];
  const n = src.length;
  let j = pos;
  while (j < n && src[j] === r) j++;
  const len = j - pos;
  if (j >= n) return null;
  const after = src[j];
  if (after === r) return null;
  if (isSpace(after)) return null;
  const group = isPunct(after) ? (r === '*' ? 1 : 3) : (r === '*' ? 2 : 4);
  return { len, group, after };
}

// The RDelim skip alternative, checked once at the scan start:
// for '*': [^_*]*? __ [^_*]*? * [^_*]*? (?=__)   (skips a * inside __...__)
// for '_': [^_*]*? ** [^_*]*? _ [^_*]*? (?=**)
// Returns the index just before the closing __ / ** (i.e. where scanning
// resumes), or -1 when the pattern does not match.
function rdelimSkip(masked, from, delim) {
  const n = masked.length;
  const open = delim === '*' ? '__' : '**';
  const close = open;
  let i = from;
  // [^_*]*?
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i + 1 >= n || masked[i] !== open[0] || masked[i + 1] !== open[1]) return -1;
  i += 2;
  // [^_*]*? then the delimiter char
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i >= n || masked[i] !== delim) return -1;
  i++;
  // [^_*]*? then (?=close)
  while (i < n && masked[i] !== '*' && masked[i] !== '_') i++;
  if (i + 1 < n && masked[i] === close[0] && masked[i + 1] === close[1]) return i;
  return -1;
}

// emStrong forward scan. `orig` is the original source, `masked` the masked
// source (same length). `pos` is the opener position, `ld` the LDelim match,
// `prevChar` the prevChar passed by the main loop.
// Returns {type:'em'|'strong', raw, inner} or null.
function emStrongScan(orig, masked, pos, ld, prevChar) {
  const r = orig[pos];
  const n0 = masked.length;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = l === 0 ? '' : masked[l - 1];
  const h = p !== '' && isPunctSpace(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : (n !== '' && isPunctNoDelim(n));
  // _ intra-word check: group 4 (following char is non-punct non-space)
  // and prevChar is alphanumeric -> no emphasis.
  if (ld.group === 4 && n !== '' && isAlphaNum(n)) return null;
  const d = (ld.group === 1 || ld.group === 3) ? ld.after : '';
  if (!(d === '' || n === '' || u)) return null; // cannot open
  const k = ld.len;
  const y = i - l + k;
  const R = p !== '' && p.trim() !== '' && (d !== '' || (r === '*' && !h));
  const o = n === r;
  const v = lastPossibleCloser(masked, r);
  const Q = i + k;
  if (v < Q) return null;
  const ee = v - Q; // max index in the sliced string
  // scan the masked source from Q
  // m starts at the opener length k; a closer run subtracts from it.
  // A normal match is found when m <= 0. If the scan runs out of closers
  // while m > 0, fall back to the LAST closer found (min(k, b) delimiters)
  // -- but only when no opener run was seen in between (an intervening
  // opener means the first delimiter is literal, e.g. **foo **bar baz**)
  let m = k;
  let f = 0;
  let scan = Q;
  let lastSIdx = -1;
  let lastB = 0;
  let sawOpener = false;
  // one-shot skip at the scan start
  const sk = rdelimSkip(masked, Q, r);
  if (sk >= 0) scan = sk;
  while (scan <= Q + ee) {
    // find the next run of r
    let runStart = -1;
    let s2 = scan;
    while (s2 < n0) {
      if (masked[s2] === r) { runStart = s2; break; }
      s2++;
    }
    if (runStart < 0) break;
    if (runStart > Q + ee) break;
    // a run at the very start of the slice cannot be a closer (no preceding
    // char inside the slice)
    if (runStart === Q) {
      let e2 = runStart;
      while (e2 < n0 && masked[e2] === r) e2++;
      scan = e2;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < n0 && masked[runEnd] === r) runEnd++;
    const g = rdelimGroup(masked, runStart, runEnd);
    if (g === 0) { scan = runEnd; continue; }
    // for '_', a run between two alphanumeric chars is neither an opener
    // nor a closer (intra-word rule)
    if (r === '_' && g === 6) {
      const pc = masked[runStart - 1];
      const nc = runEnd < n0 ? masked[runEnd] : '';
      if (isAlphaNum(pc) && isAlphaNum(nc)) { scan = runEnd; continue; }
    }
    const b = runEnd - runStart;
    const sIdx = runStart - Q; // index of the run in the slice
    if (g === 3 || g === 4) { m += b; sawOpener = true; scan = runEnd; continue; }
    if (g === 5 || g === 6 || R) {
      if (o && (g === 5 || g === 6)) return null; // o-break
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; scan = runEnd; continue; } // rule of 3
    }
    // record this closer as the last candidate
    lastSIdx = sIdx;
    lastB = b;
    m -= b;
    if (m > 0) { scan = runEnd; continue; }
    // normal match: em uses the FIRST `use` opener delimiters (lead = 0)
    // rawEnd uses bUsed (closers consumed, incl. for nested openers)
    const bUsed = Math.min(b, b + m + f);
    const use = Math.min(k, bUsed) % 2 === 1 ? 1 : 2;
    const rawEnd = pos + k + sIdx + bUsed;
    const raw = orig.slice(pos, rawEnd);
    if (Math.min(k, bUsed) % 2 === 1) {
      return { type: 'em', raw, inner: raw.slice(1, -1), lead: 0 };
    }
    return { type: 'strong', raw, inner: raw.slice(2, -2), lead: 0 };
  }
  // fallback: use the last closer found; the em uses the LAST `use`
  // opener delimiters, earlier ones are literal text before it (lead).
  // Only when no opener run was seen (else the opener is literal).
  if (lastSIdx >= 0 && !sawOpener) {
    const bUsed = Math.min(k, lastB);
    const use = bUsed % 2 === 1 ? 1 : 2;
    const lead = k - use;
    const rawEnd = pos + k + lastSIdx + bUsed;
    const raw = orig.slice(pos + lead, rawEnd);
    if (bUsed % 2 === 1) {
      return { type: 'em', raw, inner: raw.slice(1, -1), lead };
    }
    return { type: 'strong', raw, inner: raw.slice(2, -2), lead };
  }
  return null;
}

// del LDelim: ^~~? followed by punct (group 1) or non-space non-~ char.
function matchDelLDelim(src, pos) {
  const n = src.length;
  let j = pos;
  while (j < n && src[j] === '~' && j - pos < 2) j++;
  const len = j - pos;
  if (len === 0) return null;
  if (j >= n) return null;
  const after = src[j];
  if (after === '~') return null;
  if (isSpace(after)) return null;
  const group = isPunct(after) ? 1 : 2;
  return { len, group, after };
}

// del forward scan. Returns {type:'del', raw, inner} or null.
function delScan(orig, masked, pos, ld, prevChar) {
  const d = ld.group === 1 ? ld.after : '';
  const n = prevChar;
  if (!(d === '' || n === '' || (n !== '' && isPunctNoDelim(n)))) return null;
  const o = ld.len;
  const v = lastPossibleDelCloser(masked);
  const Q = pos + o;
  if (v < Q) return null;
  const ee = v - Q;
  const n0 = masked.length;
  let p = o;
  let scan = Q;
  while (scan <= Q + ee) {
    let runStart = -1;
    let s2 = scan;
    while (s2 < n0) {
      if (masked[s2] === '~') { runStart = s2; break; }
      s2++;
    }
    if (runStart < 0) break;
    if (runStart > Q + ee) break;
    if (runStart === Q) {
      let e2 = runStart;
      while (e2 < n0 && masked[e2] === '~') e2++;
      scan = e2;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < n0 && masked[runEnd] === '~') runEnd++;
    const g = rdelimGroup(masked, runStart, runEnd);
    if (g === 0) { scan = runEnd; continue; }
    const l = runEnd - runStart;
    if (l !== o) { scan = runEnd; continue; }
    const sIdx = runStart - Q;
    const te = firstCodePointLen(masked.slice(runStart - 1, runStart));
    if (g === 3 || g === 4) { p += l; scan = runEnd; continue; }
    p -= l;
    if (p > 0) { scan = runEnd; continue; }
    const lUsed = Math.min(l, l + p);
    const rawEnd = pos + o + sIdx + lUsed;
    const raw = orig.slice(pos, rawEnd);
    return { type: 'del', raw, inner: raw.slice(o, -o) };
  }
  return null;
}

// Last possible del closer index: the last ~ run whose preceding char is not
// whitespace.
function lastPossibleDelCloser(masked) {
  const n = masked.length;
  let last = -1;
  for (let s = 0; s < n; s++) {
    if (masked[s] !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      last = s;
    }
    while (s + 1 < n && masked[s + 1] === '~') s++;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Inline main loop
// ---------------------------------------------------------------------------

// Shared inline state (saved/restored around link labels).
// { inLink, inRawBlock, linkEmitted }

function newInlineState() {
  return { inLink: false, inRawBlock: false, linkEmitted: false };
}

// Parse a label's inline content and build a link/image.
// Returns the HTML string, or null when the outer link must be rejected
// (a link was emitted inside the label and this is not an image).
// `labelText` is the raw label source, `href`/`title` the (unescaped) values.
function buildLink(isImage, labelText, href, title, refs, state) {
  const savedInLink = state.inLink;
  const savedLinkEmitted = state.linkEmitted;
  const savedRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const labelHtml = inlineParse(labelText, refs, state);
  const innerLinkEmitted = state.linkEmitted;
  state.linkEmitted = savedLinkEmitted;
  state.inLink = savedInLink;
  state.inRawBlock = savedRawBlock;
  if (!isImage) {
    if (innerLinkEmitted) return null;
    state.linkEmitted = true;
  }
  const cleanHref = cleanUrl(href);
  if (isImage) {
    const alt = altText(labelText, refs);
    if (cleanHref === null) return escapeNoEncode(alt);
    let img = '<img src="' + escapeNoEncode(cleanHref) + '" alt="' + escapeNoEncode(alt) + '"';
    if (title) img += ' title="' + escapeNoEncode(unescapePunct(title)) + '"';
    return img + '>';
  }
  if (cleanHref === null) return labelHtml;
  let a = '<a href="' + escapeNoEncode(cleanHref) + '"';
  if (title) a += ' title="' + escapeNoEncode(unescapePunct(title)) + '"';
  return a + '>' + labelHtml + '</a>';
}

// Plain-text rendering of a label (for image alt text).
function altText(label, refs) {
  return inlineParseText(label, refs);
}

// Text-mode inline parse: returns the plain text content of `src`.
function inlineParseText(src, refs) {
  const n = src.length;
  if (n === 0) return '';
  const state = newInlineState();
  const out = [];
  let i = 0;
  while (i < n) {
    const ch = src[i];
    // escape
    if (ch === '\\') {
      const esc = matchEscape(src, i);
      if (esc) { out.push(esc.text); i += 2; continue; }
    }
    // html tag -> raw
    if (ch === '<') {
      const itag = matchInlineTag(src.slice(i));
      const tag = itag !== null ? { raw: itag } : matchAutolink(src.slice(i));
      if (tag) { out.push(tag.raw); i += tag.raw.length; continue; }
    }
    // link / image
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const res = tryLink(src, i, refs, state, true);
      if (res) {
        out.push(res.text);
        i = res.end;
        continue;
      }
      const ref = tryReflink(src, i, refs, state, true);
      if (ref) {
        if (ref.text !== null) out.push(ref.text);
        i = ref.end;
        continue;
      }
    }
    // em / strong / del
    if (ch === '*' || ch === '_') {
      const ld = matchLDelim(src, i);
      if (ld) {
        const hasDelim = true;
        const masked = hasDelim ? computeMask(src, refs) : src;
        const em = emStrongScan(src, masked, i, ld, '');
        if (em) {
          if (em.lead > 0) out.push(ch.repeat(em.lead));
          out.push(inlineParseText(em.inner, refs)); i += em.lead + em.raw.length; continue;
        }
      }
    }
    if (ch === '~') {
      const ld = matchDelLDelim(src, i);
      if (ld) {
        const masked = computeMask(src, refs);
        const d = delScan(src, masked, i, ld, '');
        if (d) { out.push(inlineParseText(d.inner, refs)); i += d.raw.length; continue; }
      }
    }
    // code span
    if (ch === '`') {
      const cs = matchCodeSpanToken(src, i);
      if (cs) { out.push(cs.text); i += cs.raw.length; continue; }
      const runLen = backtickRun(src, i);
      out.push('`'.repeat(runLen));
      i += runLen;
      continue;
    }
    // br -> nothing
    if (ch === '\\' || ch === ' ') {
      const br = matchBr(src, i);
      if (br) { i += br.len; continue; }
    }
    // autolink / url
    if (ch === '<') {
      const al = matchAutolink(src.slice(i));
      if (al) { out.push(al.text); i += al.raw.length; continue; }
    }
    if (!state.inLink) {
      const u = matchUrl(src.slice(i));
      if (u) { out.push(u.text); i += u.raw.length; continue; }
    }
    // text: consume one char (or a run up to the next special char)
    const end = scanTextEnd(src, i, false);
    out.push(unescapeText(src.slice(i, end)));
    i = end;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Line cursor with column tracking and partially-consumed tabs.
// { str, pos, col, partial }
// - pos: index into str (the char after a partially-consumed tab, if any)
// - col: the column at pos
// - partial: remaining columns of a partially-consumed tab (0 if none)
function makeCursor(str) {
  return { str, pos: 0, col: 0, partial: 0 };
}
function curPeek(cur) {
  if (cur.partial > 0) return ' ';
  return cur.pos < cur.str.length ? cur.str[cur.pos] : '';
}
function curRest(cur) {
  if (cur.partial > 0) return ' '.repeat(cur.partial) + cur.str.slice(cur.pos);
  return cur.str.slice(cur.pos);
}
// Advance `n` columns. Returns false when the text runs out first.
function curAdvance(cur, n) {
  while (n > 0) {
    if (cur.partial > 0) {
      if (n <= cur.partial) { cur.partial -= n; cur.col += n; return true; }
      n -= cur.partial;
      cur.col += cur.partial;
      cur.partial = 0;
      continue;
    }
    if (cur.pos >= cur.str.length) return false;
    const ch = cur.str[cur.pos];
    if (ch === ' ') { cur.pos++; cur.col++; n--; continue; }
    if (ch === '\t') {
      const w = 4 - (cur.col % 4);
      if (n < w) { cur.partial = w - n; cur.col += n; cur.pos++; return true; }
      cur.pos++;
      cur.col += w;
      n -= w;
      continue;
    }
    return false;
  }
  return true;
}
// Number of columns of leading whitespace from the cursor (not advancing).
function curIndentCols(cur) {
  let col = cur.col;
  let p = cur.pos;
  let partial = cur.partial;
  let cols = 0;
  if (partial > 0) { cols += partial; col += partial; p = cur.pos; }
  while (p < cur.str.length) {
    const ch = cur.str[p];
    if (ch === ' ') { cols++; col++; p++; continue; }
    if (ch === '\t') { const w = 4 - (col % 4); cols += w; col += w; p++; continue; }
    break;
  }
  return cols;
}
// Is the rest of the line blank (only spaces/tabs)?
function curIsBlank(cur) {
  if (cur.partial > 0) return cur.str.slice(cur.pos).replace(/[ \t]/g, '') === '';
  return /^[ \t]*$/.test(cur.str.slice(cur.pos));
}
function isBlankLine(str) {
  return /^[ \t]*$/.test(str);
}

// Match a blockquote marker: up to 3 spaces of indent, then '>', then an
// optional single space (a tab counts as spaces; 1 column is consumed).
// Advances the cursor. Returns true/false.
function matchBQ(cur) {
  const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
  // up to 3 columns of indent
  let ind = 0;
  while (ind < 3) {
    const ch = curPeek(cur);
    if (ch === ' ') { curAdvance(cur, 1); ind++; continue; }
    if (ch === '\t') {
      // a tab that fits within 3 columns
      const w = cur.partial > 0 ? cur.partial : 4 - (cur.col % 4);
      if (ind + w <= 3) { curAdvance(cur, w); ind += w; continue; }
      break;
    }
    break;
  }
  if (curPeek(cur) !== '>') {
    cur.pos = save.pos; cur.col = save.col; cur.partial = save.partial;
    return false;
  }
  cur.pos++;
  cur.col++; // consume '>': 1 column, not whitespace
  // optional single space (1 column, may come out of a tab)
  const ch = curPeek(cur);
  if (ch === ' ' || ch === '\t') curAdvance(cur, 1);
  return true;
}

// Block-level tag names (HTML block type 6).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Detect an HTML block start at the cursor. Returns null or
// {type:1..7, endTest} where endTest(line) decides whether a later line ends it.
function detectHtmlBlock(cur) {
  const rest = curRest(cur);
  // up to 3 spaces of indent
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  if (i >= rest.length || rest[i] !== '<') return null;
  const s = rest.slice(i);
  const lower = s.toLowerCase();
  // type 1: pre, script, style, textarea
  const m1 = /^<\/?(pre|script|style|textarea)(?=[\s>\/]|$)/.exec(lower);
  if (m1) {
    const tag = m1[1];
    const isClose = s[1] === '/';
    return { type: 1, closeTag: tag, isClose };
  }
  // type 2: comment
  if (lower.startsWith('<!--')) return { type: 2, endMarker: '-->' };
  // type 3: processing instruction
  if (lower.startsWith('<?')) return { type: 3, endMarker: '?>' };
  // type 4: declaration <!A-Z
  if (/^<![A-Za-z]/.test(s)) return { type: 4, endMarker: '>' };
  // type 5: CDATA
  if (lower.startsWith('<![cdata[')) return { type: 5, endMarker: ']]>' };
  // type 6: block-level tag
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)[\s>\/]/.exec(s) || /^<\/?([A-Za-z][A-Za-z0-9-]*)$/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return { type: 6 };
  // type 7: a complete open or close tag alone on the line (validated by
  // the same strict tag parser as inline tags).
  const tag7 = matchInlineTag(s);
  if (tag7 !== null && /^[ \t]*$/.test(s.slice(tag7.length))) return { type: 7 };
  return null;
}

// Does a line (after container prefixes) start a fenced code block?
// Returns {char, len, info, indent} or null.
function detectFence(cur) {
  const rest = curRest(cur);
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  if (i >= rest.length) return null;
  const ch = rest[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < rest.length && rest[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  let info = rest.slice(j);
  // info string: up to the first space/tab; for backtick fences the WHOLE
  // info string must not contain a backtick (checked before truncating)
  const m = /^[ \t]*/.exec(info);
  info = info.slice(m[0].length);
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  const sp = info.search(/[ \t]/);
  if (sp >= 0) info = info.slice(0, sp);
  return { char: ch, len, info, indent: i };
}

// Is the line (after container prefixes) a closing fence for `fence`
// (a fenced code node with fenceChar/fenceLen)?
function isClosingFence(cur, fence) {
  const rest = curRest(cur);
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  if (i >= rest.length || rest[i] !== fence.fenceChar) return false;
  let j = i;
  while (j < rest.length && rest[j] === fence.fenceChar) j++;
  if (j - i < fence.fenceLen) return false;
  return /^[ \t]*$/.test(rest.slice(j));
}

// ATX heading: 1-6 # + space/tab/end. Returns {level, text} or null.
function detectATX(cur) {
  const rest = curRest(cur);
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  if (i >= rest.length || rest[i] !== '#') return null;
  let j = i;
  while (j < rest.length && rest[j] === '#') j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < rest.length && rest[j] !== ' ' && rest[j] !== '\t') return null;
  let text = rest.slice(j);
  // strip closing hashes (preceded by a space) BEFORE stripping leading
  // spaces, so '### ###' yields an empty heading
  const cm = /[ \t]+#+[ \t]*$/.exec(text);
  if (cm) text = text.slice(0, cm.index);
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, text };
}

// Thematic break: 3+ of -, _, * with optional spaces, nothing else.
function detectHr(cur) {
  const rest = curRest(cur);
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  const s = rest.slice(i);
  return /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/.test(s);
}

// Setext underline: === or --- (up to 3 spaces indent, trailing spaces ok).
function detectSetext(cur) {
  const rest = curRest(cur);
  let i = 0;
  while (i < rest.length && rest[i] === ' ' && i < 3) i++;
  const s = rest.slice(i);
  if (/^=+[ \t]*$/.test(s)) return 1;
  if (/^-+[ \t]*$/.test(s)) return 2;
  return 0;
}

// List marker at the cursor. On success it ADVANCES the cursor to the item
// content and returns {ordered, bullet, delim, start, len, contentIndent,
// empty}. On failure it restores the cursor and returns null.
// contentIndent is the total columns from the line start (cursor position
// before the call) to the content.
function matchListMarker(cur) {
  const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
  const restore = () => { cur.pos = save.pos; cur.col = save.col; cur.partial = save.partial; };
  // indent: up to 3 spaces
  let ind = 0;
  while (ind < 3 && curPeek(cur) === ' ') { curAdvance(cur, 1); ind++; }
  const ch = curPeek(cur);
  let markerLen = 0;
  let ordered = false;
  let delim = '';
  let start = 0;
  if (ch === '*' || ch === '+' || ch === '-') {
    markerLen = 1;
    delim = ch;
    cur.pos++;
    cur.col++; // marker char: 1 column, not whitespace
  } else if (ch >= '0' && ch <= '9') {
    let digits = 0;
    const dstart = cur.pos;
    while (digits < 9 && cur.pos < cur.str.length && cur.str[cur.pos] >= '0' && cur.str[cur.pos] <= '9') {
      digits++;
      cur.pos++;
      cur.col++;
    }
    if (digits === 0 || digits > 9) { restore(); return null; }
    const d = curPeek(cur);
    if (d !== '.' && d !== ')') { restore(); return null; }
    markerLen = digits + 1;
    ordered = true;
    delim = d;
    start = parseInt(cur.str.slice(dstart, cur.pos), 10);
    cur.pos++;
    cur.col++; // delimiter char: 1 column, not whitespace
  } else {
    restore();
    return null;
  }
  // after the marker: whitespace or end of line
  if (cur.pos >= cur.str.length && cur.partial === 0) {
    return { ordered, bullet: ch, delim, start, len: markerLen, contentIndent: ind + markerLen + 1, empty: true };
  }
  // count whitespace columns after the marker
  const wsStart = { pos: cur.pos, col: cur.col, partial: cur.partial };
  let wsCols = 0;
  while (curPeek(cur) === ' ' || curPeek(cur) === '\t') {
    const before = cur.col;
    curAdvance(cur, 1);
    wsCols += cur.col - before;
  }
  if (wsCols === 0) { restore(); return null; }
  // if the line ends after the marker + whitespace, the item is empty and
  // its content indent is the marker width + 1 (trailing spaces do not
  // count)
  if (cur.pos >= cur.str.length && cur.partial === 0) {
    return { ordered, bullet: ch, delim, start, len: markerLen, contentIndent: ind + markerLen + 1, empty: true };
  }
  const contentIndent = ind + markerLen + (wsCols >= 5 ? 1 : wsCols);
  if (wsCols >= 5) {
    // only 1 column is consumed after the marker
    cur.pos = wsStart.pos;
    cur.col = wsStart.col;
    cur.partial = wsStart.partial;
    curAdvance(cur, 1);
  }
  return { ordered, bullet: ch, delim, start, len: markerLen, contentIndent, empty: false };
}

// Peek for a list marker without moving the cursor.
function peekListMarker(cur) {
  const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
  const m = matchListMarker(cur);
  cur.pos = save.pos;
  cur.col = save.col;
  cur.partial = save.partial;
  return m;
}

// Table delimiter row: cells of :?-+:? separated by |.
// Marked requires the delimiter row to contain ':' or '|' (tableDelimiter).
function parseTableDelimiter(s) {
  if (!/[:|]/.test(s)) return null;
  let t = s.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  const cells = t.split('|');
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    const cell = c.trim();
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] === ':' && m[2] === ':') aligns.push('center');
    else if (m[1] === ':') aligns.push('left');
    else if (m[2] === ':') aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// Split a table row into cells (split on unescaped |).
function splitTableRow(s) {
  let t = s.replace(/^[ \t]{0,3}/, '');
  // strip one leading / trailing pipe (with surrounding spaces)
  let start = 0;
  if (t.startsWith('|')) start = 1;
  let end = t.length;
  if (end > start && t[end - 1] === '|') end--;
  const cells = [];
  let cur = '';
  let i = start;
  while (i < end) {
    const ch = t[i];
    if (ch === '\\' && i + 1 < end) {
      // \| is an escaped pipe: it becomes a literal | in the cell content
      // (before inline parsing, so it is | even inside a code span)
      if (t[i + 1] === '|') { cur += '|'; i += 2; continue; }
      cur += t[i] + t[i + 1]; i += 2; continue;
    }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

// Does a line start a block that can interrupt a paragraph (or end a table)?
function startsBlock(cur) {
  if (detectFence(cur)) return true;
  if (detectATX(cur)) return true;
  if (detectHr(cur)) return true;
  if (detectHtmlBlock(cur)) return true;
  if (peekListMarker(cur)) return true;
  // a blockquote line ends a table / interrupts a paragraph
  const s = curRest(cur);
  let k = 0;
  while (k < s.length && s[k] === ' ' && k < 3) k++;
  if (k < s.length && s[k] === '>') return true;
  return false;
}

// Parse a link reference definition from paragraph lines starting at `li`.
// `lines` are the paragraph's raw lines. Returns {def, consumed} or null.
// def = {href, title}; consumed = number of lines used.
function parseDef(lines, li) {
  // the label may span lines: apply the regex to the lines joined by \n
  const joined = lines.slice(li).join('\n');
  let m = /^ {0,3}\[((?:\\[\s\S]|[^\\\[\]])*)\]:/.exec(joined);
  if (!m) return null;
  const labelRaw = m[1];
  // an empty (or whitespace-only) label is not a valid definition
  if (normalizeLabel(unescapePunct(labelRaw)) === '') return null;
  // which line does the label end on, and at what column (after the ':')?
  const matched = m[0];
  const lastNL = matched.lastIndexOf('\n');
  const labelLines = lastNL < 0 ? 0 : matched.slice(0, lastNL + 1).split('\n').length - 1;
  let li2 = li + labelLines;
  const colAfter = lastNL < 0 ? matched.length : matched.length - lastNL - 1;
  let rest = lines[li2].slice(colAfter);
  // dest: optional whitespace/newline, then <...> or bare
  let dest = null;
  let title = '';
  let pos = 0;
  // skip spaces/tabs, possibly one newline + indent
  let p = 0;
  while (p < rest.length && (rest[p] === ' ' || rest[p] === '\t')) p++;
  if (p >= rest.length && li2 + 1 < lines.length) {
    li2++;
    rest = lines[li2];
    p = 0;
    while (p < rest.length && (rest[p] === ' ' || rest[p] === '\t')) p++;
  }
  if (p >= rest.length) return null;
  if (rest[p] === '<') {
    let k = p + 1;
    let d = '';
    let ok = false;
    while (k < rest.length) {
      const ch = rest[k];
      if (ch === '\n') return null;
      if (ch === '\\' && k + 1 < rest.length) { d += rest[k] + rest[k + 1]; k += 2; continue; }
      if (ch === '>') { ok = true; break; }
      if (ch === '<') return null;
      d += ch;
      k++;
    }
    if (!ok) return null;
    dest = d;
    pos = k + 1;
  } else {
    let k = p;
    let d = '';
    while (k < rest.length) {
      const ch = rest[k];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (ch === '\\' && k + 1 < rest.length) { d += rest[k] + rest[k + 1]; k += 2; continue; }
      if (ch === '(' && d.indexOf('(') < 0) {
        // an unescaped ( in a bare dest: check balance
        let depth = 0;
        let kk = k;
        let closed = false;
        while (kk < rest.length) {
          if (rest[kk] === '\\' && kk + 1 < rest.length) { kk += 2; continue; }
          if (rest[kk] === '(') depth++;
          else if (rest[kk] === ')') { depth--; if (depth === 0) { closed = true; break; } }
          else if (rest[kk] === ' ' || rest[kk] === '\t') break;
          kk++;
        }
        if (!closed) return null;
      }
      d += ch;
      k++;
    }
    if (d === '') return null;
    dest = d;
    pos = k;
  }
  // optional title: must be preceded by whitespace (space/tab on this line,
  // or a newline onto the next line)
  let after = rest.slice(pos);
  let q = 0;
  let li3 = li2;
  let wsBefore = false;
  while (q < after.length && (after[q] === ' ' || after[q] === '\t')) { q++; wsBefore = true; }
  if (q >= after.length) {
    // end of the dest line: a title may be on the next line
    if (li3 + 1 < lines.length) {
      li3++;
      after = lines[li3];
      q = 0;
      wsBefore = true; // the newline counts as whitespace
      while (q < after.length && (after[q] === ' ' || after[q] === '\t')) q++;
    }
  }
  if (q < after.length && (after[q] === '"' || after[q] === "'" || after[q] === '(')) {
    if (!wsBefore) return null; // no whitespace between dest and title
    // the title may span lines: parse it on `after` plus the following
    // lines joined by \n (q is an index into `after`, hence into this)
    const joinedTitle = after + (li3 + 1 < lines.length ? '\n' + lines.slice(li3 + 1).join('\n') : '');
    const t = parseTitle(joinedTitle, q);
    if (!t) {
      if (li3 > li2) {
        return { def: { href: unescapePunct(dest), title: '' }, consumed: li2 - li + 1, label: normalizeLabel(unescapePunct(labelRaw)) };
      }
      return null;
    }
    // which line does the title end on, and is the tail only whitespace?
    const titleText = joinedTitle.slice(0, t.end);
    const titleLines = titleText.split('\n').length - 1;
    const li3End = li3 + titleLines;
    const afterOffset = lines[li3].length - after.length;
    const lastNL = titleText.lastIndexOf('\n');
    const tailStart = lastNL < 0 ? afterOffset + t.end : t.end - lastNL - 1;
    const tailOk = lines[li3End].slice(tailStart).replace(/[ \t]/g, '') === '';
    if (!tailOk) {
      // malformed title or trailing junk: if the title is on a later line
      // than the dest, fall back to a no-title def; if it is on the dest
      // line itself, the def is invalid
      if (li3End > li2) {
        return { def: { href: unescapePunct(dest), title: '' }, consumed: li2 - li + 1, label: normalizeLabel(unescapePunct(labelRaw)) };
      }
      return null;
    }
    title = t.title;
    return { def: { href: unescapePunct(dest), title }, consumed: li3End - li + 1, label: normalizeLabel(unescapePunct(labelRaw)) };
  }
  // junk on the dest line itself invalidates the def; a following line that
  // is not a title does not (the def simply has no title)
  if (li3 === li2 && q < after.length) return null;
  return { def: { href: unescapePunct(dest), title: '' }, consumed: li2 - li + 1, label: normalizeLabel(unescapePunct(labelRaw)) };
}

// Remove up to `cols` columns of leading whitespace from `s`, where the
// string starts at column `startCol`. Returns the remaining string, with a
// partially-consumed tab expanded to spaces.
function dedentStr(s, cols, startCol) {
  let col = startCol;
  let i = 0;
  let partial = 0;
  let n = cols;
  while (n > 0 && i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; col++; n--; continue; }
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (n < w) { partial = w - n; col += n; i++; n = 0; break; }
      i++; col += w; n -= w; continue;
    }
    break;
  }
  // a leading tab at a non-tab-stop column (e.g. after a container prefix
  // consumed 6 columns) expands to spaces to the next tab stop
  if (i < s.length && s[i] === '\t' && col % 4 !== 0) {
    const w = 4 - (col % 4);
    return ' '.repeat(w) + s.slice(i + 1);
  }
  return (partial > 0 ? ' '.repeat(partial) : '') + s.slice(i);
}

// ---------------------------------------------------------------------------
// Block parser main loop + rendering
// ---------------------------------------------------------------------------

function parseBlocks(src) {
  const refs = new Map();
  const root = { t: 'doc', children: [] };
  const stack = [root];
  let lines = src.split('\n');
  if (src === '') lines = [];
  else if (src.endsWith('\n')) lines.pop();
  const N = lines.length;

  const tip = () => stack[stack.length - 1];
  const tipIsPara = () => tip().t === 'para';

  function deepestContainer() {
    for (let k = stack.length - 1; k >= 0; k--) {
      const nd = stack[k];
      if (nd.t === 'doc' || nd.t === 'bq' || nd.t === 'item' || nd.t === 'list') return nd;
    }
    return root;
  }
  function addChild(node) {
    let parent = deepestContainer();
    // only item nodes belong in a list's items array; any other block added
    // while the tip is a bare list goes to the list's parent instead
    if (parent.t === 'list' && node.t !== 'item') parent = parent.parent || parent;
    node.parent = parent;
    if (parent.t === 'list') parent.items.push(node);
    else parent.children.push(node);
  }
  function finalize(node) {
    if (node.t === 'para') {
      let li = 0;
      while (li < node.lines.length) {
        const d = parseDef(node.lines, li);
        if (!d) break;
        if (!refs.has(d.label)) refs.set(d.label, d.def);
        li += d.consumed;
      }
      node.lines = node.lines.slice(li);
      if (node.lines.length === 0) node.dead = true;
    } else if (node.t === 'code') {
      if (!node.fenced) {
        while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
      }
    } else if (node.t === 'list') {
      let loose = node.loose;
      for (const it of node.items) if (it.loose) loose = true;
      node.tight = !loose;
    }
  }
  function closeFrom(idx) {
    for (let k = stack.length - 1; k >= idx; k--) finalize(stack[k]);
    stack.length = idx;
  }
  let blankPending = false;
  function markBlank() {
    // a blank line marks only the innermost item and its list as having
    // seen a blank (a blank inside a nested list must not make the outer
    // list loose). It also sets blankPending: the NEXT block added to
    // whichever item receives it makes that item loose if the item
    // already has children (the blank may separate blocks in an outer
    // item, e.g. * foo / * bar / blank / baz -> outer list loose).
    blankPending = true;
    for (let k = stack.length - 1; k >= 0; k--) {
      const nd = stack[k];
      if (nd.t === 'item') {
        nd.sawBlank = true;
        if (k > 0 && stack[k - 1].t === 'list') stack[k - 1].sawBlank = true;
        break;
      }
      if (nd.t === 'list') {
        nd.sawBlank = true;
        break;
      }
    }
  }
  function noteBlockAdded() {
    // a new block-level child was added to the current item
    for (let k = stack.length - 1; k >= 0; k--) {
      const nd = stack[k];
      if (nd.t === 'item') {
        if ((nd.sawBlank || blankPending) && nd.children.length > 0) nd.loose = true;
        nd.sawBlank = false;
        blankPending = false;
        break;
      }
    }
  }
  // Peek at line `idx` after matching the open containers (read-only).
  function peekLineContent(idx) {
    if (idx >= N) return null;
    const cur = makeCursor(lines[idx]);
    if (isBlankLine(lines[idx])) return cur;
    for (let d = 1; d < stack.length; d++) {
      const node = stack[d];
      if (node.t === 'list') continue;
      if (node.t === 'bq') { if (!matchBQ(cur)) return null; continue; }
      if (node.t === 'item') {
        if (!curAdvance(cur, node.contentIndent)) return null;
        continue;
      }
      break;
    }
    return cur;
  }
  function isTableStart(cur, lineIdx) {
    const header = splitTableRow(curRest(cur));
    const dcur = peekLineContent(lineIdx + 1);
    if (!dcur) return null;
    const aligns = parseTableDelimiter(curRest(dcur));
    if (!aligns) return null;
    if (aligns.length !== header.length) return null;
    return { header, aligns };
  }
  function parseTable(lineIdx, cur, tableInfo) {
    const table = { t: 'table', header: tableInfo.header, aligns: tableInfo.aligns, rows: [] };
    addChild(table);
    noteBlockAdded();
    let i = lineIdx + 2; // skip header + delimiter
    while (i < N) {
      if (isBlankLine(lines[i])) break;
      const rcur = peekLineContent(i);
      if (!rcur) break;
      if (startsBlock(rcur)) break;
      table.rows.push(splitTableRow(curRest(rcur)));
      i++;
    }
    return i;
  }

  let i = 0;
  while (i < N) {
    const rawLine = lines[i];
    const cur = makeCursor(rawLine);
    const blank = isBlankLine(rawLine);

    // ---- Phase 1: match open containers ----
    let lazy = false;
    let depth = 1;
    while (depth < stack.length) {
      const node = stack[depth];
      if (node.t === 'list') { depth++; continue; }
      if (node.t === 'bq') {
        if (!matchBQ(cur)) {
          // a line whose content after the matched containers is empty
          // is a blank line (ends the paragraph), not a lazy continuation
          if (tipIsPara() && !blank && curRest(cur) !== '' && !startsBlockInterruptingPara(cur)) lazy = true;
          else closeFrom(depth);
          break;
        }
        depth++;
        continue;
      }
      if (node.t === 'item') {
        if (blank) { depth++; continue; }
        // an empty item followed by a blank line is closed; a later
        // indented line is not part of it
        if (node.children.length === 0 && node.sawBlank) {
          closeFrom(depth);
          break;
        }
        const saveCur = { pos: cur.pos, col: cur.col, partial: cur.partial };
        if (!curAdvance(cur, node.contentIndent)) {
          // restore the cursor: a failed advance may have consumed
          // leading whitespace, which belongs to the line's content
          cur.pos = saveCur.pos; cur.col = saveCur.col; cur.partial = saveCur.partial;
          // a line starting a new item in the SAME list is not a lazy
          // continuation, even when the ordered number is not 1
          const lmSame = peekListMarker(cur);
          const parentList = stack[depth - 1];
          if (lmSame && parentList && parentList.t === 'list' && sameListType(parentList, lmSame)) {
            closeFrom(depth);
            break;
          }
          // a line starting a list of a DIFFERENT type ends this list
          // (the paragraph inside the item ends with it)
          if (lmSame && parentList && parentList.t === 'list') {
            closeFrom(depth - 1);
            break;
          }
          if (tipIsPara() && !blank && curRest(cur) !== '' && !startsBlockInterruptingPara(cur)) lazy = true;
          else closeFrom(depth);
          break;
        }
        depth++;
        continue;
      }
      break; // a leaf is the tip
    }

    // a line whose content after the matched containers is empty counts as
    // a blank line (e.g. a lone '>' inside a blockquote ends the paragraph)
    const effBlank = blank || curRest(cur) === '';

    // ---- Tip leaf handling ----
    if (!lazy) {
      const tp = tip();
      if (tp.t === 'code' && tp.fenced) {
        if (isClosingFence(cur, tp)) {
          closeFrom(stack.length - 1);
          i++;
          continue;
        }
        tp.lines.push(dedentStr(curRest(cur), tp.fenceIndent, cur.col));
        i++;
        continue;
      }
      if (tp.t === 'code' && !tp.fenced) {
        if (blank) {
          // a blank line inside indented code keeps its content after
          // stripping 4 columns of indent (e.g. 6 spaces -> 2 spaces)
          const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
          let b = '';
          if (curAdvance(cur, 4)) b = curRest(cur);
          cur.pos = save.pos; cur.col = save.col; cur.partial = save.partial;
          tp.pendingBlanks.push(b);
          i++;
          continue;
        }
        if (curIndentCols(cur) >= 4) {
          for (const b of tp.pendingBlanks) tp.lines.push(b);
          tp.pendingBlanks = [];
          curAdvance(cur, 4);
          tp.lines.push(curRest(cur));
          i++;
          continue;
        }
        closeFrom(stack.length - 1);
        // fall through to open a new block
      } else if (tp.t === 'html') {
        if (tp.type === 6 || tp.type === 7) {
          if (blank) {
            tp.followedByBlank = true;
            closeFrom(stack.length - 1);
            markBlank();
            i++;
            continue;
          }
          tp.lines.push(curRest(cur));
          i++;
          continue;
        }
        // types 1-5
        const text = curRest(cur);
        tp.lines.push(text);
        let done = false;
        if (tp.type === 1) {
          if (text.toLowerCase().indexOf('</' + tp.closeTag) >= 0) done = true;
        } else if (text.indexOf(tp.endMarker) >= 0) {
          done = true;
        }
        if (done) {
          tp.followedByBlank = (i + 1 < N && isBlankLine(lines[i + 1]));
          closeFrom(stack.length - 1);
        }
        i++;
        continue;
      } else if (tp.t === 'para') {
        if (effBlank) {
          closeFrom(stack.length - 1);
          markBlank();
          i++;
          continue;
        }
        const st = detectSetext(cur);
        if (st > 0) {
          const para = tp;
          // a setext underline needs a non-empty paragraph: if every line
          // of the paragraph is a link reference definition, the paragraph
          // is empty and this line is plain text
          let li = 0;
          while (li < para.lines.length) {
            const d = parseDef(para.lines, li);
            if (!d) break;
            li += d.consumed;
          }
          if (li >= para.lines.length) {
            para.lines.push(curRest(cur));
            i++;
            continue;
          }
          closeFrom(stack.length - 1);
          // remove the paragraph from its parent (it was added when opened)
          const par = para.parent;
          if (par) {
            const arr = par.t === 'list' ? par.items : par.children;
            const idx2 = arr.indexOf(para);
            if (idx2 >= 0) arr.splice(idx2, 1);
          }
          const heading = { t: 'heading', level: st, text: para.lines.join('\n').trim() };
          addChild(heading);
          noteBlockAdded();
          i++;
          continue;
        }
        const tbl = isTableStart(cur, i);
        if (tbl) {
          closeFrom(stack.length - 1);
          i = parseTable(i, cur, tbl);
          continue;
        }
        if (startsBlockInterruptingPara(cur)) {
          closeFrom(stack.length - 1);
          // fall through to open a new block
        } else {
          tp.lines.push(curRest(cur));
          i++;
          continue;
        }
      }
    } else {
      // lazy continuation of a paragraph
      const tp = tip();
      if (tp.t === 'para') {
        // dedent the lazy line: inside a list item, strip the item's
        // content indent; otherwise strip 4 columns if indented that far
        let text = curRest(cur);
        let itemIndent = 0;
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].t === 'item') { itemIndent = stack[k].contentIndent; break; }
        }
        if (itemIndent > 0) {
          text = dedentStr(text, itemIndent, cur.col);
        } else if (curIndentCols(cur) >= 4) {
          text = dedentStr(text, 4, cur.col);
        }
        tp.lines.push(text);
        i++;
        continue;
      }
    }

    // ---- Phase 2: open new blocks ----
    if (effBlank) {
      markBlank();
      i++;
      continue;
    }
    // Open containers (blockquote / list) in a loop.
    let opened = true;
    while (opened) {
      opened = false;
      const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
      if (matchBQ(cur)) {
        const bq = { t: 'bq', children: [] };
        addChild(bq);
        stack.push(bq);
        opened = true;
        continue;
      }
      cur.pos = save.pos; cur.col = save.col; cur.partial = save.partial;
      // a thematic break takes precedence over a list
      if (detectHr(cur)) break;
      const lm = peekListMarker(cur);
      if (lm) {
        // can a list interrupt a paragraph? (only bullet, or ordered start 1;
        // an empty item cannot interrupt a paragraph)
        const tp2 = tip();
        if (tp2.t === 'para') {
          if (lm.empty || !(lm.ordered === false || lm.start === 1)) {
            // cannot interrupt: treat as paragraph text
            break;
          }
        }
        matchListMarker(cur); // advance the cursor to the item content
        let list = null;
        if (tp2.t === 'list' && sameListType(tp2, lm)) {
          list = tp2;
          if (list.sawBlank) list.loose = true;
          // a blank pending from before this new item (e.g. between the
          // outer items, after a nested list ended) makes the list loose
          if (blankPending) list.loose = true;
          list.sawBlank = false;
        } else {
          if (tp2.t === 'list') closeFrom(stack.length - 1);
          // a brand-new list after a blank is tight; the blank was
          // before the list, not inside it
          blankPending = false;
          list = { t: 'list', ordered: lm.ordered, delim: lm.delim, bullet: lm.bullet, start: lm.start, items: [], loose: false, sawBlank: false };
          addChild(list);
          noteBlockAdded();
          stack.push(list);
        }
        const item = { t: 'item', children: [], contentIndent: lm.contentIndent, loose: false, sawBlank: false };
        item.parent = list;
        list.items.push(item);
        stack.push(item);
        opened = true;
        continue;
      }
    }
    // Now open a leaf.
    const tp3 = tip();
    // a bare list tip means the list ended (e.g. an hr interrupted it);
    // close it so the new block is a sibling of the list, not a child
    if (tp3.t === 'list') closeFrom(stack.length - 1);
    const tp3b = tip();
    if (tp3b.t === 'para') {
      // a paragraph is open and the line did not interrupt it (should not
      // happen because the paragraph case above handles continuations);
      // treat as a continuation
      tp3b.lines.push(curRest(cur));
      i++;
      continue;
    }
    const fence = detectFence(cur);
    if (fence) {
      const code = { t: 'code', fenced: true, lang: unescapePunct(fence.info), lines: [], fenceChar: fence.char, fenceLen: fence.len, fenceIndent: fence.indent, pendingBlanks: [] };
      addChild(code);
      noteBlockAdded();
      stack.push(code);
      i++;
      continue;
    }
    const atx = detectATX(cur);
    if (atx) {
      const heading = { t: 'heading', level: atx.level, text: atx.text };
      addChild(heading);
      noteBlockAdded();
      i++;
      continue;
    }
    const htmlInfo = detectHtmlBlock(cur);
    if (htmlInfo) {
      const html = { t: 'html', type: htmlInfo.type, lines: [curRest(cur)], closeTag: htmlInfo.closeTag || '', endMarker: htmlInfo.endMarker || '', followedByBlank: false };
      // types 1-5 may end on the same line
      let done = false;
      if (htmlInfo.type === 1) {
        const lower = curRest(cur).toLowerCase();
        if (lower.indexOf('</' + htmlInfo.closeTag) >= 0) done = true;
      } else if (htmlInfo.type !== 6 && htmlInfo.type !== 7) {
        if (curRest(cur).indexOf(htmlInfo.endMarker) >= 0) done = true;
      }
      if (done) {
        html.followedByBlank = (i + 1 < N && isBlankLine(lines[i + 1]));
        addChild(html);
        noteBlockAdded();
      } else {
        addChild(html);
        noteBlockAdded();
        stack.push(html);
      }
      i++;
      continue;
    }
    if (detectHr(cur)) {
      const hr = { t: 'hr' };
      addChild(hr);
      noteBlockAdded();
      i++;
      continue;
    }
    // table (header + delimiter on the next line)
    const tbl2 = isTableStart(cur, i);
    if (tbl2) {
      i = parseTable(i, cur, tbl2);
      continue;
    }
    if (curIndentCols(cur) >= 4) {
      const code = { t: 'code', fenced: false, lang: '', lines: [], pendingBlanks: [] };
      curAdvance(cur, 4);
      code.lines.push(curRest(cur));
      addChild(code);
      noteBlockAdded();
      stack.push(code);
      i++;
      continue;
    }
    // paragraph (only when the content has non-whitespace text; a
    // whitespace-only line inside a container is not a paragraph)
    if (curRest(cur).replace(/[ \t]/g, '') === '') {
      i++;
      continue;
    }
    const para = { t: 'para', lines: [curRest(cur)] };
    addChild(para);
    noteBlockAdded();
    stack.push(para);
    i++;
  }
  closeFrom(1);
  return { root, refs };
}

function sameListType(list, lm) {
  if (list.ordered !== lm.ordered) return false;
  if (list.ordered) return list.delim === lm.delim;
  return list.bullet === lm.bullet;
}

// Can this line start a block that interrupts a paragraph?
function startsBlockInterruptingPara(cur) {
  if (detectFence(cur)) return true;
  if (detectATX(cur)) return true;
  if (detectHr(cur)) return true;
  const hb = detectHtmlBlock(cur);
  if (hb && hb.type !== 7) return true;
  // blockquote
  const save = { pos: cur.pos, col: cur.col, partial: cur.partial };
  if (matchBQ(cur)) { cur.pos = save.pos; cur.col = save.col; cur.partial = save.partial; return true; }
  const lm = peekListMarker(cur);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNode(node, refs, isLast) {
  switch (node.t) {
    case 'doc':
      // at the doc level the last child still needs its trailing newline
      return node.children.map(c => renderNode(c, refs, false)).join('');
    case 'bq':
      return '<blockquote>\n' + node.children.map((c, idx) => renderNode(c, refs, idx === node.children.length - 1)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of node.items) out += renderItem(item, node, refs);
      return out + '</' + tag + '>\n';
    }
    case 'para': {
      if (node.dead || node.lines.length === 0) return '';
      return '<p>' + inlineParse(node.lines.join('\n'), refs, newInlineState()) + '</p>\n';
    }
    case 'heading':
      return '<h' + node.level + '>' + inlineParse(node.text, refs, newInlineState()) + '</h' + node.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      let text = node.lines.join('\n');
      if (text.length > 0) text += '\n';
      const langAttr = node.lang ? ' class="language-' + escapeNoEncode(node.lang) + '"' : '';
      return '<pre><code' + langAttr + '>' + escapeEncode(text) + '</code></pre>\n';
    }
    case 'html': {
      let text = node.lines.join('\n');
      // no trailing newline when the block is the last child of its
      // parent (the container's closing tag follows directly) or when
      // it is followed by blank line(s)
      if (!node.followedByBlank && !isLast) text += '\n';
      return text;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const al = node.aligns[c];
        const attr = al ? ' align="' + al + '"' : '';
        out += '<th' + attr + '>' + inlineParse(node.header[c], refs, newInlineState()) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let c = 0; c < node.header.length; c++) {
            const al = node.aligns[c];
            const attr = al ? ' align="' + al + '"' : '';
            const cell = c < row.length ? row[c] : '';
            out += '<td' + attr + '>' + inlineParse(cell, refs, newInlineState()) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderItem(item, list, refs) {
  const tight = list.tight;
  let inner = '';
  for (let ci = 0; ci < item.children.length; ci++) {
    const child = item.children[ci];
    const childIsLast = ci === item.children.length - 1;
    if (child.t === 'para') {
      if (child.dead || child.lines.length === 0) continue;
      const html = inlineParse(child.lines.join('\n'), refs, newInlineState());
      if (tight) inner += html;
      else inner += '<p>' + html + '</p>\n';
    } else if (child.t === 'text') {
      inner += child.html;
    } else {
      inner += renderNode(child, refs, childIsLast);
    }
  }
  // task list checkbox: a paragraph starting with [ ] / [x] / [X]
  if (tight && item.children.length > 0) {
    const first = item.children[0];
    if (first.t === 'para' && !first.dead && first.lines.length > 0) {
      const m = /^\[([ xX])\][ \t]+/.exec(first.lines[0]);
      if (m) {
        const checked = m[1] !== ' ';
        const box = checked
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
        const rest = first.lines[0].slice(m[0].length);
        const newLines = [rest].concat(first.lines.slice(1));
        const html = inlineParse(newLines.join('\n'), refs, newInlineState());
        // rebuild inner without the first paragraph's checkbox text
        let rebuilt = html;
        for (let k = 1; k < item.children.length; k++) {
          rebuilt += renderNode(item.children[k], refs, k === item.children.length - 1);
        }
        return '<li>' + box + ' ' + rebuilt + '</li>\n';
      }
    }
  }
  if (inner === '') return '<li></li>\n';
  return '<li>' + inner + '</li>\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  if (src === '') return '';
  const { root, refs } = parseBlocks(src);
  return renderNode(root, refs);
}



// Try an inline link/image at src[pos] ('[' or '![').
// Returns {end, text} (text = plain-text label for text mode) or null.
// When `textMode` is false, returns {end, html}.
function tryLink(src, pos, refs, state, textMode) {
  const isImage = src[pos] === '!';
  const bracketPos = isImage ? pos + 1 : pos;
  if (src[bracketPos] !== '[') return null;
  const cands = labelEndCandidates(src, bracketPos);
  if (cands.length === 0) return null;
  // the label closes at the FIRST depth-0 ] (bracket matching); a later
  // ] would make the label contain an unmatched ], which is invalid --
  // do not backtrack to it (e.g. [link] bar](/uri) is not a link)
  const labelEnd = cands[0];
  if (labelEnd + 1 >= src.length || src[labelEnd + 1] !== '(') return null;
  const par = parseLinkParens(src, labelEnd + 1);
  if (!par) return null;
  const labelText = src.slice(bracketPos + 1, labelEnd);
  // Be(): tag/autolink extending past the label?
  if (tagExtendsPastLabel(src, bracketPos + 1, labelText)) return null;
  const href = unescapePunct(par.dest);
  const title = par.title;
  const end = par.end;
  if (textMode) {
    // a label containing a link rejects the outer link (linkInText),
    // same as in html mode
    if (linkInText(labelText, refs)) return null;
    return { end, text: altText(labelText, refs) };
  }
  const html = buildLink(isImage, labelText, href, title, refs, state);
  if (html === null) return null; // link inside label -> reject
  return { end, html };
}

// Try a reference link/image at src[pos] ('[' or '![').
// Returns {end, html} / {end, text}, or {end, text:'['} for a failed ref
// (1-char text token), or null when src[pos] is not a '['.
function tryReflink(src, pos, refs, state, textMode) {
  const isImage = src[pos] === '!';
  const bracketPos = isImage ? pos + 1 : pos;
  if (src[bracketPos] !== '[') return null;
  const firstChar = src[pos];
  const cands = labelEndCandidates(src, bracketPos);
  if (cands.length === 0) return null;
  const labelEnd = cands[0];
  const labelText = src.slice(bracketPos + 1, labelEnd);
  let key = null;
  let end = -1;
  if (labelEnd + 1 < src.length && src[labelEnd + 1] === '[') {
    // full ref [label][ref] or collapsed [label][]
    let k = labelEnd + 2;
    while (k < src.length && src[k] !== ']' && src[k] !== '\n') k++;
    if (k < src.length && src[k] === ']') {
      const refLabel = src.slice(labelEnd + 2, k);
      if (refLabel.length === 0) {
        // collapsed [label][]
        key = normalizeLabel(labelText);
        end = k + 1;
      } else if (refLabel.length <= 999) {
        key = normalizeLabel(refLabel);
        end = k + 1;
      }
    }
    if (key === null) {
      // not a valid full ref: fall through to shortcut
      key = normalizeLabel(labelText);
      end = labelEnd + 1;
    }
  } else {
    // shortcut [label]
    key = normalizeLabel(labelText);
    end = labelEnd + 1;
  }
  const def = refs.get(key);
  if (!def) {
    // failed ref -> 1-char text token
    return { end: pos + 1, text: firstChar, failed: true };
  }
  if (tagExtendsPastLabel(src, bracketPos + 1, labelText)) return null;
  const href = unescapePunct(def.href);
  const title = def.title || '';
  if (textMode) {
    return { end, text: altText(labelText, refs) };
  }
  const html = buildLink(isImage, labelText, href, title, refs, state);
  if (html === null) return null;
  return { end, html };
}

// Find the end of a text run starting at src[pos].
// Stops before: \ < ! [ ` * ~, _ at a word boundary, hard breaks,
// http(s):// ftp://, www. (with the gate), emails, mailto:/xmpp:.
function scanTextEnd(src, pos, inLink) {
  const n = src.length;
  let i = pos;
  // first-char mailto: rule: a single non-alnum char followed by mailto:/xmpp:
  if (i + 1 < n && !isAlphaNum(src[i]) &&
      (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) {
    return i + 1;
  }
  // precompute email-start positions (for the email stop rule)
  i = pos + 1;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' || ch === '<' || ch === '!' || ch === '[' || ch === '`' || ch === '*' || ch === '~') break;
    if (ch === '_' && (i === 0 || !isWordChar(src[i - 1]))) break;
    if (ch === ' ') {
      // 2+ spaces + newline -> hard break
      let j = i;
      while (j < n && src[j] === ' ') j++;
      if (j - i >= 2 && j < n && src[j] === '\n') break;
      // non-alnum char followed by mailto:/xmpp:
      if (j < n && (src.startsWith('mailto:', j) || src.startsWith('xmpp:', j))) break;
      i++;
      continue;
    }
    // email: [emailchars]+@ — check BEFORE the h/f (URL) branch, so an
    // email starting with f/h (e.g. fix@...) is not consumed by it
    if (isEmailChar(ch)) {
      const em = matchEmailStart(src, i);
      if (em) break;
    }
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') {
      const rest = src.slice(i, i + 8).toLowerCase();
      if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('ftp://')) break;
      i++;
      continue;
    }
    if (ch === 'w' && src.startsWith('www.', i)) {
      const prev = i === 0 ? '' : src[i - 1];
      if (prev === '' || isSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') break;
      i++;
      continue;
    }
    // mailto:/xmpp: after a non-alnum char
    if (!isAlphaNum(ch) && i + 1 < n &&
        (src.startsWith('mailto:', i + 1) || src.startsWith('xmpp:', i + 1))) break;
    i++;
  }
  return i;
}

function isEmailChar(ch) {
  const c = ch.charCodeAt(0);
  if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  return ".!#$%&'*+/=?^_`{|}~-".indexOf(ch) >= 0;
}

// Does an email start at src[i]? (email chars + '@' + valid domain)
function matchEmailStart(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailChar(src[j])) j++;
  if (j >= n || src[j] !== '@' || j === i) return false;
  // domain: [a-zA-Z0-9-_]+ (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+ (?![\w-])
  let k = j + 1;
  let labels = 0;
  let lastDot = -1;
  while (k < n) {
    const ch = src[k];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') { k++; continue; }
    if (ch === '.') { labels++; lastDot = k; k++; continue; }
    break;
  }
  if (labels < 1) return false;
  // the char after the last label must be alphanumeric (domain ends with alnum)
  if (lastDot < 0 || k - 1 <= lastDot) return false;
  const after = src[k];
  if (after !== undefined && ((after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z') || (after >= '0' && after <= '9') || after === '_' || after === '-')) return false;
  return true;
}

// Main inline parser: returns the HTML for `src`.
function inlineParse(src, refs, state) {
  const n = src.length;
  if (n === 0) return '';
  const hasDelim = src.indexOf('*') >= 0 || src.indexOf('_') >= 0 || src.indexOf('~') >= 0;
  const masked = hasDelim ? computeMask(src, refs) : src;
  const out = [];
  let i = 0;
  let prevChar = '';
  let prevIsText = false;
  while (i < n) {
    if (!prevIsText) prevChar = '';
    prevIsText = false;
    const ch = src[i];
    // 1. escape
    if (ch === '\\') {
      const esc = matchEscape(src, i);
      if (esc) {
        out.push(escapeNoEncode(esc.text));
        i += 2;
        continue;
      }
      const br = matchBr(src, i);
      if (br) {
        out.push('<br>');
        i += br.len;
        // after a hard break, the next line's leading spaces are stripped
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        prevChar = '';
        prevIsText = false;
        continue;
      }
    }
    // 2. html tag
    if (ch === '<') {
      const tag = matchInlineTag(src.slice(i));
      if (tag) {
        // update inLink / inRawBlock state
        if (!state.inLink && /^<a[\s>]/.test(tag)) state.inLink = true;
        else if (state.inLink && /^<\/a[\s>]/.test(tag)) state.inLink = false;
        if (!state.inRawBlock && /^<(?:pre|script|style|textarea)[\s>]/.test(tag)) state.inRawBlock = true;
        else if (state.inRawBlock && /^<\/(?:pre|script|style|textarea)[\s>]/.test(tag)) state.inRawBlock = false;
        out.push(tag);
        i += tag.length;
        continue;
      }
      const al = matchAutolink(src.slice(i));
      if (al) {
        const href = cleanUrl(al.href);
        if (href === null) { out.push(escapeEncode(al.text)); i += al.raw.length; continue; }
        out.push('<a href="' + escapeEncode(href) + '">' + escapeEncode(al.text) + '</a>');
        state.linkEmitted = true;
        i += al.raw.length;
        continue;
      }
    }
    // 3. inline link / image
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const res = tryLink(src, i, refs, state, false);
      if (res) { out.push(res.html); i = res.end; continue; }
      const ref = tryReflink(src, i, refs, state, false);
      if (ref) {
        if (ref.failed) {
          out.push(escapeNoEncode(ref.text));
          i = ref.end;
          continue;
        }
        out.push(ref.html);
        i = ref.end;
        continue;
      }
    }
    // 4. emStrong
    if (ch === '*' || ch === '_') {
      const ld = matchLDelim(src, i);
      if (ld) {
        const em = emStrongScan(src, masked, i, ld, prevChar);
        if (em) {
          if (em.lead > 0) {
            out.push(ch.repeat(em.lead));
            prevChar = ch;
            prevIsText = true;
          }
          const inner = inlineParse(em.inner, refs, state);
          out.push(em.type === 'em' ? '<em>' + inner + '</em>' : '<strong>' + inner + '</strong>');
          prevChar = '';
          prevIsText = false;
          i += em.lead + em.raw.length;
          continue;
        }
      }
    }
    // 5. code span
    if (ch === '`') {
      const cs = matchCodeSpanToken(src, i);
      if (cs) {
        out.push('<code>' + escapeEncode(cs.text) + '</code>');
        i += cs.raw.length;
        continue;
      }
      // a backtick run that cannot form a code span is literal text: emit
      // the whole run (do not retry with a shorter run starting inside it)
      const runLen = backtickRun(src, i);
      out.push('`'.repeat(runLen));
      prevChar = '`';
      prevIsText = true;
      i += runLen;
      continue;
    }
    // 6. br (2+ spaces + newline)
    if (ch === ' ') {
      const br = matchBr(src, i);
      if (br) {
        out.push('<br>');
        i += br.len;
        // after a hard break, the next line's leading spaces are stripped
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        prevChar = '';
        prevIsText = false;
        continue;
      }
    }
    // 7. del
    if (ch === '~') {
      const ld = matchDelLDelim(src, i);
      if (ld) {
        const d = delScan(src, masked, i, ld, prevChar);
        if (d) {
          const inner = inlineParse(d.inner, refs, state);
          out.push('<del>' + inner + '</del>');
          i += d.raw.length;
          continue;
        }
      }
    }
    // 8. autolink (already handled under '<' above for tags; here for safety)
    // 9. url (only when not inLink)
    if (!state.inLink && (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'm' || ch === 'x' || isEmailChar(ch))) {
      const u = matchUrl(src.slice(i));
      if (u) {
        const href = cleanUrl(u.href);
        if (href === null) {
          const end = scanTextEnd(src, i, state.inLink);
          const text = src.slice(i, end);
          out.push(state.inRawBlock ? text : escapeNoEncode(unescapeText(text)));
          if (end > i && text[text.length - 1] !== '_') prevChar = text[text.length - 1];
          prevIsText = true;
          i = end;
          continue;
        }
        out.push('<a href="' + escapeEncode(href) + '">' + escapeEncode(u.text) + '</a>');
        state.linkEmitted = true;
        i += u.raw.length;
        continue;
      }
    }
    // 10. text
    const end = scanTextEnd(src, i, state.inLink);
    const text = src.slice(i, end);
    if (text.length === 0) {
      // safety: consume one char to avoid an infinite loop
      out.push(state.inRawBlock ? src[i] : escapeNoEncode(unescapeText(src[i])));
      if (src[i] !== '_') prevChar = src[i];
      prevIsText = true;
      i++;
      continue;
    }
    out.push(state.inRawBlock ? text : escapeNoEncode(unescapeText(text)));
    if (text[text.length - 1] !== '_') prevChar = text[text.length - 1];
    prevIsText = true;
    i = end;
  }
  return out.join('');
}
