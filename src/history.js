import { spawnSync } from 'child_process';
import { estimateTokens } from './docs.js';

// --- Git history (agent-glance cost) ---
//
// Agents read git history constantly — `git log` at session start, `git show`
// while orienting — so verbose AI-authored commit messages and swarms of tiny
// commits are a recurring context tax, same category as a bloated CLAUDE.md.
// This is a repo-level gauge of token weight, not commit-message linting: a
// detailed body on a gnarly migration is fine; a history where every commit
// carries one is not.

export const HISTORY_WINDOW = 100; // recent commits analyzed
export const GLANCE_COMMITS = 20; // "one orientation glance" = git log -20
export const TINY_COMMIT_LINES = 5; // commits changing fewer lines are "tiny"

// Parse `git log --format=%x1e%B --numstat` output: records separated by
// \x1e, numstat lines (added<TAB>deleted<TAB>path) mixed in with message
// lines. A message line that itself looks like numstat is miscounted, but
// close enough for a gauge.
export function parseHistoryLog(raw) {
  const commits = [];
  for (const rec of raw.split('\x1e').slice(1)) {
    const msgLines = [];
    let linesChanged = 0;
    for (const line of rec.split('\n')) {
      const numstat = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (numstat) {
        if (numstat[1] !== '-') linesChanged += Number(numstat[1]);
        if (numstat[2] !== '-') linesChanged += Number(numstat[2]);
      } else {
        msgLines.push(line);
      }
    }
    commits.push({ msgTokens: estimateTokens(msgLines.join('\n').trim()), linesChanged });
  }
  return commits;
}

export function computeHistoryScore(h) {
  const raw =
    (h.glanceTokens / 1000) * 8 +
    Math.max(0, h.medianMsgTokens - 20) * 0.4 +
    h.tinyRatio * 30;
  return Math.round(raw);
}

export function summarizeHistory(commits, glanceTokens) {
  const sorted = commits.map((c) => c.msgTokens).sort((a, b) => a - b);
  const tiny = commits.filter((c) => c.linesChanged < TINY_COMMIT_LINES).length;
  const h = {
    commits: commits.length,
    medianMsgTokens: sorted[sorted.length >> 1],
    tinyCommits: tiny,
    tinyRatio: tiny / commits.length,
    glanceTokens,
  };
  h.score = computeHistoryScore(h);
  return h;
}

// Returns null outside a git repo, without git, or with no commits —
// history is then simply omitted from output.
export function analyzeGitHistory(cwd) {
  const runGit = (args) => {
    const p = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return !p.error && p.status === 0 ? p.stdout : null;
  };
  // --no-merges: merge commits have no numstat and would all read as tiny.
  const raw = runGit(['log', `-${HISTORY_WINDOW}`, '--no-merges', '--format=%x1e%B', '--numstat']);
  if (!raw || !raw.trim()) return null;
  const commits = parseHistoryLog(raw);
  if (commits.length === 0) return null;
  // Glance cost measures the default log (merges included) — that's what an
  // agent actually gets back.
  const glance = runGit(['log', `-${GLANCE_COMMITS}`]) ?? '';
  return summarizeHistory(commits, estimateTokens(glance));
}
