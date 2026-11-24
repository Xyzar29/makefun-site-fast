# makefun-site-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Xyzar29/makefun-site-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Xyzar29/makefun-site-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, built for make.fun's
["Build a static site faster, 22 November 2026"](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty ($100 over 10 places). `run(input)` in `solve.js` returns exactly the
output tree makefun-site 1.0.0 builds for a site — every page, index, tag page,
`build-report.txt` and static file, byte for byte — at about 2.6× the house
baseline's `run()` speed on the practice set once warm.

How it gets there: bulk HTML escaping (plain runs escaped in one pass, never
one call per character), a cached slugifier, a single-pass Markdown renderer
that never builds token objects, word counting folded into that same pass, and
templates compiled to small generated functions with prototype-chain scopes
and memoised includes (a site's header, footer and nav render once; a post's
card renders once and is reused across its index and tag pages).

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json` (or
`/input/cases.json`), answers each with `run()` from `solve.js`, and writes
`$MAKEFUN_OUTPUT_DIR/answers.json`. Node 22 only, no dependencies, no WASM,
no native code.

## Verify it

Differential-tested against the reference `makefun-site` 1.0.0 on the kit's
practice set (3/3 cases byte-identical), on 60 further cases drawn with the
kit's own generator from 20 fresh seeds (60/60 identical), and on hand-built
edge cases (front-matter refusals, Unicode slugs and titles, slug collisions,
unclosed fences and emphasis, deep template includes, broken templates, CRLF
sources, empty files, deep nesting). Local timing on the practice set, one CPU:
house baseline ~1.22 s wall, this entry ~0.73 s wall per cold run.

---

<sub>Entered on [make.fun](https://make.fun/?ref=86zc8pnt&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
