// Output: the three tables, the --agent markdown summary, and --json entries.

import { dominantSignals } from './score.js';
import { docSignals } from './docs.js';
import { GLANCE_COMMITS, TINY_COMMIT_LINES } from './history.js';

function withBaseline(entry, name, score, baseline) {
  if (baseline) {
    const base = baseline[name];
    entry.baselineScore = base ? base.score : null;
    entry.delta = base ? score - base.score : null;
  }
  return entry;
}

export function toJSONEntry(r, baseline) {
  const entry = {
    type: 'code',
    file: r.name,
    loc: r.loc,
    templateLiteralLOC: r.templateLiteralLOC,
    effectiveLOC: Math.max(0, r.loc - r.templateLiteralLOC),
    fanOut: r.fanOut,
    fanIn: r.fanIn,
    exports: r.exports,
    moduleLets: r.moduleLets,
    moduleMutations: r.moduleMutations,
    closureLets: r.closureLets,
    closureMutations: r.closureMutations,
    constObjMutations: r.constObjMutations,
    thisMutations: r.thisMutations,
    lets: r.letCount,
    mutations: r.mutations,
    paramPropMutations: r.paramPropMutations,
    maxDestructureWidth: r.maxDestructureWidth,
    maxParamCount: r.maxParamCount,
    commentLines: r.commentLines,
    commentRatio: Math.round(r.commentRatio * 1000) / 1000,
    functions: r.functions,
    maxFnLength: r.maxFnLength,
    maxFnComplexity: Math.round(r.maxFnComplexity),
    maxFnNesting: r.maxFnNesting,
    maxNesting: r.maxNesting,
    importMethodCalls: r.importMethodCalls,
    inlineCssLOC: r.inlineCssLOC,
    inlineHandlers: r.inlineHandlers,
    score: r.score,
  };
  return withBaseline(entry, r.name, r.score, baseline);
}

export function toDocJSONEntry(r, baseline) {
  const entry = {
    type: 'doc',
    file: r.name,
    loc: r.loc,
    fenceLOC: r.fenceLOC,
    words: r.words,
    tokens: r.tokens,
    headings: r.headings,
    refs: r.refs,
    liveRefs: r.liveRefs,
    staleRefs: r.staleRefs,
    mirrorRefs: r.mirrorRefs,
    autoLoaded: r.autoLoaded,
    score: r.score,
  };
  return withBaseline(entry, r.name, r.score, baseline);
}

// Guidance is one short footer for the whole report. Anything longer is
// boilerplate an agent pays for on every run, which is the very tax this tool
// measures. Column meanings live in --help, where they are read once.
const SCORE_GUIDANCE = 'Scores estimate edit hazard, not quality. 60+ means look before you edit.';
const CODE_GUIDANCE = 'Mutable state (MLets, CLets, ThisM) is the signal that matters most.';
const DOC_GUIDANCE = 'Docs weigh by tokens, auto-loaded ones 4x, plus stale refs.';
const HISTORY_GUIDANCE = 'History is display only and never baselined.';

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

export function reportFooter(results, docResults, history) {
  const parts = [SCORE_GUIDANCE];
  if (results.length > 0) parts.push(CODE_GUIDANCE);
  if (docResults.length > 0) parts.push(DOC_GUIDANCE);
  if (history) parts.push(HISTORY_GUIDANCE);
  parts.push('Column key: rotgauge --help');
  return wrap(parts.join(' '), 100).map((l) => ` ${l}`).join('\n');
}

// --agent output gets pasted into a CLAUDE.md and read on every turn, so it
// carries three bullets at most.
const AGENT_GUIDANCE = 'Scores estimate how hard a file is to edit correctly, not quality. 60+ or rising means look first, not refactor.';
const AGENT_CODE_GUIDANCE = 'Module, closure, and instance mutable state (MLets, CLets, ThisM) is where edits go wrong most.';
const AGENT_DOC_GUIDANCE = 'Auto-loaded docs cost their tokens every turn. Keep them to what the code cannot show, and fix stale refs.';

function fmtTokens(n) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

function historySummaryLine(h) {
  return `\`git log -${GLANCE_COMMITS}\` is about ${fmtTokens(h.glanceTokens)} tokens per glance; ` +
    `median commit message ${h.medianMsgTokens} tokens; ` +
    `${Math.round(h.tinyRatio * 100)}% of the last ${h.commits} commits touch <${TINY_COMMIT_LINES} lines`;
}

