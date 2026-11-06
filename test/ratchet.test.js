import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI = new URL('../rotgauge.js', import.meta.url).pathname;

function run(cwd, ...args) {
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-ratchet-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const baselineOf = (dir) => JSON.parse(readFileSync(join(dir, '.rotgauge-baseline.json'), 'utf-8'));
const configOf = (dir) => JSON.parse(readFileSync(join(dir, '.rotgauge.json'), 'utf-8'));
const SIMPLE = 'export const x = 1;\n';
// Yellow (40 to 59): ten module lets, each mutated twice.
const COMPLEX = `
import { a } from './lib.js';
let s1 = 0; let s2 = 0; let s3 = 0; let s4 = 0; let s5 = 0; let s6 = 0; let s7 = 0; let s8 = 0; let s9 = 0; let s10 = 0;
export function f(p1, p2, p3, p4, p5, p6) {
  if (p1) { if (p2) { if (p3) { for (const x of p4) { s1 = x; s2 += 1; s3 = s1 + s2; s4 = s3; s5 = s4; s6 = s5; s7 = s6; s8 = s7; s9 = s8; s10 = s9; } } } }
}
export function g() { s1 = 9; s2 = 8; s3 = 7; s4 = 6; s5 = 5; s6 = 4; s7 = 3; s8 = 2; s9 = 1; s10 = 0; }
`;
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '\n';

test('--ratchet creates the baseline when there is none, then only ever tightens it', () => {
  const dir = fixture({ 'a.js': COMPLEX, 'b.js': SIMPLE, 'gone.js': SIMPLE });
  const first = run(dir, '--ratchet', '--no-history', '--quiet');
  expect(first.code).toBe(0);
  expect(first.out).toContain('added 3, lowered 0, dropped 0 baseline entries; none raised');
  const yellow = baselineOf(dir)['a.js'].score;
  expect(yellow).toBeGreaterThanOrEqual(40);
  // a.js improves, b.js worsens, gone.js leaves, new.js arrives
  writeFileSync(join(dir, 'a.js'), SIMPLE);
  writeFileSync(join(dir, 'b.js'), COMPLEX);
  writeFileSync(join(dir, 'new.js'), SIMPLE);
  const { rmSync } = require('fs');
  rmSync(join(dir, 'gone.js'));
  const second = run(dir, '--ratchet', '--no-history', '--quiet');
  expect(second.out).toContain('added 1, lowered 1, dropped 1 baseline entries; none raised');
  const after = baselineOf(dir);
  expect(after['a.js'].score).toBeLessThan(yellow); // lowered
  expect(after['b.js'].score).toBe(baselineOf(dir)['b.js'].score); // sanity: present
  expect(after['b.js'].score).toBeLessThan(40); // the old green score kept: never raised
  expect(after['gone.js']).toBeUndefined();
  expect(after['new.js']).toBeDefined();
});

test('--ratchet writes exempt files no entry and drops one a --save-baseline left', () => {
  const dir = fixture({ 'gen/a.js': SIMPLE, 'main.js': SIMPLE });
  run(dir, '--save-baseline', '--no-history', '--quiet');
  expect(baselineOf(dir)['gen/a.js']).toBeDefined();
  writeFileSync(join(dir, '.rotgauge.json'), JSON.stringify({ exempt: ['gen/**'] }));
  run(dir, '--ratchet', '--no-history', '--quiet');
  expect(baselineOf(dir)['gen/a.js']).toBeUndefined();
  expect(baselineOf(dir)['main.js']).toBeDefined();
});

test('docs.ratchet: --ratchet records the docs total in .rotgauge.json, in place, and never raises it', () => {
  const config = '{\n\t"docs": {\n\t\t"totalTokens": 9000,\n\t\t"ratchet": true\n\t}\n}\n';
  const dir = fixture({ 'a.js': SIMPLE, 'README.md': '# hi\n' + words(100), 'docs/b.md': '# b\n' + words(100), '.rotgauge.json': config });
  const r = run(dir, '--ratchet', '--no-history', '--quiet');
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/docs total recorded at ~\d+ tokens in \.rotgauge\.json "totalTokens" \(was 9000\)/);
  const raw = readFileSync(join(dir, '.rotgauge.json'), 'utf-8');
  expect(raw).toContain('\t"ratchet": true'); // the owner's tabs survived: the number was replaced in place
  const recorded = configOf(dir).docs.totalTokens;
  expect(recorded).toBeLessThan(9000);
  // Growth is held by the recorded total, and a second ratchet does not raise it.
  writeFileSync(join(dir, 'docs/c.md'), '# c\n' + words(50));
  const held = run(dir, '--ratchet', '--no-history', '--quiet');
  expect(held.out).toContain(`docs total held at ~${recorded} tokens`);
  expect(configOf(dir).docs.totalTokens).toBe(recorded);
  const check = run(dir, '--check', '5', '--no-history', '--quiet');
  expect(check.code).toBe(1);
  expect(check.err).toContain(`over the recorded total of ${recorded} (it only moves down)`);
  expect(check.err).toContain('Docs total: it only moves down. Trim elsewhere to add here');
  // Trimming elsewhere is the trade: shrink README.md by more than c.md added, and the gate clears.
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
  // And the next ratchet records the lower total.
  run(dir, '--ratchet', '--no-history', '--quiet');
  expect(configOf(dir).docs.totalTokens).toBeLessThan(recorded);
});

