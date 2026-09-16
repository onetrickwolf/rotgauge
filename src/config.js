// Repo-level settings: the baseline file and .rotgauge.json, which carries
// exemptions (files the delta gate does not track), extra skipped directories
// and doc budgets (absolute caps the delta gate cannot express), so none of
// them has to live on the command line.

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export const BASELINE_FILE = '.rotgauge-baseline.json';
export const CONFIG_FILE = '.rotgauge.json';

// --- Exemptions (--exempt / .rotgauge.json) ---
//
// Exempt files are still scanned and scored (they show in every report), but
// --check never counts them and --save-baseline writes no entry for them:
// the gate does not track them. Meant for generated artifacts whose scores
// follow a schema, not authored complexity. Never silent: a --check run
// names every exempt file that would have failed.

export function splitGlobs(value) {
  return value.split(',').map((g) => g.trim()).filter(Boolean);
}

export function globToRegExp(glob) {
  let g = glob.trim().replaceAll('\\', '/');
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } // '**/' = zero or more whole segments
        else { re += '.*'; i += 1; }                        // bare '**' = anything
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}$`);
}

export function makeExemptMatcher(globs) {
  const res = globs.map(globToRegExp);
  return (name) => res.some((re) => re.test(name));
}

export function loadConfig(cwd) {
  const path = resolve(cwd, CONFIG_FILE);
  if (!existsSync(path)) return { exempt: [], skip: [], docs: null };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: not valid JSON (${e.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  const known = ['exempt', 'skip', 'docs'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new Error(`${CONFIG_FILE}: unknown key "${key}" (known: ${known.join(', ')})`);
  }
  const exempt = raw.exempt ?? [];
  if (!Array.isArray(exempt) || !exempt.every((g) => typeof g === 'string' && g.trim() !== '')) {
    throw new Error(`${CONFIG_FILE}: "exempt" must be an array of non-empty glob strings`);
  }
  // Skip entries are directory names matched at any depth, like the built-in
  // list they extend; a path here would silently skip nothing.
  const skip = raw.skip ?? [];
  if (!Array.isArray(skip) || !skip.every((d) => typeof d === 'string' && d.trim() !== '' && !/[\\/]/.test(d))) {
    throw new Error(`${CONFIG_FILE}: "skip" must be an array of directory names (no slashes), e.g. ["archive", "legacy"]`);
  }
  return { exempt: exempt.map((g) => g.trim()), skip: skip.map((d) => d.trim()), docs: parseDocsConfig(raw.docs) };
}

// --- Doc budgets (.rotgauge.json "docs") ---
//
//   { "docs": { "allow": ["README.md", "docs/**"],
//               "budgets": [{ "match": "AGENTS.md", "tokens": 1500 }, { "match": "**/README.md", "tokens": 900 }],
//               "totalTokens": 12000 } }
//
// Every key is optional. `allow` globs say where docs may live (a scanned doc
// outside them fails --check); `budgets` cap estimated tokens per glob, first
// match wins; `totalTokens` caps the whole scanned set. Absolute, not deltas:
// a new file has no baseline entry, so only a cap can catch it.
function parseDocsConfig(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: "docs" must be an object`);
  const known = ['allow', 'budgets', 'totalTokens'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) throw new Error(`${CONFIG_FILE}: unknown key "docs.${key}" (known: ${known.join(', ')})`);
  }
  const allow = raw.allow ?? null;
  if (allow !== null && (!Array.isArray(allow) || !allow.every((g) => typeof g === 'string' && g.trim() !== ''))) {
    throw new Error(`${CONFIG_FILE}: "docs.allow" must be an array of non-empty glob strings`);
  }
  const budgets = raw.budgets ?? [];
  const isBudget = (b) => b && typeof b === 'object' && !Array.isArray(b) &&
    typeof b.match === 'string' && b.match.trim() !== '' && Number.isFinite(b.tokens) && b.tokens > 0;
  if (!Array.isArray(budgets) || !budgets.every(isBudget)) {
    throw new Error(`${CONFIG_FILE}: "docs.budgets" must be an array of { "match": glob, "tokens": positive number }`);
  }
  const totalTokens = raw.totalTokens ?? null;
  if (totalTokens !== null && !(Number.isFinite(totalTokens) && totalTokens > 0)) {
    throw new Error(`${CONFIG_FILE}: "docs.totalTokens" must be a positive number`);
  }
  return {
    allow: allow ? allow.map((g) => g.trim()) : null,
    budgets: budgets.map((b) => ({ match: b.match.trim(), tokens: b.tokens })),
    totalTokens,
  };
}
