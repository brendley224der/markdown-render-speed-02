// A fast drop-in for marked 18.1.3: parse(markdown) returns the HTML marked
// renders with its default options (GFM on, async off). Most blocks are
// rendered by the hand-written parser below; anything it cannot prove it
// handles byte-identically falls back, block by block, to the vendored
// marked 18.1.3 (MIT, vendor/marked/). parse() is pure per call: it keeps
// nothing between calls that could change an output. It never reads files,
// the clock, or the environment, and it never reaches the network.
//
// Design: the input is split into top-level blocks. Link reference
// definitions are pre-scanned (they affect links in every block, including
// inside quotes and lists). Each block is rendered by the fast path when it
// is certain it matches marked byte-for-byte, otherwise that block alone is
// rendered by the vendored marked (with the document's definitions
// prepended, so references resolve). If block splitting itself is ever
// uncertain, the whole document falls back to marked.
//
// `stats` counts fast-path vs fallback work for local benchmarking only; it
// never influences any output.

import { marked } from './vendor/marked/marked.esm.js';

export const stats = {
  cases: 0,
  fastBlocks: 0,
  fallbackBlocks: 0,
  wholeDocFallbacks: 0,
  fastBytes: 0,
  fallbackBytes: 0,
};

/** The HTML marked renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  stats.cases++;
  let src = markdown;
  if (src.includes('\r')) src = src.replace(/\r\n|\r/g, '\n');
  if (src === '') return '';
  try {
    const ctx = new ParseCtx(src);
    const blocks = scanBlocks(ctx, src);
    ctx.defText = ctx.defRaws.length ? ctx.defRaws.join('\n') + '\n\n' : '';
    return renderBlocks(ctx, blocks);
  } catch (e) {
    if (e && e.__bail) {
      stats.wholeDocFallbacks++;
      stats.fallbackBytes += src.length;
      return marked.parse(src);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Small helpers. These mirror the behaviour of marked 18.1.3's helpers
// (same outputs for the same inputs), written here in this file's own form.
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape & < > " ' (every occurrence).
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// Escape < > " ' and only those & that cannot start a character reference
// (a numeric reference &#...; or a named one &word; is left alone).
const NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escapeNoEncode(s) {
  if (!/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)) return s;
  NO_ENCODE_RE.lastIndex = 0;
  return s.replace(NO_ENCODE_RE, (ch) => ESCAPE_MAP[ch]);
}

const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Numeric character references stand for the character they name; a value
// that is zero, out of range, or a surrogate becomes U+FFFD. A bare & that
// cannot start a reference becomes &amp; here, so it is not escaped twice
// later. Named references are left untouched (they pass through verbatim).
function decodeNumericRefs(text) {
  if (!NUM_REF_RE.test(text)) return text;
  NUM_REF_OR_AMP_RE.lastIndex = 0;
  return text.replace(NUM_REF_OR_AMP_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way marked's cleanUrl does. Returns
// null when encodeURI throws (a lone surrogate), in which case the link is
// not formed at all and only its text is rendered.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function rtrimChar(str, c) {
  let i = str.length;
  while (i > 0 && str.charAt(i - 1) === c) i--;
  return str.slice(0, i);
}

// marked's helper name for the same operation.
const rtrim = rtrimChar;

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// Expand tabs to spaces, tab stops every 4 columns from `col`.
function expandTabs(line, col = 0) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// A link label, normalised the way marked normalises it: trimmed, inner
// runs of spaces/tabs/newlines collapsed to one space, Unicode case folded.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the closing bracket that unbalances `str`, -1 when balanced or
// absent, -2 when there are more openers than closers.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Split one table row on unescaped pipes, honouring `\|` and the header
// count (extra cells dropped, missing cells padded with '').
function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// Column width of a line's leading whitespace, tabs to tab stops of 4.
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 32) col++;
    else if (ch === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Number of leading whitespace characters (spaces/tabs) of a line.
function leadingWsLen(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

class Bail extends Error {
  constructor() { super('bail to marked'); this.__bail = true; }
}
function bail() { throw new Bail(); }

// ---------------------------------------------------------------------------
// Per-parse context: the source, its lines, the link definitions found while
// scanning, and the inline state marked carries across a whole parse.
// ---------------------------------------------------------------------------

class ParseCtx {
  constructor(src) {
    this.src = src;
    this.refs = new Map(); // normalised label -> {href, title}
    this.defRaws = []; // definition source texts, first occurrence first
    this.defText = ''; // defRaws joined, for fallback chunks
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }
}

// ---------------------------------------------------------------------------
// Regexes. These are the behaviour-defining patterns of marked 18.1.3's
// grammars, written out here so this parser makes exactly marked's
// decisions. (The block scanner below usually answers the same questions
// with cheaper line checks and only reaches for these when a line is
// ambiguous.)
// ---------------------------------------------------------------------------

const BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// A line that starts an HTML block of types 1-6 (the ones that can interrupt
// a paragraph); type 7 (a lone tag) cannot.
const HTML_BEGIN_RE = new RegExp(
  `^ {0,3}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  'i',
);
// A line that is a complete HTML block of type 1 (script/pre/style/textarea),
// with the tag name captured.
const HTML_TYPE1_RE = /^ {0,3}<(script|pre|style|textarea)[\s>]/i;
// A line that is a lone open or closing tag (type 7 start).
const HTML_TYPE7_OPEN_RE = /^( {0,3})<(?!script|pre|style|textarea(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?>[ \t]*$/i;
const HTML_TYPE7_CLOSE_RE = /^ {0,3}<\/[a-z][a-z0-9-]*\s*>[ \t]*$/i;

const HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_DELIM_CELL = /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

// --- inline grammar ---
const INLINE_ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// GFM text: a run that stops before a special character, a hard break, a
// `www.` autolink, a protocol:// autolink, or an email autolink.
const INLINE_TEXT_RE = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;

// Punctuation tests. PUNCT_TEST_RE is marked's `punctuation` rule: a
// punctuation-or-space character other than `*` or `_`.
const PUNCT_TEST_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;
// GFM: ~ is not punctuation for emphasis purposes (it is strikethrough).
const PUNCT_GFM_RE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM_RE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM_RE = /(?:[^\s\p{P}\p{S}]|~)/u;

const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

// Emphasis left-delimiter: a run of * or _ plus the character after it.
const EM_LDELIM_RE = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
// Emphasis right-delimiter scans (asterisk / underscore), groups 1-6 as in
// marked: 1-2 right-only, 3-4 left-only, 5-6 either.
function emRDelimAst() {
  return new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' +
    '|[^*]+(?=[^*])' +
    '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)' +
    '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)' +
    '|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))' +
    '|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
    '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])' +
    '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))',
    'gu',
  );
}
function emRDelimUnd() {
  return new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' +
    '|[^_]+(?=[^_])' +
    '|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)' +
    '|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)' +
    '|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])' +
    '|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])' +
    '|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])',
    'gu',
  );
}

// Strikethrough delimiters (GFM): ~ runs of length 1 or 2.
const DEL_LDELIM_RE = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
function delRDelim() {
  return new RegExp(
    '^[^~]+(?=[^~])' +
    '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)' +
    '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)' +
    '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])' +
    '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
    '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])' +
    '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])',
    'gu',
  );
}

const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;

// A link label, nested brackets to two levels (what the spec suite asks).
// Regex literals so the backtick alternatives need no escaping tricks.
const INLINE_LABEL_RE = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const BLOCK_LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BOUNDED_BLOCK_LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const BOUNDED_INLINE_LABEL_RE = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const LINK_TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_RE = new RegExp(
  '^!?\\[(' + INLINE_LABEL_RE.source + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + LINK_TITLE_SRC + '))?[ \\t\\n]*\\)',
);
const REFLINK_RE = new RegExp('^!?\\[(' + INLINE_LABEL_RE.source + ')\\]\\[(' + BLOCK_LABEL_RE.source + ')\\]');
const NOLINK_RE = new RegExp('^!?\\[(' + BLOCK_LABEL_RE.source + ')\\](?:\\[\\])?');

// Bounded variants used to search a run for reference links without the
// quadratic scan of the unbounded ones. Groups: 1 reflink label, 2 reflink
// ref, 3 nolink ref.
const REFLINK_SEARCH_RE = new RegExp(
  '!?\\[(' + BOUNDED_INLINE_LABEL_RE.source + ')\\]\\[(' + BOUNDED_BLOCK_LABEL_RE.source + ')\\]|!?\\[(' + BOUNDED_BLOCK_LABEL_RE.source + ')\\](?:\\[\\])?(?!\\()',
  'g',
);

// GFM extended autolinks: www., protocol://, or an email address.
const URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Links, code spans and tags, as one global pass, for masking emphasis.
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// A link reference definition: `[label]: dest "title"`, dest and title
// optional across lines. Matched against a whole block start, not one line.
const DEF_RE = new RegExp(
  '^ {0,3}\\[' + '(' + BLOCK_LABEL_RE.source + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)',
);

// Blockquote paragraph: the paragraph pattern used inside blockquotes,
// with the blockquote list-interrupt rule. (Built from marked's
// blockquoteParagraph, exactly as its edit() composition produces it.)
const BLOCKQUOTE_PARA_SRC =
  '([^\\n]+(?:\\n(?!' +
  ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)' +
  '| {0,3}#{1,6}(?:\\s|$)' +
  '| {0,3}>' +
  '| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)' +
  '| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)' +
  '| {0,3}(?:</?(?:' + BLOCK_TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)' +
  '|[ \\t]+\\n)[^\\n]+)*)';
const BLOCKQUOTE_RE = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + BLOCKQUOTE_PARA_SRC + ')|[^\\n]*)(?:\\n|$))+',
);

// The list tokeniser's first-line regex (groups: 1 = indent + marker,
// 2 = the rest of the line after one space/tab, if any).
const LIST_START_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;

// ---------------------------------------------------------------------------
// marked 18.1.3 block grammar (GFM). Composed exactly as rules.ts composes
// it, so each regex is byte-identical to marked's (verified by
// ~/workspace/makefun/mrs02-scratch/verify-block-regex.mjs).
// ---------------------------------------------------------------------------

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  endingNewline: /\n$/,
  notSpaceStart: /^\S*/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  caret: /(^|[^\[])\^/g,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(OTHER.caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const BLOCK_NEWLINE_RE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT_RE = /^[^\n]+/;

const LHEADING_CORE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BLOCK_LHEADING_RE = edit(LHEADING_CORE)
  .replace(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

const BLOCK_TABLE_RE = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', BLOCK_HR_RE)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAG)
  .getRegex();

const _PARAGRAPH_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function createParagraph(listInterrupt) {
  return edit(_PARAGRAPH_SRC)
    .replace('hr', BLOCK_HR_RE)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAG)
    .getRegex();
}
// GFM paragraph: tables can interrupt, setext cannot.
const BLOCK_PARAGRAPH_RE = edit(_PARAGRAPH_SRC)
  .replace('hr', BLOCK_HR_RE)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', BLOCK_TABLE_RE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAG)
  .getRegex();

const BLOCK_HTML_RE = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
  .replace('tag', BLOCK_TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

// ---------------------------------------------------------------------------
// Block scanner: a port of marked 18.1.3's Lexer.blockTokens + Tokenizer
// block methods, producing light descriptors instead of token objects.
// Inline sources are kept as text and rendered later, once every link
// reference definition in the document has been collected (marked renders
// inline only after the whole block pass, so a definition anywhere in the
// document applies to every block).
// ---------------------------------------------------------------------------

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(OTHER.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const matchIndentInNode = node.match(OTHER.beginningSpace);
    if (matchIndentInNode === null) return node;
    const [indentInNode] = matchIndentInNode;
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function tokSpace(src) {
  const cap = BLOCK_NEWLINE_RE.exec(src);
  if (cap && cap[0].length > 0) return { t: 'space', raw: cap[0] };
}

function tokCode(src) {
  const cap = BLOCK_CODE_RE.exec(src);
  if (!cap) return;
  const raw = trimTrailingBlankLines(cap[0]);
  return { t: 'code', raw, text: raw.replace(OTHER.codeRemoveIndent, ''), lang: undefined };
}

function tokFences(src) {
  const cap = BLOCK_FENCES_RE.exec(src);
  if (!cap) return;
  return {
    t: 'code',
    raw: cap[0],
    text: indentCodeCompensation(cap[0], cap[3] || ''),
    lang: cap[2] ? cap[2].trim().replace(ANY_PUNCT_RE, '$1') : cap[2],
  };
}

function tokHeading(src) {
  const cap = BLOCK_HEADING_RE.exec(src);
  if (!cap) return;
  let text = cap[2].trim();
  if (OTHER.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || OTHER.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  return { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
}

function tokHr(src) {
  const cap = BLOCK_HR_RE.exec(src);
  if (cap) return { t: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(ctx, src) {
  const cap = BLOCKQUOTE_RE.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (OTHER.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(OTHER.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(OTHER.blockquoteSetextReplace, '\n    $1')
      .replace(OTHER.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = ctx.state.top;
    ctx.state.top = true;
    scanBlocks(ctx, currentText, tokens, true);
    ctx.state.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr' || lastToken?.t === 'html' || lastToken?.t === 'table') {
      break;
    } else if (lastToken?.t === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(OTHER.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(ctx, newText);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { t: 'blockquote', raw, tokens, text };
}

// First line of `s` without allocating an array (unlike split('\n', 1)).
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl === -1 ? s : s.slice(0, nl);
}

// First non-space character of `line` when it starts with at most `indent`
// spaces, or -1 when the line's start cannot match an indent-anchored block
// regex (too many spaces, a tab, or a blank line). The list loop's per-line
// regexes are all `^ {0,indent}marker`, so only the regexes whose marker
// this character can start need to run.
function lineMarkerChar(line, indent) {
  let i = 0;
  while (i < indent && i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return -1;
  if (line.charCodeAt(i) === 9) return -1;
  return line.charCodeAt(i);
}

// Does `raw` end with a double blank line (a blank line, then another)?
// The same test as /\n[ \t]*\n[ \t]*$/ without the regex.
function hasDoubleBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || raw.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || raw.charCodeAt(i - 1) !== 10) return false;
  return true;
}

function tokList(ctx, src) {
  let cap = LIST_START_RE.exec(src);
  if (!cap) return;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = OTHER.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (BLOCK_HR_RE.test(src)) break;
    const itemStart = taken();
    src = src.substring(cap[0].length);
    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(OTHER.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    let nextLine = firstLineOf(src);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(OTHER.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && OTHER.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = OTHER.nextBulletRegex(indent);
      const hrRegex = OTHER.hrRegex(indent);
      const fencesBeginRegex = OTHER.fencesBeginRegex(indent);
      const headingBeginRegex = OTHER.headingBeginRegex(indent);
      const htmlBeginRegex = OTHER.htmlBeginRegex(indent);
      const blockquoteBeginRegex = OTHER.blockquoteBeginRegex(indent);
      while (src) {
        const rawLine = firstLineOf(src);
        let nextLineWithoutTabs;
        nextLine = rawLine;
        nextLineWithoutTabs = nextLine.replace(OTHER.leadingSpaceTab, (whitespace) => expandTabs(whitespace));
        const mc = lineMarkerChar(nextLine, indent);
        if ((mc === 96 || mc === 126) && fencesBeginRegex.test(nextLine)) break;
        if (mc === 35 && headingBeginRegex.test(nextLine)) break;
        if (mc === 60 && htmlBeginRegex.test(nextLine)) break;
        if (mc === 62 && blockquoteBeginRegex.test(nextLine)) break;
        if ((mc === 42 || mc === 43 || mc === 45 || (mc >= 48 && mc <= 57)) && nextBulletRegex.test(nextLine)) break;
        if ((mc === 45 || mc === 95 || mc === 42) && hrRegex.test(nextLine)) break;
        if (nextLineWithoutTabs.search(OTHER.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(OTHER.tabCharGlobal, '    ').search(OTHER.nonSpaceChar) >= 4) break;
          const lc = lineMarkerChar(line, indent);
          if ((lc === 96 || lc === 126) && fencesBeginRegex.test(line)) break;
          if (lc === 35 && headingBeginRegex.test(line)) break;
          if (lc === 60 && htmlBeginRegex.test(line)) break;
          if ((lc === 45 || lc === 95 || lc === 42) && hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && BLOCK_LHEADING_RE.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (hasDoubleBlankLine(raw)) {
        endsWithBlankLine = true;
      }
    }
    list.items.push({
      t: 'list_item',
      raw,
      task: OTHER.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    item.tokens = scanBlocks(ctx, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((tok) => tok.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((tok) => OTHER.anyLine.test(tok.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
      item.text = item.text.replace(OTHER.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(OTHER.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(OTHER.listReplaceTask, '');
      const taskRaw = OTHER.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          t: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].t)) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].lead = checkboxToken;
          } else {
            item.tokens.unshift({
              t: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              lead: checkboxToken,
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') token.t = 'paragraph';
      }
    }
  }
  return list;
}

function tokHtml(src) {
  const cap = BLOCK_HTML_RE.exec(src);
  if (!cap) return;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    t: 'html',
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function tokDef(ctx, src) {
  const cap = DEF_RE.exec(src);
  if (!cap) return;
  if (!OTHER.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(OTHER.hrefBrackets, '$1').replace(ANY_PUNCT_RE, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(ANY_PUNCT_RE, '$1') : cap[3];
  return { t: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tokTable(src) {
  // Cheap pre-check: a table needs a delimiter row as its second line.
  const nl = src.indexOf('\n');
  if (nl === -1) return;
  let i = nl + 1;
  let sp = 0;
  while (sp < 3 && src.charCodeAt(i) === 32) { i++; sp++; }
  const lineEnd = src.indexOf('\n', i);
  const delimLine = lineEnd === -1 ? src.slice(i) : src.slice(i, lineEnd);
  if (!TABLE_DELIM_CELL.test(delimLine)) return;
  const cap = BLOCK_TABLE_RE.exec(src);
  if (!cap) return;
  if (!OTHER.tableDelimiter.test(cap[2])) return;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(OTHER.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(OTHER.tableRowBlankLine, '').split('\n') : [];
  const item = { t: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;
  for (const align of aligns) {
    if (OTHER.tableAlignRight.test(align)) item.align.push('right');
    else if (OTHER.tableAlignCenter.test(align)) item.align.push('center');
    else if (OTHER.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({ text: cell, align: item.align[i] })));
  }
  return item;
}

// Is there a setext underline line before the paragraph ends (a blank
// line)? A sound pre-check for tokLheading: the underline must be such a
// line, so when there is none the lheading regex cannot match.
function hasSetextAhead(src) {
  let pos = 0;
  while (true) {
    const nl = src.indexOf('\n', pos);
    if (nl === -1) return false;
    let i = nl + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(i) === 32) { i++; sp++; }
    const ch = src.charCodeAt(i);
    if (ch === 61 || ch === 45) {
      let j = i;
      while (j < src.length) {
        const cj = src.charCodeAt(j);
        if (cj === 10) break;
        if (cj !== 61 && cj !== 45 && cj !== 32 && cj !== 9) break;
        j++;
      }
      if (j >= src.length || src.charCodeAt(j) === 10) return true;
    }
    // A blank line ends the paragraph (and any setext heading in it).
    let k = nl + 1;
    let blank = true;
    while (k < src.length) {
      const ck = src.charCodeAt(k);
      if (ck === 10) break;
      if (ck !== 32 && ck !== 9) { blank = false; break; }
      k++;
    }
    if (blank) return false;
    pos = nl + 1;
  }
}

function tokLheading(src) {
  if (!hasSetextAhead(src)) return;
  const cap = BLOCK_LHEADING_RE.exec(src);
  if (!cap) return;
  return {
    t: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text: cap[1].trim(),
  };
}

function tokParagraph(src) {
  const cap = BLOCK_PARAGRAPH_RE.exec(src);
  if (!cap) return;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { t: 'paragraph', raw: cap[0], text };
}

function tokText(src) {
  const cap = BLOCK_TEXT_RE.exec(src);
  if (cap) return { t: 'text', raw: cap[0], text: cap[0] };
}

// The main block loop. `tokens` lets blockquote/list append into an existing
// array; `lastParagraphClipped` merges a leading paragraph into the previous
// paragraph token (blockquote lazy continuation).
function scanBlocks(ctx, src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    const c = src.charCodeAt(0);
    let token;
    // newline (space): src starts with space, tab or newline
    if ((c === 32 || c === 9 || c === 10) && (token = tokSpace(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }
    // indented code: 4 spaces or a tab
    if ((c === 32 || c === 9) && (token = tokCode(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    // fences: space, backtick or tilde
    if ((c === 32 || c === 96 || c === 126) && (token = tokFences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // heading: space or #
    if ((c === 32 || c === 35) && (token = tokHeading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // hr: space, -, _ or *
    if ((c === 32 || c === 45 || c === 95 || c === 42) && (token = tokHr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // blockquote: space or >
    if ((c === 32 || c === 62) && (token = tokBlockquote(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // list: space, *, +, -, or a digit
    if ((c === 32 || c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)) && (token = tokList(ctx, src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // html: space or <
    if ((c === 32 || c === 60) && (token = tokHtml(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // def: space or [
    if ((c === 32 || c === 91) && (token = tokDef(ctx, src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'paragraph' || lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
      } else {
        if (!ctx.refs.has(token.tag)) {
          ctx.refs.set(token.tag, { href: token.href, title: token.title });
        }
        ctx.defRaws.push(token.raw);
        tokens.push(token);
      }
      continue;
    }
    // table: any first char except a newline; needs a delimiter row next
    if (c !== 10 && (token = tokTable(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // lheading (setext): any first char except a newline
    if (c !== 10 && (token = tokLheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }
    // paragraph (only at top level)
    if (ctx.state.top && (token = tokParagraph(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      continue;
    }
    // text: a single line
    if (token = tokText(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }
  ctx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline rendering: a port of marked 18.1.3's Lexer inline loop + Tokenizer
// inline methods, building the HTML string directly instead of token
// objects. `plain` renders with the TextRenderer semantics (used for image
// alt text): no tags, no escaping, code spans and links as bare text.
// ---------------------------------------------------------------------------

const EM_RDELIM_AST_RE = emRDelimAst();
const EM_RDELIM_UND_RE = emRDelimUnd();
const DEL_RDELIM_RE = delRDelim();

function scanClosers(src) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { last, lastDel };
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE_CODE_RE.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = TAG_RE.exec(tokenSrc) || AUTOLINK_RE.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(REFLINK_SEARCH_RE)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !ctx.refs.has(normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans and tags so emStrong/del do not see delimiters
// inside them. Every replacement keeps its length, so the masked source
// lines up with the real source by index.
function maskSrc(ctx, src) {
  let maskedSrc = src;
  if (ctx.refs.size > 0 && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!ctx.refs.has(normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(REFLINK_SEARCH_RE, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(REFLINK_SEARCH_RE, maskReflink);
  }
  // Only the escapes outside code spans are masked, and only when the run
  // holds a backslash or a backtick that could start one.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // Only links, code spans and tags are masked, and only when the run holds
  // a character one of them can start with.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(BLOCK_SKIP_RE, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

function inlineEscape(rest, plain) {
  const cap = INLINE_ESCAPE_RE.exec(rest);
  if (!cap) return null;
  return { html: plain ? cap[1] : escapeNoEncode(cap[1]), n: cap[0].length };
}

function inlineTag(ctx, rest) {
  const cap = TAG_RE.exec(rest);
  if (!cap) return null;
  const st = ctx.state;
  if (!st.inLink && OTHER.startATag.test(cap[0])) st.inLink = true;
  else if (st.inLink && OTHER.endATag.test(cap[0])) st.inLink = false;
  if (!st.inRawBlock && OTHER.startPreScriptTag.test(cap[0])) st.inRawBlock = true;
  else if (st.inRawBlock && OTHER.endPreScriptTag.test(cap[0])) st.inRawBlock = false;
  return { html: cap[0], n: cap[0].length };
}

function outputLink(ctx, cap, link, plain) {
  const st = ctx.state;
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const nested = renderInline(ctx, text, isImage ? true : plain);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage) {
    // Links may not contain other links, at any level of nesting. Bail so
    // the caller falls through to text and the inner link is the one kept.
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  // Plain rendering (image alt text) keeps only the label's text: no tags.
  if (plain) return { html: nested, n: cap[0].length };
  const cleanHref = cleanUrl(href);
  if (isImage) {
    if (cleanHref === null) return { html: escapeNoEncode(nested), n: cap[0].length };
    let out = '<img src="' + escapeNoEncode(cleanHref) + '" alt="' + escapeNoEncode(nested) + '"';
    if (title) out += ' title="' + escapeNoEncode(title) + '"';
    out += '>';
    return { html: out, n: cap[0].length };
  }
  if (cleanHref === null) return { html: nested, n: cap[0].length };
  let out = '<a href="' + escapeNoEncode(cleanHref) + '"';
  if (title) out += ' title="' + escapeNoEncode(title) + '"';
  out += '>' + nested + '</a>';
  return { html: out, n: cap[0].length };
}

function inlineLink(ctx, rest, plain) {
  const st = ctx.state;
  if (st.linkParenPossible === false) return null;
  const cap = LINK_RE.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (OTHER.startAngleBracket.test(trimmedUrl)) {
    if (!OTHER.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(ctx, cap, {
    href: href ? href.replace(ANY_PUNCT_RE, '$1') : href,
    title: title ? title.replace(ANY_PUNCT_RE, '$1') : title,
  }, plain);
}

function inlineReflink(ctx, rest, plain) {
  const cap = REFLINK_RE.exec(rest) || NOLINK_RE.exec(rest);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return null;
  const link = ctx.refs.get(normalizeLabel(cap[2] || cap[1]));
  if (!link) {
    const ch = cap[0].charAt(0);
    return { html: plain ? ch : escapeNoEncode(ch), n: 1 };
  }
  return outputLink(ctx, cap, link, plain);
}

function inlineEmStrong(ctx, rest, maskedSrc, prevChar, hint, plain) {
  let match = EM_LDELIM_RE.exec(rest);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - rest.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCT_TEST_RE.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCT_TEST_RE.exec(prevChar);
  if (match[4] && prevChar.match(OTHER.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  // The closer hint can already rule this opener out: when no run that can
  // close exists at or after the opener, the scan below cannot succeed, and
  // neither can the left-delimiter test that follows, so this returns null
  // either way.
  const lLength = [...match[0]].length - 1;
  if (hint.last[delimChar] < maskedSrc.length - rest.length + lLength) return null;
  if (!nextChar || !prevChar || prevPunct) {
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EM_RDELIM_AST_RE : EM_RDELIM_UND_RE;
    const lastPossible = hint.last[delimChar];
    const windowStart = maskedSrc.length - rest.length + lLength;
    if (lastPossible < windowStart) return null;
    const msrc = maskedSrc.slice(-1 * rest.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(msrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const inner = renderInline(ctx, raw.slice(1, -1), plain);
        return { html: plain ? inner : `<em>${inner}</em>`, n: raw.length };
      }
      const inner = renderInline(ctx, raw.slice(2, -2), plain);
      return { html: plain ? inner : `<strong>${inner}</strong>`, n: raw.length };
    }
  }
  return null;
}

function inlineCodespan(rest, plain) {
  const cap = INLINE_CODE_RE.exec(rest);
  if (!cap) return null;
  let text = cap[2].replace(OTHER.newLineCharGlobal, ' ');
  const hasNonSpaceChars = OTHER.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { html: plain ? text : '<code>' + escapeAll(text) + '</code>', n: cap[0].length };
}

function inlineBr(rest, plain) {
  const cap = INLINE_BR_RE.exec(rest);
  if (!cap) return null;
  return { html: plain ? '' : '<br>', n: cap[0].length };
}

function inlineDel(ctx, rest, maskedSrc, prevChar, hint, plain) {
  let match = DEL_LDELIM_RE.exec(rest);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || PUNCT_TEST_RE.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const lastPossible = hint.lastDel;
    const windowStart = maskedSrc.length - rest.length + lLength;
    if (lastPossible < windowStart) return null;
    const msrc = maskedSrc.slice(-1 * rest.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    DEL_RDELIM_RE.lastIndex = 0;
    while ((match = DEL_RDELIM_RE.exec(msrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      const inner = renderInline(ctx, raw.slice(lLength, -lLength), plain);
      return { html: plain ? inner : `<del>${inner}</del>`, n: raw.length };
    }
  }
  return null;
}

function inlineAutolink(rest, plain) {
  const cap = AUTOLINK_RE.exec(rest);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (plain) return { html: text, n: cap[0].length };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeAll(text), n: cap[0].length };
  return { html: '<a href="' + escapeAll(cleanHref) + '">' + escapeAll(text) + '</a>', n: cap[0].length };
}

function inlineUrl(rest, plain) {
  let cap = URL_RE.exec(rest);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = BACKPEDAL_RE.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (plain) return { html: text, n: cap[0].length };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeAll(text), n: cap[0].length };
  return { html: '<a href="' + escapeAll(cleanHref) + '">' + escapeAll(text) + '</a>', n: cap[0].length };
}

function inlineText(ctx, rest, plain) {
  const cap = INLINE_TEXT_RE.exec(rest);
  if (!cap) return null;
  const escaped = ctx.state.inRawBlock;
  const text = escaped ? cap[0] : decodeNumericRefs(cap[0]);
  return {
    html: plain ? text : (escaped ? cap[0] : escapeNoEncode(text)),
    n: cap[0].length,
    isText: true,
    lastChar: cap[0].slice(-1),
  };
}

// Render one inline run. Shares the parse state across runs (marked does
// the same: only inRawBlock is reset per run, by the caller).
export function renderInline(ctx, src, plain = false) {
  const st = ctx.state;
  const prevLinkParenPossible = st.linkParenPossible;
  st.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return renderInlineInner(ctx, src, plain);
  } finally {
    st.linkParenPossible = prevLinkParenPossible;
  }
}

function renderInlineInner(ctx, src, plain) {
  const st = ctx.state;
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = hasEm ? maskSrc(ctx, src) : src;
  const hint = hasEm ? scanClosers(maskedSrc) : null;
  let out = '';
  let rest = src;
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (rest) {
    if (rest.length < srcLength) srcLength = rest.length;
    else throw new Bail();
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const c = rest.charCodeAt(0);
    let r = null;
    if (c === 92) { // backslash: escape, then hard break
      r = inlineEscape(rest, plain) || inlineBr(rest, plain);
    } else if (c === 60) { // <: tag, then autolink
      r = inlineTag(ctx, rest) || inlineAutolink(rest, plain);
    } else if (c === 91 || c === 33) { // [ or !: link, then reference link
      r = inlineLink(ctx, rest, plain) || inlineReflink(ctx, rest, plain);
    } else if (c === 42) { // *: emphasis
      r = inlineEmStrong(ctx, rest, maskedSrc, prevChar, hint, plain);
    } else if (c === 95) { // _: emphasis, then an email autolink may start here
      r = inlineEmStrong(ctx, rest, maskedSrc, prevChar, hint, plain);
      if (!r && !st.inLink) r = inlineUrl(rest, plain);
    } else if (c === 96) { // `: code span
      r = inlineCodespan(rest, plain);
    } else if (c === 126) { // ~: strikethrough
      r = inlineDel(ctx, rest, maskedSrc, prevChar, hint, plain);
    } else if (c === 32) { // space: hard break
      r = inlineBr(rest, plain);
    } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 43 || c === 45) {
      // a letter, digit, '.', '+' or '-': extended autolink (unless in a link)
      if (!st.inLink) r = inlineUrl(rest, plain);
    }
    if (!r) r = inlineText(ctx, rest, plain);
    if (!r) throw new Bail();
    out += r.html;
    if (r.isText) {
      if (r.lastChar !== '_') prevChar = r.lastChar;
      keepPrevChar = true;
    }
    rest = rest.substring(r.n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering: a port of marked 18.1.3's Parser + Renderer, walking the
// descriptors the scanner produced. A block whose fast render fails falls
// back to the vendored marked on that block alone (with the document's link
// definitions prepended, so references resolve); `text` blocks cannot fall
// back that way (marked would wrap them in <p>), so their failure falls
// back the whole document instead.
// ---------------------------------------------------------------------------

function checkboxHtml(checkbox) {
  return '<input ' + (checkbox.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(b) {
  const langString = (b.lang || '').match(OTHER.notSpaceStart)?.[0];
  const code = b.text ? b.text.replace(OTHER.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeAll(code) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeNoEncode(langString) + '">'
    + escapeAll(code) + '</code></pre>\n';
}

function renderTableCell(ctx, cell, isHeader) {
  const content = renderInline(ctx, cell.text);
  const type = isHeader ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(ctx, b) {
  let cell = '';
  for (const h of b.header) cell += renderTableCell(ctx, h, true);
  let header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of b.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(ctx, c, false);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderList(ctx, b) {
  let body = '';
  for (const item of b.items) {
    body += '<li>' + renderBlocks(ctx, item.tokens) + '</li>\n';
  }
  const type = b.ordered ? 'ol' : 'ul';
  const startAttr = (b.ordered && b.start !== 1) ? (' start="' + b.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlock(ctx, b) {
  switch (b.t) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'heading':
      return `<h${b.depth}>${renderInline(ctx, b.text)}</h${b.depth}>\n`;
    case 'code':
      return renderCode(b);
    case 'paragraph': {
      const lead = b.lead ? checkboxHtml(b.lead) : '';
      const text = b.lead ? b.text.replace(OTHER.listReplaceTask, '') : b.text;
      return '<p>' + lead + renderInline(ctx, text) + '</p>\n';
    }
    case 'text': {
      const lead = b.lead ? checkboxHtml(b.lead) : '';
      const text = b.lead ? b.text.replace(OTHER.listReplaceTask, '') : b.text;
      return lead + renderInline(ctx, text);
    }
    case 'html':
      return b.text;
    case 'def':
      return '';
    case 'table':
      return renderTable(ctx, b);
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(ctx, b.tokens) + '</blockquote>\n';
    case 'list':
      return renderList(ctx, b);
    case 'checkbox':
      return checkboxHtml(b);
    default:
      throw new Bail();
  }
}

// Blocks whose marked.parse rendering is provably the same standalone as
// in the document: every block type except `text` (marked would wrap it in
// <p>), `space`, `def` and `checkbox` (which render as '').
const FALLBACK_BLOCKS = new Set(['paragraph', 'heading', 'code', 'table', 'blockquote', 'list', 'html', 'hr']);

function renderBlocks(ctx, blocks) {
  let out = '';
  for (const b of blocks) {
    const stateBefore = { ...ctx.state };
    try {
      out += renderBlock(ctx, b);
      stats.fastBlocks++;
    } catch (e) {
      if ((e && e.__bail) || e instanceof Error) {
        if (FALLBACK_BLOCKS.has(b.t)) {
          ctx.state = stateBefore;
          stats.fallbackBlocks++;
          out += marked.parse(ctx.defText + b.raw);
          continue;
        }
      }
      throw e;
    }
  }
  return out;
}