test('docs.ratchet without a recorded total: --ratchet adds the key; --check asks for it first', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'README.md': '# hi\n' + words(20), '.rotgauge.json': JSON.stringify({ docs: { ratchet: true } }) });
  run(dir, '--save-baseline', '--no-history', '--quiet');
  const check = run(dir, '--check', '5', '--no-history', '--quiet');
  expect(check.code).toBe(1);
  expect(check.err).toContain('docs.ratchet is on but docs.totalTokens is unset');
  run(dir, '--ratchet', '--no-history', '--quiet');
  expect(configOf(dir).docs.totalTokens).toBeGreaterThan(0);
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
  const table = run(dir, '--no-history');
  expect(table.out).toContain('-token ratchet');
});

test('a plain total budget stays a ceiling: --ratchet leaves it alone', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'README.md': '# hi\n' + words(20), '.rotgauge.json': JSON.stringify({ docs: { totalTokens: 9000 } }) });
  const r = run(dir, '--ratchet', '--no-history', '--quiet');
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('docs total');
  expect(configOf(dir).docs.totalTokens).toBe(9000);
});

test('"docs.ratchet" must be a boolean', () => {
  const dir = fixture({ 'a.js': SIMPLE, '.rotgauge.json': JSON.stringify({ docs: { ratchet: 'yes' } }) });
  const r = run(dir, '--no-history');
  expect(r.code).toBe(1);
  expect(r.err).toContain('"docs.ratchet" must be true or false');
});

test('--check holds a file with no baseline entry to the bands: born green passes, born yellow fails with advice', () => {
  const dir = fixture({ 'main.js': SIMPLE });
  run(dir, '--save-baseline', '--no-history', '--quiet');
  writeFileSync(join(dir, 'fine.js'), SIMPLE);
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
  writeFileSync(join(dir, 'hub.js'), COMPLEX);
  const r = run(dir, '--check', '999', '--no-history', '--quiet');
  expect(r.code).toBe(1);
  expect(r.err).toContain('hub.js: score ');
  expect(r.err).toContain('is yellow with no baseline entry');
  expect(r.err).toContain('New files are held to the bands as if born green');
  // --ratchet records it as it is, and the gate clears.
  run(dir, '--ratchet', '--no-history', '--quiet');
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
  // An exempt file with no entry is untracked by design and stays silent.
  mkdirSync(join(dir, 'gen'));
  writeFileSync(join(dir, 'gen/bindings.js'), COMPLEX);
  const exempt = run(dir, '--check', '5', '--no-history', '--quiet', '--exempt', 'gen/**');
  expect(exempt.code).toBe(0);
  expect(exempt.out).not.toContain('bindings.js');
});

