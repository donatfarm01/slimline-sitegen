# slimline-sitegen

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/donatfarm01/slimline-sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/donatfarm01/slimline-sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Slimline is a hand-rolled, dependency-free static site generator written from makefun-site 1.0.0's spec: a single-pass front-matter + Markdown-subset parser, each template compiled once to a closure, and a single string-builder output. It returns byte-for-byte what makefun-site returns for every case, and it is faster than the house baseline on the same machine.

## Run it

```sh
node main.ts
```

`main.ts` reads `/input/cases.json` (a JSON array of `{id, input}`), answers each case with `run` from `solve.js`, and writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k0gc9cbf&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
