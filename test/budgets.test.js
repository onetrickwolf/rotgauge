import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI = new URL('../rotgauge.js', import.meta.url).pathname;

function run(cwd, ...args) {
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-budgets-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const CODE = 'export const x = 1;\n';
const config = (docs, extra = {}) => JSON.stringify({ ...extra, docs });
// ~7 chars a word, ~4 chars a token: 300 words is well past a 200-token cap.
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '\n';

test('a doc over its budget fails --check and names the budget', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n' + words(300), '.rotgauge.json': config({ budgets: [{ match: 'README.md', tokens: 200 }] }) });
  expect(run(dir, '--save-baseline', '--quiet').code).toBe(0);
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/README\.md: ~\d+ tokens over its 200-token budget/);
});

test('a doc within its budget passes, and the table shows the cap', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n' + words(300), '.rotgauge.json': config({ budgets: [{ match: 'README.md', tokens: 5000 }] }) });
  run(dir, '--save-baseline', '--quiet');
  expect(run(dir, '--check', '5', '--quiet').code).toBe(0);
  const table = run(dir, '--no-history');
  expect(table.out).toContain('Budget');
  expect(table.out).toContain('5000');
});

test('an auto-loaded doc over budget says so', () => {
  const dir = fixture({ 'a.js': CODE, 'AGENTS.md': '# rules\n' + words(300), '.rotgauge.json': config({ budgets: [{ match: 'AGENTS.md', tokens: 100 }] }) });
  run(dir, '--save-baseline', '--quiet');
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toContain('auto-loaded every turn');
});

test('a new doc outside docs.allow fails --check even though it has no baseline entry', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n', '.rotgauge.json': config({ allow: ['README.md', 'docs/**'] }) });
  run(dir, '--save-baseline', '--quiet');
  writeFileSync(join(dir, 'perf-2026-09-06.md'), '# report\n' + words(20));
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toContain('perf-2026-09-06.md: not an allowed doc location');
  // The allowed places stay allowed.
  expect(r.err).not.toContain('README.md: not an allowed');
});

test('the total budget caps the whole scanned set', () => {
  const dir = fixture({
    'a.js': CODE, 'one.md': '# one\n' + words(150), 'two.md': '# two\n' + words(150),
    '.rotgauge.json': config({ totalTokens: 100 }),
  });
  run(dir, '--save-baseline', '--quiet');
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/docs: ~\d+ tokens over the 100-token total budget/);
  expect(run(dir, '--no-history').out).toContain('of the 100-token budget');
});

test('the first matching budget wins', () => {
  const dir = fixture({
    'a.js': CODE, 'docs/decisions/0001-x.md': '# d\n' + words(300),
    '.rotgauge.json': config({ budgets: [{ match: 'docs/decisions/*.md', tokens: 100 }, { match: 'docs/**', tokens: 100000 }] }),
  });
  run(dir, '--save-baseline', '--quiet');
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toContain('over its 100-token budget');
});

test('exempt docs are not gated by budgets, but the gate names them', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n' + words(300), '.rotgauge.json': config({ budgets: [{ match: 'README.md', tokens: 200 }] }, { exempt: ['README.md'] }) });
  run(dir, '--save-baseline', '--quiet');
  const r = run(dir, '--check', '5', '--quiet');
  expect(r.code).toBe(0);
  expect(r.out).toContain('over its 200-token budget (exempt)');
});

test('--json carries the budget fields', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n' + words(300), '.rotgauge.json': config({ allow: ['README.md'], budgets: [{ match: 'README.md', tokens: 200 }] }) });
  const r = run(dir, '--json', '--no-history');
  expect(r.code).toBe(0);
  const entry = JSON.parse(r.out).find((e) => e.file === 'README.md');
  expect(entry.budgetTokens).toBe(200);
  expect(entry.overBudget).toBe(true);
  expect(entry.allowed).toBe(true);
});

test('--agent names budget and location findings', () => {
  const dir = fixture({ 'a.js': CODE, 'notes.md': '# n\n' + words(300), '.rotgauge.json': config({ allow: ['README.md'], budgets: [{ match: '*.md', tokens: 200 }] }) });
  const r = run(dir, '--agent', '--no-history');
  expect(r.out).toContain('outside the allowed doc locations');
  expect(r.out).toContain('over its 200-token budget');
});

test('without a docs section nothing changes', () => {
  const dir = fixture({ 'a.js': CODE, 'README.md': '# hi\n' + words(300) });
  const table = run(dir, '--no-history');
  expect(table.out).not.toContain('Budget');
  const entry = JSON.parse(run(dir, '--json', '--no-history').out).find((e) => e.file === 'README.md');
  expect(entry.budgetTokens).toBeUndefined();
});

test('an invalid docs section is an error, never a silent no-op', () => {
  for (const bad of [
    { budgets: [{ match: 'x' }] },
    { budgets: [{ match: '', tokens: 5 }] },
    { allow: 'README.md' },
    { totalTokens: -1 },
    { limit: 5 },
    'nope',
  ]) {
    const dir = fixture({ 'a.js': CODE, '.rotgauge.json': JSON.stringify({ docs: bad }) });
    const r = run(dir, '--no-history');
    expect(r.code).toBe(1);
    expect(r.err).toContain('.rotgauge.json');
  }
});
