// `rotgauge --init`: the one-command setup, safe to run again after an
// upgrade. It writes a .rotgauge.json when there is none, puts a short block
// into AGENTS.md (or CLAUDE.md, or a new AGENTS.md) between markers it
// refreshes on the next run, and leaves the baseline to --ratchet, which the
// command runs next. A config it finds is kept as it is: the run names what
// the defaults would add and lets the owner decide.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { CONFIG_FILE, loadConfig } from './config.js';

// The defaults gate what every repo pays for: the always-loaded rules file
// stays under 1,500 tokens and the docs as a whole only shrink. Where docs may
// live (`allow`) and per-folder caps are the owner's call.
export const DEFAULT_CONFIG = {
  skip: [],
  docs: {
    budgets: [{ match: '/AGENTS.md', tokens: 1500 }, { match: '/CLAUDE.md', tokens: 1500 }],
    ratchet: true,
  },
};

// The block is two sentences: how to run the gate and that the baseline only
// tightens. Every other rule arrives with the failure that trips it, so the
// rules file carries nothing an agent has to read on the turns it does not.
export const BLOCK_START = '<!-- rotgauge -->';
export const BLOCK_END = '<!-- /rotgauge -->';
export const BLOCK_TEXT =
  'rotgauge gates edit hazard and doc weight: `rotgauge --check 5` before a commit names each failure and what to do; ' +
  '`rotgauge --ratchet` after a seam or a trim lowers the baseline and docs total, never raises them.';

export function renderBlock() {
  return `${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}`;
}

// Replaces the block between the markers, or appends one after a blank line.
export function placeBlock(source) {
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) return source.slice(0, start) + renderBlock() + source.slice(end + BLOCK_END.length);
  const body = source === '' || source.endsWith('\n') ? source : `${source}\n`;
  return `${body}${body === '' ? '' : '\n'}${renderBlock()}\n`;
}

function missingDefaults(config) {
  const missing = [];
  if (!config.docs) missing.push('"docs" (budgets for AGENTS.md and CLAUDE.md, ratchet)');
  else if (!config.docs.ratchet) missing.push('"docs.ratchet": true');
  return missing;
}

// Returns the lines to print, one per file touched or kept.
export function initProject(cwd) {
  const lines = [];
  const configPath = resolve(cwd, CONFIG_FILE);
  if (existsSync(configPath)) {
    const missing = missingDefaults(loadConfig(cwd));
    lines.push(`${CONFIG_FILE}: kept${missing.length ? `; the defaults would add ${missing.join(' and ')}` : ''}`);
  } else {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    lines.push(`${CONFIG_FILE}: written (AGENTS.md and CLAUDE.md capped at 1,500 tokens; the docs total only moves down)`);
  }
  const rules = ['AGENTS.md', 'CLAUDE.md'].find((name) => existsSync(resolve(cwd, name))) ?? 'AGENTS.md';
  const rulesPath = resolve(cwd, rules);
  const before = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf-8') : '';
  const after = placeBlock(before);
  if (after !== before) writeFileSync(rulesPath, after);
  const did = before === '' ? 'created with the rotgauge block'
    : !before.includes(BLOCK_START) ? 'rotgauge block added'
      : after === before ? 'rotgauge block current' : 'rotgauge block refreshed';
  lines.push(`${rules}: ${did}`);
  return lines;
}
