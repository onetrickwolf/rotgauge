import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseHistoryLog, summarizeHistory, computeHistoryScore, analyzeGitHistory,
  TINY_COMMIT_LINES,
} from '../rotgauge.js';

const CLI = new URL('../rotgauge.js', import.meta.url).pathname;

function run(cwd, ...args) {
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(cwd, ...args) {
  const p = Bun.spawnSync(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
    { stderr: 'pipe' },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`);
}

// A fixture repo: file contents keyed by name, one commit per message.
function repoFixture(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-git-'));
  git(dir, 'init', '-q');
  for (const { message, files } of commits) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
  }
  return dir;
}

describe('parseHistoryLog', () => {
  test('splits records and separates numstat from message lines', () => {
    const raw =
      '\x1efix: small tweak\n\n2\t1\tsrc/a.js\n\n' +
      '\x1efeat: big change\n\nA long body line explaining everything in detail.\n\n120\t40\tsrc/b.js\n15\t0\tsrc/c.js\n';
    const commits = parseHistoryLog(raw);
    expect(commits.length).toBe(2);
    expect(commits[0].linesChanged).toBe(3);
    expect(commits[1].linesChanged).toBe(175);
    expect(commits[1].msgTokens).toBeGreaterThan(commits[0].msgTokens);
  });

  test('binary numstat (-\\t-\\t) counts as zero lines, not NaN', () => {
    const commits = parseHistoryLog('\x1eadd image\n\n-\t-\tlogo.png\n');
    expect(commits.length).toBe(1);
    expect(commits[0].linesChanged).toBe(0);
  });

  test('empty input yields no commits', () => {
    expect(parseHistoryLog('')).toEqual([]);
  });
});

describe('history score', () => {
  test('terse healthy history scores green, verbose tiny-commit history scores red', () => {
    const healthy = summarizeHistory(
      Array.from({ length: 50 }, () => ({ msgTokens: 12, linesChanged: 80 })),
      1000, // ~50 tokens/commit of git log -20
    );
    const bloated = summarizeHistory(
      Array.from({ length: 50 }, () => ({ msgTokens: 150, linesChanged: 2 })),
      7000,
    );
    expect(healthy.score).toBeLessThan(40);
    expect(bloated.score).toBeGreaterThanOrEqual(60);
    expect(bloated.tinyRatio).toBe(1);
    expect(healthy.tinyRatio).toBe(0);
  });

  test('score is monotonic in each input', () => {
    const base = { medianMsgTokens: 30, tinyRatio: 0.2, glanceTokens: 1500 };
    const s = computeHistoryScore(base);
    expect(computeHistoryScore({ ...base, medianMsgTokens: 200 })).toBeGreaterThan(s);
    expect(computeHistoryScore({ ...base, tinyRatio: 0.9 })).toBeGreaterThan(s);
    expect(computeHistoryScore({ ...base, glanceTokens: 8000 })).toBeGreaterThan(s);
  });
});

describe('analyzeGitHistory', () => {
  test('returns null outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rotgauge-nogit-'));
    expect(analyzeGitHistory(dir)).toBe(null);
  });

  test('measures a real repo', () => {
    const dir = repoFixture([
      { message: 'first', files: { 'a.js': 'export const x = 1;\n' } },
      { message: 'tweak', files: { 'a.js': 'export const x = 2;\n' } },
      {
        message: 'feat: verbose\n\n' + 'This body line pads the message with detail.\n'.repeat(10),
        files: { 'b.js': 'export const y = 1;\n'.repeat(30) },
      },
    ]);
    const h = analyzeGitHistory(dir);
    expect(h.commits).toBe(3);
    expect(h.tinyCommits).toBe(2); // first + tweak each change 1-2 lines
    expect(h.glanceTokens).toBeGreaterThan(0);
    expect(h.score).toBeGreaterThanOrEqual(0);
  });
});

describe('CLI integration', () => {
  test('table output includes the history section in a repo, colored score off-TTY-safe', () => {
    const dir = repoFixture([{ message: 'init', files: { 'a.js': 'export const x = 1;\n' } }]);
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Git history (agent-glance cost)');
    expect(r.out).toContain('MsgTok');
    expect(r.out).not.toContain('NaN');
  });

  test('--no-history hides the section', () => {
    const dir = repoFixture([{ message: 'init', files: { 'a.js': 'export const x = 1;\n' } }]);
    const r = run(dir, '--no-history');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Git history');
  });

  test('non-repo output has no history section and still succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rotgauge-nogit-'));
    writeFileSync(join(dir, 'a.js'), 'export const x = 1;\n');
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Git history');
  });

  test('--json includes a history entry with the expected shape', () => {
    const dir = repoFixture([
      { message: 'init', files: { 'a.js': 'export const x = 1;\n' } },
      { message: 'more', files: { 'a.js': 'export const x = 1;\nexport const y = 2;\n' } },
    ]);
    const r = run(dir, '--json');
    expect(r.code).toBe(0);
    const history = JSON.parse(r.out).find((e) => e.type === 'history');
    expect(history).toBeDefined();
    expect(history.commits).toBe(2);
    expect(typeof history.medianMsgTokens).toBe('number');
    expect(typeof history.tinyRatio).toBe('number');
    expect(typeof history.glanceTokens).toBe('number');
    expect(typeof history.score).toBe('number');
  });

  test('--agent includes the history line and stays at three guidance bullets or fewer', () => {
    const dir = repoFixture([{ message: 'init', files: { 'a.js': 'export const x = 1;\n' } }]);
    const r = run(dir, '--agent');
    expect(r.code).toBe(0);
    expect(r.out).toContain('**Git history:**');
    // Pasted into CLAUDE.md and paid for on every turn: guidance stays tiny.
    expect(r.out.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(3);
  });

  test('history is not written to the baseline and never trips --check', () => {
    const dir = repoFixture([{ message: 'init', files: { 'a.js': 'export const x = 1;\n' } }]);
    run(dir, '--save-baseline');
    const baseline = JSON.parse(Bun.spawnSync(['cat', join(dir, '.rotgauge-baseline.json')]).stdout.toString());
    for (const key of Object.keys(baseline)) expect(key).not.toBe('history');
    // pile on verbose commits — check must still pass since history isn't baselined
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'noise\n\n' + 'verbose body line.\n'.repeat(20));
    const r = run(dir, '--check');
    expect(r.code).toBe(0);
  });

  test(`tiny threshold constant is sane (${TINY_COMMIT_LINES} lines)`, () => {
    expect(TINY_COMMIT_LINES).toBeGreaterThan(0);
  });
});
