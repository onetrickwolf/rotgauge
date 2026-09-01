import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, relative, dirname, basename, join } from 'path';
import { CODE_EXT_RE } from './files.js';

// --- Markdown docs (context weight) ---
//
// Docs have no mutable state, but they rot the same way code does: they grow,
// they drift out of sync with the source, and the auto-loaded ones (CLAUDE.md,
// AGENTS.md, their @imports) charge their full token count on EVERY agent
// turn. Doc scores estimate context weight + staleness, on the same severity
// bands as code scores.

// Filenames agent harnesses inject into context automatically.
export const AUTO_LOADED_DOC_NAMES = new Set([
  'claude.md', 'claude.local.md', 'agents.md', 'agents.local.md', 'gemini.md',
]);

// Only source-ish refs are checked for staleness — data/artifact paths
// (*.db, images, state.json, ...) are often gitignored and would
// false-positive as stale. Source in any common language counts; JSON and
// YAML stay out because config and state files are generated too often.
const CHECKABLE_REF_RE = new RegExp(
  '\\.(' + [
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'html', 'htm', 'css', 'scss', 'vue', 'svelte',
    'md', 'markdown', 'mdx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp',
    'cs', 'php', 'dart', 'scala', 'lua', 'ex', 'exs', 'zig', 'sh', 'bash', 'sql', 'toml',
  ].join('|') + ')$', 'i');

// ~4 chars/token is close enough for a gauge.
export function estimateTokens(source) {
  return Math.round(source.length / 4);
}