test('a new doc has no delta finding; the budgets are what catch it', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'README.md': '# hi\n' });
  run(dir, '--save-baseline', '--no-history', '--quiet');
  writeFileSync(join(dir, 'notes.md'), '# notes\n' + words(2000));
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
});

test('each kind of failure brings its advice once, after the findings', () => {
  const dir = fixture({
    'a.js': SIMPLE, 'b.js': SIMPLE, 'README.md': '# hi\n' + words(20), 'docs/x.md': '# x\nsee `lost.ts`.\n',
    '.rotgauge.json': JSON.stringify({ docs: { allow: ['README.md', 'docs/**'], budgets: [{ match: 'README.md', tokens: 50 }] } }),
  });
  run(dir, '--save-baseline', '--no-history', '--quiet');
  writeFileSync(join(dir, 'a.js'), COMPLEX);
  writeFileSync(join(dir, 'b.js'), COMPLEX);
  writeFileSync(join(dir, 'README.md'), '# hi\n' + words(100));
  writeFileSync(join(dir, 'docs/x.md'), '# x\nsee `lost.ts` and `gone.ts` and `vanished.ts`.\n');
  writeFileSync(join(dir, 'stray.md'), '# stray\n');
  const r = run(dir, '--check', '5', '--no-history', '--quiet');
  expect(r.code).toBe(1);
  const lines = r.err.split('\n');
  const count = (s) => lines.filter((l) => l.includes(s)).length;
  expect(count('turned yellow')).toBe(2);
  expect(count('Code: extract a seam')).toBe(1);
  expect(count('Docs score by tokens and stale refs')).toBe(1);
  expect(count('Budgets: a file\'s facts belong in its header comment')).toBe(1);
  expect(count('Location: move the doc into an allowed location')).toBe(1);
  expect(r.err).toContain('docs/x.md: score ');
  expect(r.err).toMatch(/~\d+ tokens, 3 stale refs/);
  // advice comes after every finding
  expect(lines.findIndex((l) => l.includes('Code: extract')).valueOf()).toBeGreaterThan(lines.findIndex((l) => l.includes('stray.md')));
});

test('the default report shows the rows worth a look on a big repo; --all prints every row', () => {
  const files = {};
  for (let i = 0; i < 40; i++) files[`src/green${i}.js`] = SIMPLE;
  files['src/hub.js'] = COMPLEX;
  for (let i = 0; i < 40; i++) files[`docs/note${i}.md`] = `# note ${i}\n` + words(5 + i);
  files['docs/stale.md'] = '# stale\nsee `missing.ts`.\n';
  files['AGENTS.md'] = '# rules\nshort.\n';
  const dir = fixture(files);
  const short = run(dir, '--no-history');
  expect(short.code).toBe(0);
  expect(short.out).toContain('src/hub.js');
  expect(short.out).not.toContain('src/green0.js');
  expect(short.out).toContain('40 green file(s) not shown (--all prints every row)');
  expect(short.out).toContain('docs/stale.md'); // flagged rows show whatever their rank
  expect(short.out).toContain('AGENTS.md');
  expect(short.out).toContain('doc(s) not shown');
  expect(short.out).toContain('41 files analyzed'); // totals cover every file
  const all = run(dir, '--no-history', '--all');
  expect(all.out).toContain('src/green0.js');
  expect(all.out).toContain('docs/note0.md');
  expect(all.out).not.toContain('not shown');
});

test('a small repo prints whole without a flag', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'b.js': COMPLEX, 'README.md': '# hi\n' });
  const r = run(dir, '--no-history');
  expect(r.out).toContain('a.js');
  expect(r.out).not.toContain('not shown');
});
