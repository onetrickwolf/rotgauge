// `--ratchet`: the baseline only tightens. Every scored file with no entry is
// added at its current score, an entry whose file now scores below it is
// lowered, an entry whose file is no longer scored is dropped, and none is
// ever raised. With `docs.ratchet` on, the docs total in .rotgauge.json
// follows the same rule: `totalTokens` is recorded at the current total when
// that is lower (or unset), so every addition to the docs is a trade. Raising
// either is a deliberate edit someone makes by hand, in a diff a reviewer sees.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { BASELINE_FILE, CONFIG_FILE, loadConfig } from './config.js';

export function ratchetBaseline(baseline, results, isExempt = () => false) {
  const next = {};
  let added = 0;
  let lowered = 0;
  for (const r of results) {
    if (isExempt(r.name)) continue;
    const base = baseline[r.name];
    if (!base) { next[r.name] = { score: r.score }; added++; }
    else if (r.score < base.score) { next[r.name] = { score: r.score }; lowered++; }
    else next[r.name] = { score: base.score };
  }
  const dropped = Object.keys(baseline).filter((name) => !(name in next)).length;
  return { baseline: next, added, lowered, dropped };
}

// Records the docs total in .rotgauge.json when `docs.ratchet` is on. The
// number is replaced in place so the owner's formatting survives; only a
// config without the key is re-serialized. Returns null when there is nothing
// to ratchet, else { from, to } (equal when the total already held).
export function ratchetDocsTotal(cwd, docs, totalTokens) {
  if (!docs || !docs.ratchet) return null;
  const from = docs.totalTokens;
  if (from !== null && from <= totalTokens) return { from, to: from };
  const path = resolve(cwd, CONFIG_FILE);
  const raw = readFileSync(path, 'utf-8');
  const replaced = raw.replace(/("totalTokens"\s*:\s*)\d+(?:\.\d+)?/, `$1${totalTokens}`);
  if (replaced !== raw) writeFileSync(path, replaced);
  else {
    const json = JSON.parse(raw);
    json.docs.totalTokens = totalTokens;
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  }
  return { from, to: totalTokens };
}

// The --ratchet run: tightens the baseline file, records the docs total, and
// returns the config as it stands afterwards, since the total may have moved.
export function runRatchet({ cwd, everything, docResults, isExempt, config, note }) {
  const baselinePath = resolve(cwd, BASELINE_FILE);
  const current = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf-8')) : {};
  const { baseline, added, lowered, dropped } = ratchetBaseline(current, everything, isExempt);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  note(`rotgauge --ratchet: added ${added}, lowered ${lowered}, dropped ${dropped} baseline entries; none raised`);
  const total = ratchetDocsTotal(cwd, config.docs, docResults.reduce((sum, d) => sum + d.tokens, 0));
  if (!total) return config;
  note(total.from === total.to
    ? `docs total held at ~${total.to} tokens (${CONFIG_FILE} "totalTokens")`
    : `docs total recorded at ~${total.to} tokens in ${CONFIG_FILE} "totalTokens"${total.from === null ? '' : ` (was ${total.from})`}`);
  return loadConfig(cwd);
}
