# Changelog

Score weights can change between minor versions. Re-run `--save-baseline` after upgrading so `--check` deltas stay meaningful.

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
