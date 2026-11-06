// Command line: argument parsing, usage text, and the main run.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { BASELINE_FILE, CONFIG_FILE, splitGlobs, loadConfig, makeExemptMatcher } from './config.js';
import { SKIP_DIRS, DOC_EXT_RE, expandPaths } from './files.js';
import { scanFiles } from './scan.js';
import { scanDocs } from './docs.js';
import { applyDocBudgets } from './budgets.js';
import { analyzeGitHistory, HISTORY_WINDOW, GLANCE_COMMITS, TINY_COMMIT_LINES } from './history.js';
import { CLOSURE_FN_LINES } from './metrics.js';
import { runCheck } from './check.js';
import { runRatchet } from './ratchet.js';
import { initProject } from './init.js';
import {
  printTable, printDocsTable, printHistoryTable, printAgentOutput, reportFooter, toJSONEntry, toDocJSONEntry,
} from './output.js';

// package.json is the only place the version lives: a duplicated constant
// shipped 0.4.1 still announcing itself as 0.4.0.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;

export function parseArgs(argv) {
  const opts = {
    json: false, saveBaseline: false, ratchet: false, init: false, all: false,
    check: false, checkThreshold: 0,
    agent: false, docs: true, history: true, help: false, version: false, paths: [],
    exempt: [], quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--save-baseline') opts.saveBaseline = true;
    else if (a === '--ratchet') opts.ratchet = true;
    else if (a === '--init') { opts.init = true; opts.ratchet = true; }
    else if (a === '--all') opts.all = true;
    else if (a === '--agent') opts.agent = true;
    else if (a === '--no-docs') opts.docs = false;
    else if (a === '--no-history') opts.history = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else if (a === '--check') {
      opts.check = true;
      // Only consume the next token as a threshold if it is strictly numeric;
      // anything else (like a file path) stays a path and the threshold is 0.
      const next = argv[i + 1];
      if (next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
        opts.checkThreshold = Number(next);
        i++;
      }
    } else if (a === '--exempt' || a.startsWith('--exempt=')) {
      let value;
      if (a.includes('=')) value = a.slice(a.indexOf('=') + 1);
      else { value = argv[i + 1]; i++; }
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new Error('--exempt needs a comma-separated list of globs, e.g. --exempt "module_bindings/**,*.generated.ts"');
      }
      opts.exempt.push(...splitGlobs(value));
    } else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a} (see rotgauge --help)`);
    } else {
      opts.paths.push(a);
    }
  }
  return opts;
}

export function usage() {
  return `rotgauge ${VERSION}: context-rot smoke test

Usage: rotgauge [paths...] [flags]

  paths              Files or directories to scan (default: current directory)

Flags:
  --all              Every row; the default report shows the rows worth a look
  --json             Emit results as JSON
  --agent            Emit a markdown summary for pasting into agent context (CLAUDE.md etc.)
  --no-docs          Skip markdown docs (context-weight) analysis
  --no-history       Skip git history (agent-glance cost) analysis
  --init             Set a project up: ${CONFIG_FILE} with defaults when there is none, a short
                     block in AGENTS.md (or CLAUDE.md) between markers a rerun refreshes, then --ratchet
  --ratchet          Tighten ${BASELINE_FILE}: add new files at their score, lower entries
                     whose files improved, drop gone ones, raise none; with docs.ratchet, record
                     the docs total in ${CONFIG_FILE} the same way
  --save-baseline    Write ${BASELINE_FILE} with every current score (accepts every rise)
  --check [n]        Exit 1 if a code file turned yellow or red (or was born so), or a yellow/red
                     file (or any doc) rose more than n over baseline (default 0); each failure
                     comes with what to do about it
  --exempt <globs>   Comma-separated globs --check skips (still scored, no baseline entry)
  -q, --quiet        No tables, only --check results and exemption notes
  -v, --version      Print version
  -h, --help         Show this help

Config: a ${CONFIG_FILE} in the working directory carries the same exemptions
(unioned with the flag), directory names to skip on top of the built-in list
(node_modules, dist, build, test, ...), paths to include on every run even
when discovery would skip them, and doc budgets, so none of it lives on the
command line:
  { "exempt": ["module_bindings/**", "*.generated.ts"], "skip": ["archive"], "include": [".agents/skills"],
    "docs": { "allow": ["README.md", "docs/**", "**/README.md"],
              "budgets": [{ "match": "AGENTS.md", "tokens": 1500 }, { "match": "**/README.md", "tokens": 900 }],
              "totalTokens": 12000, "ratchet": true } }
Doc budgets are absolute caps --check enforces on top of the delta: a doc
outside "allow", over the first "budgets" pattern it matches, or a scanned
set over "totalTokens" fails, new file or not. With "ratchet", --ratchet
records the docs total in "totalTokens" whenever it is lower, so the docs
only shrink and every addition is a trade. The docs table gains a Budget
column when any are set.
Globs: * within a path segment, ** across segments, ? one character. A pattern
matches at any depth unless it starts with / (anchored to the working directory).
Naming a skipped directory as a path still scans it.

Scores: green under 40, yellow from 40, red from 60. Around 60 a file would
benefit from extraction. Shared mutable state carries the heaviest weights.
--check lets a green file grow; turning yellow or red fails by the whole rise.

