import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CLI = new URL('../rotgauge.js', import.meta.url).pathname;

function run(cwd, ...args) {
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const SIMPLE = 'export const x = 1;\n';
const COMPLEX = `
import { a } from './lib.js';
let s1 = 0; let s2 = 0; let s3 = 0;
export function f(p1, p2, p3, p4, p5, p6) {
  if (p1) { if (p2) { if (p3) { for (const x of p4) { s1 = x; s2 += 1; s3 = s1 + s2; } } } }
}
export function g() { s1 = 9; s2 = 8; s3 = 7; }
`;

test('.jsx files are discovered and analyzed', () => {
  const dir = fixture({
    'component.jsx': 'export const A = () => <div>{1 + 1}</div>;\n',
    'plain.js': SIMPLE,
  });
  const r = run(dir, '--json');
  expect(r.code).toBe(0);
  const files = JSON.parse(r.out).map((e) => e.file);
  expect(files).toContain('component.jsx');
  expect(files).toContain('plain.js');
});

test('directory arguments are scanned, no NaN/-Infinity in output', () => {
  const dir = fixture({ 'src/a.js': SIMPLE, 'src/b.js': COMPLEX });
  const r = run(dir, 'src');
  expect(r.code).toBe(0);
  expect(r.out).toContain('a.js');
  expect(r.out).toContain('b.js');
  expect(r.out).not.toContain('NaN');
  expect(r.out).not.toContain('Infinity');
});

test('nothing analyzable exits non-zero', () => {
  const dir = fixture({ 'notes.txt': 'nothing here\n' });
  const r = run(dir);
  expect(r.code).toBe(1);
  expect(r.err).toContain('no analyzable files');
});

test('--check followed by a file path still enforces threshold 0', () => {
  const dir = fixture({ 'main.js': SIMPLE });
  expect(run(dir, '--save-baseline').code).toBe(0);
  writeFileSync(join(dir, 'main.js'), COMPLEX);
  // regression is caught even with a path right after --check
  const checked = run(dir, '--check', 'main.js');
  expect(checked.code).toBe(1);
  expect(checked.err).toContain('exceeded the delta threshold');
  // and a generous numeric threshold still passes
  expect(run(dir, '--check', '999', 'main.js').code).toBe(0);
});

test('--check without a baseline exits with guidance', () => {
  const dir = fixture({ 'main.js': SIMPLE });
  const r = run(dir, '--check');
  expect(r.code).toBe(1);
  expect(r.err).toContain('--save-baseline');
});

test('--help and --version', () => {
  const dir = fixture({});
  const help = run(dir, '--help');
  expect(help.code).toBe(0);
  expect(help.out).toContain('Usage: rotgauge');
  const version = run(dir, '--version');
  expect(version.code).toBe(0);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  expect(version.out.trim()).toBe(pkg.version); // one source of truth, no constant to drift
});

test('unknown flag exits with an error', () => {
  const dir = fixture({ 'a.js': SIMPLE });
  const r = run(dir, '--jsn');
  expect(r.code).toBe(1);
  expect(r.err).toContain('Unknown flag');
});

test('HTML with duplicate lets across script blocks still analyzes', () => {
  const dir = fixture({
    'world.html': '<html><script>let x = 1; x = 2;</script><script>let x = 3; x = 4;</script></html>\n',
  });
  const r = run(dir, 'world.html', '--json');
  expect(r.code).toBe(0);
  const entry = JSON.parse(r.out)[0];
  expect(entry.file).toBe('world.html');
  expect(entry.lets).toBe(2);
  expect(entry.mutations).toBe(2);
});

test('--agent emits a markdown summary', () => {
  const dir = fixture({ 'a.js': COMPLEX });
  const r = run(dir, '--agent');
  expect(r.code).toBe(0);
  expect(r.out).toContain('### Context-rot smoke test');
  expect(r.out).toContain('| a.js |');
});

test('large files analyze in linear-ish time', () => {
  const fns = [];
  for (let i = 0; i < 3000; i++) {
    fns.push(`function f${i}(a,b) {\n  if (a) { return b; }\n  return a + b + ${i};\n}`);
  }
  const dir = fixture({ 'big.js': fns.join('\n') });
  const started = performance.now();
  const r = run(dir, 'big.js', '--json');
  const elapsed = performance.now() - started;
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)[0].loc).toBe(12000);
  // loose bound — quadratic line lookup would blow well past this
  expect(elapsed).toBeLessThan(5000);
});

