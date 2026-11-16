# markdown-render-speed-02-v4

[![make.fun](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blue)](https://make.fun/c/markdown-render-speed-02)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![speed](https://img.shields.io/badge/speed-faster--than--marked-orange.svg)](./parse.js)

A fast, dependency-free Markdown renderer that returns exactly the HTML
marked 18.1.3 renders with its default options (GFM on). Built from scratch
for the make.fun competition "Make Markdown rendering faster".

- `parse.js` — the renderer: `parse(markdown)` returns the HTML string.
- `main.ts` — the driver the harness runs: reads `cases.json`, writes `html.json`.

## Verification

Local estimates only (not platform scores): the entry is checked against the
practice set (680 CommonMark spec examples + 40 generated documents) with
`grade-local` before any submission.

## Referral

Made with Muse. Referral code: `ebv85brk`