Code columns:
  LOC / TplLOC         Non-blank non-comment lines / lines inside big template literals (discounted)
  FanOut / FanIn       Local code imports out / other scanned files importing this one
  Exp                  Exports
  MLets / MMuts        Module-scope let and var bindings, and mutations of them (heaviest weight)
  CLets / CMuts        Mutable bindings declared in functions of ${CLOSURE_FN_LINES}+ lines, and their mutations
  COMut                Mutations of module-scope const objects (scene.background = ...)
  ThisM                this.* mutations (instance state)
  Lets / Muts          All mutable bindings / all mutations
  PMut                 Parameter property mutations (state.foo = bar where state is a param)
  DsW / MaxP           Widest destructure / most parameters (wide interfaces)
  Cmt%                 Comment ratio (big files with few comments get a small penalty)
  Fns / FnCplx / Nest  Function count / worst function (length x nesting) / deepest control nesting
  IMCalls              Method calls on imported bindings (display only)
  ICSS / IHnd          Inline CSS lines / inline event handlers (HTML)

Doc columns:
  LOC / FenceL         Non-blank lines / lines inside fenced code blocks
  Words / ~Tokens      Word count / estimated tokens (about 4 chars each)
  Refs / Stale         Repo paths the doc cites / cited paths that no longer exist, plus file:line anchors past EOF
  Mirror               Live source files the doc catalogs (docs that restate code go stale fastest)
  Auto                 Loaded into agent context every turn (CLAUDE.md, AGENTS.md, their @imports), weighs 4x

History columns (display only, never baselined):
  Commits / MsgTok     Recent non-merge commits analyzed (up to ${HISTORY_WINDOW}) / median commit message tokens
  Tiny%                Commits changing fewer than ${TINY_COMMIT_LINES} lines
  Glance               Estimated tokens of git log -${GLANCE_COMMITS}, what one look at history costs`;
}

// --- Main ---

export function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`rotgauge: ${e.message}`);
    process.exit(1);
  }

  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.version) {
    console.log(VERSION);
    return;
  }

  // Status lines share stdout with the tables, but under --json/--agent
  // stdout is the document itself: anything else there corrupts it.
  const note = opts.json || opts.agent ? console.error : console.log;
  const cwd = process.cwd();
  let config;
  try {
    if (opts.init) for (const line of initProject(cwd)) note(line);
    config = loadConfig(cwd);
  } catch (e) {
    console.error(`rotgauge: ${e.message}`);
    process.exit(1);
  }
  const isExempt = makeExemptMatcher([...config.exempt, ...opts.exempt]);
  const skipDirs = new Set([...SKIP_DIRS, ...config.skip]);
  const roots = opts.paths.length > 0 ? opts.paths : ['.'];
  const filePaths = [...new Set(expandPaths([...roots, ...config.include], cwd, skipDirs))];
  const results = scanFiles(filePaths.filter((p) => !DOC_EXT_RE.test(p)), cwd);
  const docResults = opts.docs ? scanDocs(filePaths.filter((p) => DOC_EXT_RE.test(p)), cwd) : [];
  let budgets = applyDocBudgets(docResults, config.docs);
  const history = opts.history ? analyzeGitHistory(cwd) : null;
  const everything = [...results, ...docResults];

  if (everything.length === 0) {
    console.error('rotgauge: no analyzable files found.');
    process.exit(1);
  }

  const baselinePath = resolve(cwd, BASELINE_FILE);

  if (opts.saveBaseline) {
    const baseline = {};
    for (const r of everything) if (!isExempt(r.name)) baseline[r.name] = { score: r.score };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  }
  if (opts.ratchet) {
    config = runRatchet({ cwd, everything, docResults, isExempt, config, note });
    budgets = applyDocBudgets(docResults, config.docs); // the total may have moved
  }

  let baseline = null;
  if (opts.check) {
    if (!existsSync(baselinePath)) {
      console.error(`No baseline file found at ${baselinePath}. Run --ratchet (or --save-baseline) first.`);
      process.exit(1);
    }
    baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  }

  if (opts.agent) {
    printAgentOutput(results, docResults, history);
  } else if (opts.json) {
    const entries = [...results.map((r) => toJSONEntry(r, baseline)), ...docResults.map((r) => toDocJSONEntry(r, baseline))];
    for (const e of entries) if (isExempt(e.file)) e.exempt = true;
    if (history) {
      entries.push({
        type: 'history',
        commits: history.commits,
        medianMsgTokens: history.medianMsgTokens,
        tinyCommits: history.tinyCommits,
        tinyRatio: Math.round(history.tinyRatio * 1000) / 1000,
        glanceTokens: history.glanceTokens,
        score: history.score,
      });
    }
    console.log(JSON.stringify(entries, null, 2));
  } else if (!opts.quiet) {
    if (results.length > 0) printTable(results, baseline, { all: opts.all });
    if (docResults.length > 0) {
      if (results.length > 0) console.log('');
      printDocsTable(docResults, baseline, budgets, { all: opts.all });
    }
    if (history) {
      if (results.length > 0 || docResults.length > 0) console.log('');
      printHistoryTable(history);
    }
    console.log('');
    console.log(reportFooter(results, docResults, history));
  }

  if (opts.check && baseline) {
    const code = runCheck({
      everything, docResults, baseline, budgets, docs: config.docs, threshold: opts.checkThreshold, isExempt, note,
    });
    if (code !== 0) process.exit(code);
  } else if (opts.init) {
    note(`Next: rotgauge --check 5 (the gate; CI runs it the same way). Commit ${CONFIG_FILE} and ${BASELINE_FILE}.`);
  }
}