export function analyzeDoc(source) {
  let loc = 0;
  let fenceLOC = 0;
  let headings = 0;
  let inFence = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) { inFence = !inFence; loc++; continue; }
    if (trimmed === '') continue;
    loc++;
    if (inFence) fenceLOC++;
    else if (/^#{1,6}\s/.test(trimmed)) headings++;
  }

  // Repo-path references. Precision over recall: a smoke test that cries
  // stale on prose is worse than one that misses a ref.
  const refs = new Set();
  // `file.ts:120` anchors drift faster than the paths they hang off: the file
  // still exists, so a path check passes, while the line has long since become
  // unrelated text. Remember the deepest line each ref claims so the caller can
  // test it against the real file — an anchor past EOF is unambiguously dead.
  const lineAnchors = new Map();
  const addRef = (raw) => {
    const trimmed = raw.trim();
    const anchor = /:(\d+)$/.exec(trimmed.replace(/#[\w-]*$/, ''));
    let ref = trimmed.replace(/(#[\w-]*|(?::\d+)+)$/, '').replace(/\/+$/, '');
    if (!ref || /[\s*{}<>$"'`\\]/.test(ref)) return; // globs, placeholders, prose
    if (/^\.[^./]+$/.test(ref)) return; // a bare extension (".md", ".ts") names a kind of file, not a file
    if (/^[a-z][a-z+.-]*:/i.test(ref)) return; // http:, mailto:, ...
    if (ref.startsWith('/') || ref.startsWith('~')) return; // outside the repo
    if (/[()!?,;=&]/.test(ref)) return; // expressions, not paths
    if (!ref.includes('/') && !CHECKABLE_REF_RE.test(ref)) return;
    refs.add(ref);
    if (anchor) {
      const line = Number(anchor[1]);
      if (line > 0) lineAnchors.set(ref, Math.max(lineAnchors.get(ref) ?? 0, line));
    }
  };
  for (const m of source.matchAll(/`([^`\n]+)`/g)) addRef(m[1]);
  for (const m of source.matchAll(/\]\(([^)\s]+)\)/g)) addRef(m[1]);
  // Bare tokens only count when they look unambiguously like a repo path:
  // at least one slash and a file extension.
  for (const m of source.matchAll(/(?:^|[\s|(])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,10})\b/gim)) addRef(m[1]);

  // CLAUDE.md-style `@path/to/file.md` imports pull other docs into
  // auto-loaded context.
  const atImports = [];
  for (const m of source.matchAll(/(?:^|\s)@((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.md)\b/gim)) {
    atImports.push(m[1]);
  }

  const words = source.split(/\s+/).filter(Boolean).length;
  return {
    loc, fenceLOC, headings, words,
    tokens: estimateTokens(source),
    refs: [...refs],
    lineAnchors: [...lineAnchors],
    atImports,
  };
}

// Every file in the tree (any extension), for suffix-matching doc refs:
// docs routinely say `utils.ts` or `web/router.tsx` without the full path.
export function buildFileIndex(root) {
  const INDEX_SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'vendor']);
  const paths = [];
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || INDEX_SKIP.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        paths.push(relative(root, join(dir, e.name)).replaceAll('\\', '/'));
      }
    }
  })(root);
  return paths;
}

// Line count of a resolved ref target, memoized — a doc can cite the same
// file a dozen times. Unreadable/binary targets report Infinity so a missing
// read never manufactures a dead anchor.
const targetLineCountCache = new Map();
function targetLineCount(target, cwd) {
  // `target` comes back from refTarget relative to the scan root, not to the
  // process cwd — resolve it or every read silently misses and nothing is
  // ever reported dead.
  const abs = resolve(cwd, target);
  if (targetLineCountCache.has(abs)) return targetLineCountCache.get(abs);
  let n = Infinity;
  try {
    const text = readFileSync(abs, 'utf-8');
    if (!text.includes('\0')) n = text.split('\n').length;
  } catch { /* unreadable — treat as unknowable, not dead */ }
  targetLineCountCache.set(abs, n);
  return n;
}

function refTarget(ref, docDir, cwd, index) {
  for (const base of [resolve(docDir, ref), resolve(cwd, ref)]) {
    if (existsSync(base)) return relative(cwd, base).replaceAll('\\', '/');
  }
  // Docs spell paths loosely (`utils.ts`, `web/router.tsx`, even prefixed
  // with the repo dir name) — drop leading segments until something in the
  // tree matches. Better to miss a stale ref than to cry stale on a live one.
  const parts = ref.replace(/^\.{1,2}\//, '').split('/');
  for (let i = 0; i < parts.length; i++) {
    const suffix = '/' + parts.slice(i).join('/');
    const hit = index.find((p) => p.endsWith(suffix));
    if (hit) return hit;
  }
  return null;
}

export function computeDocScore(d) {
  const raw =
    (d.tokens / 1000) * (d.autoLoaded ? 12 : 3) +
    d.staleRefs * 6 +
    Math.max(0, d.mirrorRefs - 15) * 0.8;
  return Math.round(raw);
}

// Human-readable reasons a doc scored what it did — used by --agent output.
export function docSignals(d) {
  const tok = d.tokens >= 1000 ? `${Math.round(d.tokens / 100) / 10}k` : String(d.tokens);
  const sig = [];
  if (d.autoLoaded) sig.push(`auto-loaded every turn (~${tok} tokens)`);
  else if (d.tokens >= 4000) sig.push(`~${tok} tokens when read`);
  if (d.staleRefs > 0) {
    const dead = d.deadAnchors ?? 0;
    const detail = dead > 0 ? ` (${dead} line anchor${dead === 1 ? '' : 's'} past end of file)` : '';
    sig.push(`${d.staleRefs} stale ref${d.staleRefs === 1 ? '' : 's'}${detail}`);
  }
  if (d.mirrorRefs > 15) sig.push(`mirrors ${d.mirrorRefs} source files`);
  // Advisory, not scored: a `file.ts:120` anchor silently rots the moment
  // anything above it shifts, and only the past-EOF case is provable. A doc
  // leaning on many of them is quietly drifting even when Stale reads 0.
  if ((d.lineAnchors ?? 0) >= 3) {
    sig.push(`${d.lineAnchors} file:line anchors (they drift, cite symbol names instead)`);
  }
  return sig;
}

export function scanDocs(filePaths, cwd) {
  if (filePaths.length === 0) return [];
  const index = buildFileIndex(cwd);
  const results = [];

  for (const filePath of filePaths) {
    let source;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error(`Error reading ${filePath}: ${e.message}`);
      continue;
    }
    const d = analyzeDoc(source);
    const docDir = dirname(filePath);
    const anchors = new Map(d.lineAnchors);
    let staleRefs = 0;
    let liveRefs = 0;
    let deadAnchors = 0;
    const mirror = new Set();
    for (const ref of d.refs) {
      if (!CHECKABLE_REF_RE.test(ref)) continue;
      const target = refTarget(ref, docDir, cwd, index);
      if (target === null) {
        staleRefs++;
        continue;
      }
      // The path resolves, so the doc genuinely mirrors this file — that
      // stays true even if an anchor on it has rotted.
      liveRefs++;
      if (CODE_EXT_RE.test(ref) || /\.(html|htm|css|scss)$/i.test(ref)) mirror.add(target);
      // But does the line it cites still exist? Only a line past EOF is
      // provably dead; a line that merely moved is beyond what a smoke test
      // can know, and guessing would cry wolf.
      const anchor = anchors.get(ref);
      if (anchor !== undefined && anchor > targetLineCount(target, cwd)) {
        deadAnchors++;
        staleRefs++;
      }
    }
    results.push({
      filePath,
      name: relative(cwd, filePath).replaceAll('\\', '/'),
      ...d,
      refs: d.refs.length,
      staleRefs,
      deadAnchors,
      lineAnchors: anchors.size,
      liveRefs,
      mirrorRefs: mirror.size,
      autoLoaded: AUTO_LOADED_DOC_NAMES.has(basename(filePath).toLowerCase()),
    });
  }

  // A doc @imported (transitively) by an auto-loaded doc is auto-loaded too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of results) {
      if (!r.autoLoaded) continue;
      for (const imp of r.atImports) {
        const target = resolve(dirname(r.filePath), imp);
        for (const other of results) {
          if (!other.autoLoaded && other.filePath === target) {
            other.autoLoaded = true;
            changed = true;
          }
        }
      }
    }
  }

  for (const r of results) r.score = computeDocScore(r);
  results.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return results;
}