export function printAgentOutput(results, docResults, history) {
  const signalsFor = dominantSignals(results);
  console.log('### Context-rot smoke test (rotgauge)');
  if (results.length > 0) {
    console.log('');
    console.log('| File | Score | Dominant signals |');
    console.log('| --- | ---: | --- |');
    for (const r of results.slice(0, 8)) {
      console.log(`| ${r.name} | ${r.score} | ${signalsFor(r).join(', ') || '-'} |`);
    }
    if (results.length > 8) console.log(`| _...${results.length - 8} more files_ | | |`);
  }
  if (docResults.length > 0) {
    console.log('');
    console.log('**Context docs (markdown):**');
    console.log('');
    console.log('| Doc | Score | Signals |');
    console.log('| --- | ---: | --- |');
    for (const d of docResults.slice(0, 5)) {
      console.log(`| ${d.name} | ${d.score} | ${docSignals(d).join(', ') || '-'} |`);
    }
    if (docResults.length > 5) console.log(`| _...${docResults.length - 5} more docs_ | | |`);
  }
  if (history) {
    console.log('');
    console.log(`**Git history:** ${historySummaryLine(history)} (score ${history.score})`);
  }
  console.log('');
  console.log(`- ${AGENT_GUIDANCE}`);
  if (results.length > 0) console.log(`- ${AGENT_CODE_GUIDANCE}`);
  if (docResults.length > 0) console.log(`- ${AGENT_DOC_GUIDANCE}`);
}

// Color on interactive terminals only; FORCE_COLOR=1 / NO_COLOR override.
const useColor = process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR === '1' || (typeof process.stdout.isTTY === 'boolean' && process.stdout.isTTY));

function paint(s, code) {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

// Severity bands: >=60 look-at-this red, >=40 drifting yellow, else green.
function scoreCode(score) {
  return score >= 60 ? '31' : score >= 40 ? '33' : '32';
}

function deltaCode(s) {
  if (s === 'new') return '36';
  if (s.startsWith('+')) return '31';
  if (s.startsWith('-')) return '32';
  return '2';
}

export function printTable(results, baseline) {
  const headers = ['File', 'LOC', 'TplLOC', 'FanOut', 'FanIn', 'Exp', 'MLets', 'MMuts', 'CLets', 'CMuts', 'COMut', 'ThisM', 'Lets', 'Muts', 'PMut', 'DsW', 'MaxP', 'Cmt%', 'Fns', 'FnCplx', 'Nest', 'IMCalls', 'ICSS', 'IHnd', 'Score'];
  if (baseline) headers.push('Delta');

  const rows = results.map((r) => {
    const row = [
      r.name, r.loc, r.templateLiteralLOC, r.fanOut, r.fanIn, r.exports,
      r.moduleLets, r.moduleMutations, r.closureLets, r.closureMutations,
      r.constObjMutations, r.thisMutations,
      r.letCount, r.mutations, r.paramPropMutations, r.maxDestructureWidth, r.maxParamCount,
      Math.round(r.commentRatio * 100) + '%',
      r.functions, Math.round(r.maxFnComplexity), r.maxNesting,
      r.importMethodCalls, r.inlineCssLOC, r.inlineHandlers, r.score,
    ];
    if (baseline) {
      const base = baseline[r.name];
      if (!base) row.push('new');
      else {
        const delta = r.score - base.score;
        row.push(delta > 0 ? '+' + delta : delta < 0 ? String(delta) : '=');
      }
    }
    return row;
  });

  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, String(row[i]).length), 0);
    return Math.max(h.length, dataMax);
  });

  const scoreCol = headers.indexOf('Score');
  const deltaCol = baseline ? headers.indexOf('Delta') : -1;

  function formatRow(values, colorize) {
    return ' ' + values
      .map((v, i) => {
        const s = String(v);
        const padded = i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]);
        if (!colorize) return padded;
        if (i === scoreCol && s !== '') return paint(padded, scoreCode(Number(s)));
        if (i === deltaCol && s !== '') return paint(padded, deltaCode(s));
        return padded;
      })
      .join('  ') + ' ';
  }

  const rule = ' ' + widths.map((w) => '─'.repeat(w)).join('──') + ' ';
  console.log(formatRow(headers, false));
  console.log(rule);
  for (const row of rows) console.log(formatRow(row, true));
  console.log(rule);

  const totalLoc = results.reduce((s, r) => s + r.loc, 0);
  const totalComments = results.reduce((s, r) => s + r.commentLines, 0);
  const totalCommentRatio = totalLoc + totalComments > 0 ? totalComments / (totalLoc + totalComments) : 0;
  const sum = (fn) => results.reduce((s, r) => s + fn(r), 0);
  const max = (fn) => results.reduce((mv, r) => Math.max(mv, fn(r)), 0);
  const totals = ['TOTAL',
    totalLoc, sum((r) => r.templateLiteralLOC), sum((r) => r.fanOut), sum((r) => r.fanIn),
    sum((r) => r.exports), sum((r) => r.moduleLets), sum((r) => r.moduleMutations),
    sum((r) => r.closureLets), sum((r) => r.closureMutations),
    sum((r) => r.constObjMutations), sum((r) => r.thisMutations),
    sum((r) => r.letCount), sum((r) => r.mutations), sum((r) => r.paramPropMutations),
    max((r) => r.maxDestructureWidth), max((r) => r.maxParamCount),
    Math.round(totalCommentRatio * 100) + '%',
    sum((r) => r.functions), max((r) => Math.round(r.maxFnComplexity)), max((r) => r.maxNesting),
    sum((r) => r.importMethodCalls), sum((r) => r.inlineCssLOC), sum((r) => r.inlineHandlers),
    Math.round(sum((r) => r.score) / results.length),
  ];
  if (baseline) totals.push('');
  console.log(formatRow(totals, true));

  console.log(`\n ${results.length} files analyzed. Score is avg, FnCplx/Nest/MaxP/DsW are max across all files.`);
}

