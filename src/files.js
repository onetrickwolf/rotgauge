// File discovery: which files rotgauge scans and which directories it skips.

import { readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

export const CODE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
export const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const SCAN_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|html|htm)$/;
export const DOC_EXT_RE = /\.(md|markdown)$/i;
export const HAS_EXT_RE = /\.[^./\\]+$/;

// Directories discovery never descends into (dot-directories are skipped as
// well). Dependencies and build output are not authored; test trees are, but
// their many small callbacks would drown the report in function-count noise.
// A .rotgauge.json "skip" list adds names to this set, and naming a skipped
// directory on the command line still scans it.
export const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage', 'public',
  'test', 'tests', '__tests__', 'test-results',
  'playwright-report', 'allure-results', 'allure-report',
]);

export function discoverFiles(dir, skip = SKIP_DIRS) {
  const found = [];
  // Sorted so results come out identical across runtimes and filesystems.
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      found.push(...discoverFiles(join(dir, entry.name), skip));
    } else if (entry.isFile() && (SCAN_EXT_RE.test(entry.name) || DOC_EXT_RE.test(entry.name))) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

export function expandPaths(paths, cwd, skip = SKIP_DIRS) {
  if (paths.length === 0) return discoverFiles(cwd, skip).map((f) => resolve(f));
  const out = [];
  for (const p of paths) {
    const abs = resolve(cwd, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      console.error(`rotgauge: no such file or directory: ${p}`);
      continue;
    }
    if (st.isDirectory()) out.push(...discoverFiles(abs, skip));
    else out.push(abs);
  }
  return out;
}
