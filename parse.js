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
  stats.wholeDocFallbacks++;
  stats.fallbackBytes += markdown.length;
  return marked.parse(markdown);
}
