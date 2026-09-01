// Command line: argument parsing, usage text, and the main run.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { BASELINE_FILE, CONFIG_FILE, splitGlobs, loadConfig, makeExemptMatcher } from './config.js';
import { SKIP_DIRS, DOC_EXT_RE, expandPaths } from './files.js';
import { scanFiles } from './scan.js';
import { scanDocs } from './docs.js';
import { analyzeGitHistory, HISTORY_WINDOW, GLANCE_COMMITS, TINY_COMMIT_LINES } from './history.js';
import { CLOSURE_FN_LINES } from './metrics.js';
import {
  printTable, printDocsTable, printHistoryTable, printAgentOutput, reportFooter, toJSONEntry, toDocJSONEntry,
} from './output.js';

// package.json is the only place the version lives: a duplicated constant
// shipped 0.4.1 still announcing itself as 0.4.0.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;

export function parseArgs(argv) {
  const opts = {
    json: false, saveBaseline: false, check: false, checkThreshold: 0,
    agent: false, docs: true, history: true, help: false, version: false, paths: [],
    exempt: [], quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--save-baseline') opts.saveBaseline = true;
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
  --json             Emit results as JSON
  --agent            Emit a markdown summary for pasting into agent context (CLAUDE.md etc.)
  --no-docs          Skip markdown docs (context-weight) analysis
  --no-history       Skip git history (agent-glance cost) analysis
  --save-baseline    Write ${BASELINE_FILE} with current scores
  --check [n]        Exit 1 if any file's score rose more than n over baseline (default 0)
  --exempt <globs>   Comma-separated globs --check skips (still scored, no baseline entry)
  -q, --quiet        No tables, only --check results and exemption notes
  -v, --version      Print version
  -h, --help         Show this help

Config: a ${CONFIG_FILE} in the working directory carries the same exemptions
(unioned with the flag) plus directory names to skip on top of the built-in
list (node_modules, dist, build, test, ...), so long lists stay off the
command line:
  { "exempt": ["module_bindings/**", "*.generated.ts"], "skip": ["archive"] }
Globs: * within a path segment, ** across segments, ? one character. A pattern
matches at any depth unless it starts with / (anchored to the working directory).
Naming a skipped directory as a path still scans it.

Scores: green under 40, yellow from 40, red from 60. Around 60 a file would
benefit from extraction. Shared mutable state carries the heaviest weights.

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

  const cwd = process.cwd();
  let config;
  try {
    config = loadConfig(cwd);
  } catch (e) {
    console.error(`rotgauge: ${e.message}`);
    process.exit(1);
  }
  const isExempt = makeExemptMatcher([...config.exempt, ...opts.exempt]);
  const skipDirs = new Set([...SKIP_DIRS, ...config.skip]);
  const filePaths = expandPaths(opts.paths, cwd, skipDirs);
  const results = scanFiles(filePaths.filter((p) => !DOC_EXT_RE.test(p)), cwd);
  const docResults = opts.docs ? scanDocs(filePaths.filter((p) => DOC_EXT_RE.test(p)), cwd) : [];
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

  let baseline = null;
  if (opts.check) {
    if (!existsSync(baselinePath)) {
      console.error(`No baseline file found at ${baselinePath}. Run --save-baseline first.`);
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
    if (results.length > 0) printTable(results, baseline);
    if (docResults.length > 0) {
      if (results.length > 0) console.log('');
      printDocsTable(docResults, baseline);
    }
    if (history) {
      if (results.length > 0 || docResults.length > 0) console.log('');
      printHistoryTable(history);
    }
    console.log('');
    console.log(reportFooter(results, docResults, history));
  }

  if (opts.check && baseline) {
    // Status lines share stdout with the tables, but under --json/--agent
    // stdout is the document itself: anything else there corrupts it.
    const note = opts.json || opts.agent ? console.error : console.log;
    let failures = 0;
    let exemptCount = 0;
    const exemptOver = [];
    for (const r of everything) {
      const exempt = isExempt(r.name);
      if (exempt) exemptCount++;
      const base = baseline[r.name];
      if (!base) continue; // new files don't count as failure
      const delta = r.score - base.score;
      if (delta > opts.checkThreshold) {
        if (exempt) {
          exemptOver.push(`${r.name}: score ${r.score} is +${delta} over baseline ${base.score} (exempt)`);
          continue;
        }
        failures++;
        console.error(`${r.name}: score ${r.score} is +${delta} over baseline ${base.score} (threshold ${opts.checkThreshold})`);
      }
    }
    // Exemptions are never silent: name what the gate let through.
    for (const line of exemptOver) note(line);
    if (failures > 0) {
      console.error(`\n${failures} file(s) exceeded the delta threshold of ${opts.checkThreshold}.`);
      process.exit(1);
    }
    const checked = everything.length - exemptCount;
    note(`rotgauge --check: clean (${checked} file(s) checked at +${opts.checkThreshold} over baseline${exemptCount ? `, ${exemptCount} exempt` : ''})`);
  }
}