export function printDocsTable(docResults, baseline) {
  const headers = ['Doc', 'LOC', 'FenceL', 'Words', '~Tokens', 'Refs', 'Stale', 'Mirror', 'Auto', 'Score'];
  if (baseline) headers.push('Delta');

  const rows = docResults.map((r) => {
    const row = [
      r.name, r.loc, r.fenceLOC, r.words, r.tokens,
      r.refs, r.staleRefs, r.mirrorRefs, r.autoLoaded ? 'yes' : '', r.score,
    ];
    if (baseline) {
      const base = baseline[r.name];
      if (!base) row.push('new');
      else {
        const delta = r.score - base.score;
        row.push(delta > 0 ? '+' + delta : delta < 0 ? String(delta) : '=');
      }
    }
    return row;
  });

  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, String(row[i]).length), 0);
    return Math.max(h.length, dataMax);
  });

  const scoreCol = headers.indexOf('Score');
  const staleCol = headers.indexOf('Stale');
  const deltaCol = baseline ? headers.indexOf('Delta') : -1;

  function formatRow(values, colorize) {
    return ' ' + values
      .map((v, i) => {
        const s = String(v);
        const padded = i === 0 ? s.padEnd(widths[i]) : s.padStart(widths[i]);
        if (!colorize) return padded;
        if (i === scoreCol && s !== '') return paint(padded, scoreCode(Number(s)));
        if (i === staleCol && Number(s) > 0) return paint(padded, '31');
        if (i === deltaCol && s !== '') return paint(padded, deltaCode(s));
        return padded;
      })
      .join('  ') + ' ';
  }

  const rule = ' ' + widths.map((w) => '─'.repeat(w)).join('──') + ' ';
  console.log(' Docs (agent-context weight)');
  console.log(formatRow(headers, false));
  console.log(rule);
  for (const row of rows) console.log(formatRow(row, true));
  console.log(rule);
}

export function printHistoryTable(h) {
  const headers = ['Commits', 'MsgTok', 'Tiny%', 'Glance', 'Score'];
  const row = [h.commits, h.medianMsgTokens, Math.round(h.tinyRatio * 100) + '%', h.glanceTokens, h.score];

  const widths = headers.map((hd, i) => Math.max(hd.length, String(row[i]).length));
  const scoreCol = headers.indexOf('Score');
  const formatRow = (values, colorize) => ' ' + values
    .map((v, i) => {
      const padded = String(v).padStart(widths[i]);
      return colorize && i === scoreCol ? paint(padded, scoreCode(Number(v))) : padded;
    })
    .join('  ') + ' ';

  const rule = ' ' + widths.map((w) => '─'.repeat(w)).join('──') + ' ';
  console.log(' Git history (agent-glance cost)');
  console.log(formatRow(headers, false));
  console.log(rule);
  console.log(formatRow(row, true));
  console.log(rule);
}