test('--check counts docs too: a markdown file that balloons fails the gate', () => {
  const dir = fixture({ 'notes.md': '# notes\n\nshort.\n', 'main.js': SIMPLE });
  expect(run(dir, '--save-baseline', '--no-history').code).toBe(0);
  writeFileSync(join(dir, 'notes.md'), '# notes\n\n' + 'a long paragraph of prose about nothing at all. '.repeat(3000));
  const r = run(dir, '--check', '--no-history');
  expect(r.code).toBe(1);
  expect(r.err).toContain('notes.md');
  expect(r.err).toContain('exceeded the delta threshold');
});

test('--exempt skips a file over the threshold and names it instead of failing', () => {
  const dir = fixture({ 'gen/bindings.js': SIMPLE, 'main.js': SIMPLE });
  expect(run(dir, '--save-baseline', '--no-history').code).toBe(0);
  writeFileSync(join(dir, 'gen/bindings.js'), COMPLEX);
  expect(run(dir, '--check', '--no-history').code).toBe(1);
  const r = run(dir, '--check', '--no-history', '--exempt', 'gen/**');
  expect(r.code).toBe(0);
  expect(r.out).toContain('gen/bindings.js');
  expect(r.out).toContain('(exempt)');
  expect(r.out).toContain('rotgauge --check: clean');
  expect(r.out).toContain('1 exempt');
});

test('.rotgauge.json carries exemptions, unions with the flag, and --save-baseline writes exempt files no entry', () => {
  const dir = fixture({
    'gen/a.js': SIMPLE, 'x.generated.js': SIMPLE, 'main.js': SIMPLE,
    '.rotgauge.json': JSON.stringify({ exempt: ['gen/**'] }),
  });
  expect(run(dir, '--save-baseline', '--no-history').code).toBe(0);
  const baseline = JSON.parse(readFileSync(join(dir, '.rotgauge-baseline.json'), 'utf-8'));
  expect(Object.keys(baseline)).toContain('main.js');
  expect(Object.keys(baseline)).toContain('x.generated.js');
  expect(Object.keys(baseline)).not.toContain('gen/a.js');
  writeFileSync(join(dir, 'gen/a.js'), COMPLEX);
  writeFileSync(join(dir, 'x.generated.js'), COMPLEX);
  expect(run(dir, '--check', '--no-history').code).toBe(1); // x.generated.js is still gated
  expect(run(dir, '--check', '--no-history', '--exempt', '*.generated.js').code).toBe(0);
  const j = JSON.parse(run(dir, '--json', '--no-history').out);
  expect(j.find((e) => e.file === 'gen/a.js').exempt).toBe(true);
  expect(j.find((e) => e.file === 'main.js').exempt).toBeUndefined();
});

test('a bad .rotgauge.json fails loudly', () => {
  const dir = fixture({ 'main.js': SIMPLE, '.rotgauge.json': JSON.stringify({ exmept: ['gen/**'] }) });
  const r = run(dir, '--no-history');
  expect(r.code).toBe(1);
  expect(r.err).toContain('unknown key "exmept"');
  writeFileSync(join(dir, '.rotgauge.json'), JSON.stringify({ exempt: 'gen/**' }));
  expect(run(dir, '--no-history').err).toContain('"exempt" must be an array');
  writeFileSync(join(dir, '.rotgauge.json'), '{ not json');
  expect(run(dir, '--no-history').err).toContain('not valid JSON');
});

