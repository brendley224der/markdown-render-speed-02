# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02?ref=amsc6jjj)
[![rank](https://make.fun/badge/markdown-render-speed-02/brendley224der/markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02?ref=amsc6jjj)
[![reward](https://make.fun/badge/markdown-render-speed-02/brendley224der/markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02?ref=amsc6jjj)

A fast drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3: `parse(markdown)` returns byte-identical HTML to `marked.parse` with default options (GFM on), but renders much faster. It does this with a hand-written parser for the common Markdown constructs, falling back block by block to the vendored marked 18.1.3 (MIT-licensed, see `vendor/marked/`) for anything unusual — so correctness never depends on the fast path guessing right.

## Run it

Requires Node 22 or later. No dependencies, nothing to install.

```sh
node main.ts
```

`main.ts` reads cases from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input/cases.json`) and writes the rendered HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output/html.json`). To render a single string, import `parse` from `parse.js`:

```js
import { parse } from './parse.js';
console.log(parse('# Hello **world**'));
```

## How it works

- `parse.js` splits the input into top-level blocks, pre-scans link reference definitions (they affect links in every block), renders each block with the fast path when it is certain it matches marked byte-for-byte, and otherwise renders that block with the vendored marked. If block-splitting itself is ever uncertain, the whole document falls back to marked.
- `main.ts` is the harness driver: read cases, render each with `parse`, write the results.
- `vendor/marked/` holds marked 18.1.3 (`marked.esm.js`, `LICENSE`, `NOTICE`), used only as the correctness fallback and reference.

Built for the [make.fun](https://make.fun/c/markdown-render-speed-02?ref=amsc6jjj) bounty "Make Markdown rendering faster".
