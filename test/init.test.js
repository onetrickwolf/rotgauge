import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { placeBlock, BLOCK_START, BLOCK_END, BLOCK_TEXT } from '../src/init.js';

const CLI = new URL('../rotgauge.js', import.meta.url).pathname;

function run(cwd, ...args) {
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-init-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const read = (dir, name) => readFileSync(join(dir, name), 'utf-8');
const SIMPLE = 'export const x = 1;\n';

test('--init on a bare repo writes the config, an AGENTS.md with the block, and the baseline, then names the next step', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'README.md': '# hi\n' });
  const r = run(dir, '--init', '--no-history', '--quiet');
  expect(r.code).toBe(0);
  expect(r.out).toContain('.rotgauge.json: written');
  expect(r.out).toContain('AGENTS.md: created with the rotgauge block');
  expect(r.out).toContain('rotgauge --ratchet: added');
  expect(r.out).toMatch(/docs total recorded at ~\d+ tokens/);
  expect(r.out).toContain('Next: rotgauge --check 5');
  const config = JSON.parse(read(dir, '.rotgauge.json'));
  expect(config.docs.ratchet).toBe(true);
  expect(config.docs.budgets.map((b) => b.match)).toEqual(['/AGENTS.md', '/CLAUDE.md']);
  expect(config.docs.totalTokens).toBeGreaterThan(0);
  expect(existsSync(join(dir, '.rotgauge-baseline.json'))).toBe(true);
  expect(read(dir, 'AGENTS.md')).toBe(`${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}\n`);
  // The project it set up passes its own gate.
  expect(run(dir, '--check', '5', '--no-history', '--quiet').code).toBe(0);
});

test('--init keeps an existing config, names what the defaults would add, and appends the block to the rules file', () => {
  const dir = fixture({
    'a.js': SIMPLE, 'CLAUDE.md': '# My rules\n\n- be kind\n',
    '.rotgauge.json': JSON.stringify({ docs: { totalTokens: 5000 } }),
  });
  const r = run(dir, '--init', '--no-history', '--quiet');
  expect(r.code).toBe(0);
  expect(r.out).toContain('.rotgauge.json: kept; the defaults would add "docs.ratchet": true');
  expect(r.out).toContain('CLAUDE.md: rotgauge block added');
  expect(JSON.parse(read(dir, '.rotgauge.json')).docs.totalTokens).toBe(5000); // a ceiling, not a ratchet: untouched
  expect(read(dir, 'CLAUDE.md')).toBe(`# My rules\n\n- be kind\n\n${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}\n`);
});

test('--init prefers AGENTS.md over CLAUDE.md and is idempotent; a stale block is refreshed in place', () => {
  const dir = fixture({ 'a.js': SIMPLE, 'AGENTS.md': '# Guide\n\nrules.\n', 'CLAUDE.md': '@AGENTS.md\n' });
  run(dir, '--init', '--no-history', '--quiet');
  expect(read(dir, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  const once = read(dir, 'AGENTS.md');
  const again = run(dir, '--init', '--no-history', '--quiet');
  expect(again.out).toContain('AGENTS.md: rotgauge block current');
  expect(read(dir, 'AGENTS.md')).toBe(once);
  // An older block (different text between the markers, anywhere in the file) is replaced where it sits.
  writeFileSync(join(dir, 'AGENTS.md'), `# Guide\n\n${BLOCK_START}\nold words from 0.8\n${BLOCK_END}\n\n## More\n\nkept.\n`);
  const refreshed = run(dir, '--init', '--no-history', '--quiet');
  expect(refreshed.out).toContain('AGENTS.md: rotgauge block refreshed');
  expect(read(dir, 'AGENTS.md')).toBe(`# Guide\n\n${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}\n\n## More\n\nkept.\n`);
});

test('placeBlock appends after a blank line and tolerates a file without a trailing newline', () => {
  expect(placeBlock('')).toBe(`${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}\n`);
  expect(placeBlock('# x')).toBe(`# x\n\n${BLOCK_START}\n${BLOCK_TEXT}\n${BLOCK_END}\n`);
});

test('--init runs the ratchet rather than rewriting a baseline that exists', () => {
  const dir = fixture({ 'a.js': 'let n = 0;\nexport function f() { n++; }\n' });
  writeFileSync(join(dir, '.rotgauge-baseline.json'), JSON.stringify({ 'a.js': { score: 0 }, 'old.js': { score: 50 } }));
  run(dir, '--init', '--no-history', '--quiet');
  const baseline = JSON.parse(read(dir, '.rotgauge-baseline.json'));
  expect(baseline['a.js'].score).toBe(0); // the file scores above 0 now, and the entry is held, not raised
  expect(baseline['old.js']).toBeUndefined();
});
