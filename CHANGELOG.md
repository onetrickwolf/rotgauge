# Changelog

Score weights can change between minor versions. Run `--ratchet` after upgrading so `--check` deltas stay meaningful; when weights went up, `--save-baseline` resets.

## 0.9.0 (2026-11-06)

- `--ratchet` tightens the baseline and never loosens it: every scored file with no entry is added at its current score, an entry whose file now scores below it is lowered, an entry whose file is no longer scored is dropped, none is raised. `--save-baseline` stays the reset that accepts every current score. A project no longer needs its own "rebaselines only go down" script.
- `--check` holds a file with no baseline entry to the bands as if it were born green: a new green file costs nothing, one born yellow or red fails until a seam is extracted or `--ratchet` records it. New files used to pass free, so a repo could rot by birth.
- `.rotgauge.json` `docs.ratchet`: `totalTokens` becomes a record rather than a ceiling. `--ratchet` writes the current docs total into it whenever that is lower (or the key is unset), nothing raises it but a hand edit, and `--check` fails any growth. Every addition to the docs is a trade. The number is replaced in place, so the owner's formatting survives.
- A failing `--check` ends with one line of advice per kind of failure (code, new file, doc, budget, docs total, location): what to do, said at the moment it is tripped instead of on every turn from a rules file. Doc findings name the tokens and stale refs behind the score.
- The default report is the short one. A table under thirty rows prints whole; past that, code shows every yellow and red file and docs show the top ten plus any that is stale, over budget, out of place or auto-loaded, each table saying how many rows it left out. `--all` prints every row. On a 1,233-file repo the report went from 1,316 lines to 50.
- `--init` sets a project up in one command and is safe to rerun after an upgrade: a `.rotgauge.json` with defaults when there is none (AGENTS.md and CLAUDE.md capped at 1,500 tokens, the docs total ratcheted), a two-sentence block in AGENTS.md (or CLAUDE.md, or a new AGENTS.md) between markers a rerun refreshes, then `--ratchet`. A config it finds is kept; the run names what the defaults would add.
- `.rotgauge.json` `include`: paths scanned on every run as if named on the command line, for a dot-directory (`.agents/skills`) or a skipped one that the scan should still cover.
- A doc path written beside a commit id (`bbc5b45:docs/old.md`) is history, not a stale ref.
- Three pointers weigh less than the units they passed for: a type-only import (`import type`, or every specifier `type`) counts a quarter of a value import, a re-export (`export { x } from`, `export *`) a third of an export, and a callback written inline as a call argument or JSX attribute a third of a function. Composition roots, barrels and test files stop scoring as hubs, and extracting a seam no longer costs more than it saves. `--json` carries `typeImports`, `reExports` and `callbacks`. Scores only move down, so a baseline that only lowers entries absorbs the upgrade; otherwise re-run `--save-baseline`.
- `--check` reads the bands. A green code file may grow; one that turns yellow or red fails by its whole rise, whatever the threshold; from yellow up, rising more than the threshold fails. Docs keep the plain delta. The failure names the band. On a 938-file TypeScript repo the old rule had 75 files within one edit of the +5 gate, 69 of them green; the band rule leaves six.

## 0.8.0 (2026-09-16)

- `.rotgauge.json` gains `"docs"`: absolute doc budgets that `--check` enforces on top of the delta. `allow` globs say where docs may live, `budgets` cap estimated tokens per glob (first match wins), `totalTokens` caps the scanned set. A new doc has no baseline entry and slipped past the delta gate; a cap catches it. The docs table gains a Budget column, `--json` carries `allowed` / `budgetTokens` / `overBudget`, `--agent` names the findings, and exempt docs are named rather than gated. Scores are unchanged; no rebaseline needed.

## 0.7.0 (2026-09-01)

First public release.

- TypeScript and JSX are parsed as written instead of being transpiled first. Function lengths are real source lines, an enum no longer shows up as module mutable state, exported types, interfaces, and enums count as exports, and type-only imports count toward fan-out. TS scores move a little, mostly up on types-heavy files. Re-run `--save-baseline`.
- Runs on Node 20+ as well as Bun, with identical output. `npx rotgauge` works.
- The parser is Babel's, replacing both acorn and Bun.Transpiler. JSX in plain `.js` files parses instead of being skipped.
- File discovery and score ties are sorted by name, so results are identical across runtimes and filesystems.

## 0.6.0 (2026-09-01)

- The single-file CLI is split into `src/` modules by concern (cli, config, files, metrics, score, scan, docs, history, output). `rotgauge.js` stays the executable and re-exports everything.
- The report ends in a two-line footer instead of a 28-line legend, which was half the tokens of a typical run. Column meanings moved to `--help`. `--agent` guidance is three bullets.
- `--json --check` and `--agent --check` keep stdout clean. The check summary and exemption notes go to stderr in those modes, so the output still parses.
- `.rotgauge.json` gains `"skip"`: directory names added to the built-in skip list, matched at any depth. The built-in list drops the project-specific `reference`, `archive`, and `dist-shell` entries.
- Docs: a bare extension in backticks (`.md`, `.ts`) is no longer read as a path reference. Staleness checks cover source files in more languages: Java, Kotlin, Swift, C and C++, C#, PHP, Dart, Scala, Lua, Elixir, Zig, shell, Vue, Svelte, MDX.
- The version is read from package.json. There is no separate constant to drift.
- README screenshots are rebuilt from a demo project by `bun run screenshots`.
- MIT license, package metadata, and a CI workflow that runs the tests and gates rotgauge with itself.

## 0.5.0 (2026-08-27)

- `--exempt <globs>` and `.rotgauge.json`: files the delta gate does not track. They are still scanned and scored, but `--check` never counts them and names any that would have failed, and `--save-baseline` writes them no entry.
- `--quiet` drops the tables for CI logs. `--check` prints a one-line clean summary. `--json` marks exempt entries.
- `--check` counts docs: a markdown file that balloons fails the gate.

## 0.4.1 (2026-07-25)

- Dead `file:line` anchors count as stale. An anchor citing a line past the end of the file is provably dead. An anchor that merely moved is not guessed at. `--agent` flags docs leaning on three or more anchors.

## 0.4.0 (2026-07-20)

- Git history analysis: one repo-level row estimating what an agent pays to read history (median commit message tokens, tiny-commit ratio, `git log -20` glance cost). Display only, never baselined. `--no-history` turns it off.
- Skip `out` and other build output directories.

## 0.3.0 (2026-07-12)

- Markdown docs analysis: token weight (auto-loaded CLAUDE.md and AGENTS.md and their @imports weighted 4x), stale source-path references, and code mirroring. Docs join the baseline. `--no-docs` opts out.

## 0.2.0 (2026-07-12)

- Closure-state metrics (CLets and CMuts): mutable bindings declared inside functions of 100 lines or more weigh like module state.
- `--agent` dominant signals rank contributions by ratio to the repo median, so per-file outliers surface instead of the function-size term every file shares.
- Score weights changed. Re-save baselines.

## 0.1.0 (2026-07-12)

- Initial release: AST-based per-file scores (module and instance mutable state, fan-out and fan-in, nesting, wide interfaces), baseline plus `--check` for CI, `--agent` markdown summary, severity-colored TTY output.