test('--exempt without globs is an error; --quiet keeps only the --check result', () => {
  const dir = fixture({ 'main.js': SIMPLE, 'notes.md': '# notes\n' });
  expect(run(dir, '--exempt').err).toContain('--exempt needs');
  expect(run(dir, '--save-baseline', '--no-history').code).toBe(0);
  const q = run(dir, '--check', '5', '--no-history', '--quiet');
  expect(q.code).toBe(0);
  expect(q.out.trim().split('\n')).toEqual([`rotgauge --check: clean (2 file(s) checked at +5 over baseline)`]);
});

test('--json --check keeps stdout parseable; check notes go to stderr', () => {
  const dir = fixture({ 'gen/bindings.js': SIMPLE, 'main.js': SIMPLE });
  expect(run(dir, '--save-baseline', '--no-history').code).toBe(0);
  writeFileSync(join(dir, 'gen/bindings.js'), COMPLEX);
  const r = run(dir, '--json', '--check', '--no-history', '--exempt', 'gen/**');
  expect(r.code).toBe(0);
  const entries = JSON.parse(r.out); // throws if a status line leaked into stdout
  expect(entries.find((e) => e.file === 'gen/bindings.js').exempt).toBe(true);
  expect(r.err).toContain('(exempt)');
  expect(r.err).toContain('rotgauge --check: clean');
});

test('.rotgauge.json "skip" adds directories to the built-in list; a named path still scans', () => {
  const dir = fixture({ 'archive/old.js': COMPLEX, 'src/main.js': SIMPLE, 'node_modules/dep/index.js': COMPLEX });
  const files = (...args) => JSON.parse(run(dir, '--json', '--no-history', ...args).out).map((e) => e.file);
  expect(files()).toContain('archive/old.js'); // only well-known build/test dirs skip by default
  expect(files()).not.toContain('node_modules/dep/index.js');
  writeFileSync(join(dir, '.rotgauge.json'), JSON.stringify({ skip: ['archive'] }));
  expect(files()).not.toContain('archive/old.js');
  expect(files()).toContain('src/main.js');
  expect(files('archive')).toContain('archive/old.js');
  writeFileSync(join(dir, '.rotgauge.json'), JSON.stringify({ skip: ['src/legacy'] }));
  expect(run(dir, '--no-history').err).toContain('"skip" must be an array of directory names');
});

test('the report ends in a short footer, not a legend; --help carries the column key', () => {
  const dir = fixture({ 'a.js': COMPLEX, 'notes.md': '# notes\n' });
  const r = run(dir, '--no-history');
  expect(r.code).toBe(0);
  expect(r.out).toContain('Column key: rotgauge --help');
  expect(r.out).not.toContain('For AI assistants');
  expect(r.out.split('\n').filter((l) => l.startsWith(' #')).length).toBe(0);
  const help = run(dir, '--help').out;
  for (const col of ['MLets', 'COMut', 'FenceL', 'Glance']) expect(help).toContain(col);
});

test('Node and Bun produce identical output', () => {
  const node = Bun.which('node');
  if (!node) return; // no Node here; the CI job covers it
  const dir = fixture({
    'a.ts': 'let n: number = 0;\nexport enum K { A }\nexport function f(): void { n++; }\n',
    'b.jsx': 'export const C = () => <div onClick={() => 1} />;\n',
    'c.js': SIMPLE,
    'README.md': '# hi\n\nSee `a.ts`.\n',
  });
  const viaBun = run(dir, '--json', '--no-history');
  const viaNode = Bun.spawnSync([node, CLI, '--json', '--no-history'], { cwd: dir });
  expect(viaNode.exitCode).toBe(0);
  expect(viaNode.stdout.toString()).toBe(viaBun.out);
  expect(JSON.parse(viaBun.out).find((e) => e.file === 'a.ts').moduleLets).toBe(1);
});
