// Repo-level settings: the baseline file and .rotgauge.json, which carries
// exemptions (files the delta gate does not track) and extra skipped
// directories, so neither has to live on the command line.

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
  if (!existsSync(path)) return { exempt: [], skip: [] };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: not valid JSON (${e.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: expected a JSON object`);
  const known = ['exempt', 'skip'];
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
  return { exempt: exempt.map((g) => g.trim()), skip: skip.map((d) => d.trim()) };
}
