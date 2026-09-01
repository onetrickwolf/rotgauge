import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { analyzeDoc, computeDocScore, scanDocs, estimateTokens } from '../rotgauge.js';

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

describe('analyzeDoc', () => {
  test('counts lines, fences, headings, tokens', () => {
    const d = analyzeDoc([
      '# Title',
      '',
      'Some prose here.',
      '```sh',
      'bun test',
      'bun run dev',
      '```',
      '## Section',
      'More prose.',
    ].join('\n'));
    expect(d.loc).toBe(8); // everything non-blank incl. fence delimiters
    expect(d.fenceLOC).toBe(2);
    expect(d.headings).toBe(2);
    expect(d.tokens).toBeGreaterThan(0);
  });

  test('extracts path refs from backticks, links, and bare tokens', () => {
    const d = analyzeDoc([
      'Edit `src/utils.ts` and see [the guide](docs/guide.md).',
      'The tree has packages/web/router.tsx in it.',
      'Run `bun run dev` first.', // spaces — not a path
      'Visit https://example.com/x.md for more.', // URL — skipped
      'Layout is `guilds/{guild_id}/files`.', // placeholder — skipped
      'Absolute `/mnt/data/thing.ts` is out of repo.', // absolute — skipped
    ].join('\n'));
    expect(d.refs.sort()).toEqual(['docs/guide.md', 'packages/web/router.tsx', 'src/utils.ts']);
  });

  test('strips anchors and line numbers from refs', () => {
    const d = analyzeDoc('See `src/a.ts:42` and [b](docs/b.md#setup).');
    expect(d.refs.sort()).toEqual(['docs/b.md', 'src/a.ts']);
  });

  test('a bare extension is a kind of file, not a path', () => {
    const d = analyzeDoc('Scans `.md` and `.ts` files, plus `src/real.ts`.');
    expect(d.refs).toEqual(['src/real.ts']);
  });

  test('extracts @imports but not npm scopes', () => {
    const d = analyzeDoc([
      'Import @docs/extra.md for details.',
      'Uses the @acme/shared package.', // no .md — not an import
    ].join('\n'));
    expect(d.atImports).toEqual(['docs/extra.md']);
  });

  test('token estimate tracks source length', () => {
    expect(estimateTokens('a'.repeat(4000))).toBe(1000);
  });
});

describe('doc scoring', () => {
  const base = { tokens: 0, staleRefs: 0, mirrorRefs: 0, autoLoaded: false };

  test('auto-loaded docs score ~4x their on-demand weight', () => {
    const onDemand = computeDocScore({ ...base, tokens: 7000 });
    const auto = computeDocScore({ ...base, tokens: 7000, autoLoaded: true });
    expect(auto).toBe(onDemand * 4);
    expect(auto).toBeGreaterThanOrEqual(60); // a 7k-token CLAUDE.md is red
    expect(onDemand).toBeLessThan(40); // same doc read on demand is green
  });

  test('stale refs and mirroring raise the score', () => {
    const clean = computeDocScore({ ...base, tokens: 2000, autoLoaded: true });
    const stale = computeDocScore({ ...base, tokens: 2000, autoLoaded: true, staleRefs: 5 });
    const mirroring = computeDocScore({ ...base, tokens: 2000, autoLoaded: true, mirrorRefs: 40 });
    expect(stale).toBeGreaterThan(clean);
    expect(mirroring).toBeGreaterThan(clean);
  });

  test('a lean CLAUDE.md stays green', () => {
    expect(computeDocScore({ ...base, tokens: 1200, autoLoaded: true })).toBeLessThan(40);
  });
});

describe('scanDocs', () => {
  test('live vs stale refs; basenames suffix-match the tree', () => {
    const dir = fixture({
      'src/utils.ts': 'export const x = 1;\n',
      'src/deep/router.tsx': 'export const r = 1;\n',
      'README.md': [
        'Edit `src/utils.ts` or just `router.tsx`.', // both live (second via suffix match)
        'The old `src/legacy.ts` module.', // stale
      ].join('\n'),
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.liveRefs).toBe(2);
    expect(doc.staleRefs).toBe(1);
    expect(doc.mirrorRefs).toBe(2);
  });

  test('refs prefixed with extra leading dirs still resolve', () => {
    const dir = fixture({
      'packages/app/main.ts': 'export const x = 1;\n',
      'README.md': 'Run `myrepo/packages/app/main.ts` on the server.\n',
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.staleRefs).toBe(0);
    expect(doc.liveRefs).toBe(1);
  });

  test('non-source refs are never stale (gitignored artifacts)', () => {
    const dir = fixture({ 'README.md': 'The DB lives at `data/discord.db`.\n' });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.staleRefs).toBe(0);
    expect(doc.refs).toBe(1);
  });

  test('a file:line anchor past end of file is stale, though the path is live', () => {
    const dir = fixture({
      'src/tiny.ts': 'export const x = 1;\n', // 2 lines
      'README.md': 'The guard is at `src/tiny.ts:900`.\n',
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.staleRefs).toBe(1);
    expect(doc.deadAnchors).toBe(1);
    // The path still resolves, so the doc genuinely mirrors that file.
    expect(doc.liveRefs).toBe(1);
    expect(doc.mirrorRefs).toBe(1);
  });

  test('a file:line anchor within the file is not stale', () => {
    const dir = fixture({
      'src/tiny.ts': 'a\nb\nc\nd\ne\n',
      'README.md': 'See `src/tiny.ts:3`.\n',
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.staleRefs).toBe(0);
    expect(doc.deadAnchors).toBe(0);
    expect(doc.lineAnchors).toBe(1);
  });

  test('anchors count per path, deepest line wins', () => {
    const dir = fixture({
      'src/a.ts': 'x\n'.repeat(10),
      'src/b.ts': 'x\n'.repeat(10),
      'README.md': 'See `src/a.ts:2`, `src/a.ts:99`, and `src/b.ts:4`.\n',
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.lineAnchors).toBe(2); // two distinct paths carry anchors
    expect(doc.deadAnchors).toBe(1); // a.ts:99 is past EOF, b.ts:4 is fine
  });

  test('a binary anchor target never manufactures staleness', () => {
    const dir = fixture({
      'src/blob.ts': 'ok\0binary\n',
      'README.md': 'See `src/blob.ts:5000`.\n',
    });
    const [doc] = scanDocs([join(dir, 'README.md')], dir);
    expect(doc.deadAnchors).toBe(0);
    expect(doc.staleRefs).toBe(0);
  });

  test('CLAUDE.md is auto-loaded; its @imports become auto-loaded too', () => {
    const dir = fixture({
      'CLAUDE.md': 'Rules here.\n\nSee @docs/style.md for style.\n',
      'docs/style.md': 'Style rules. '.repeat(50) + '\n',
      'docs/unrelated.md': 'Not imported.\n',
    });
    const docs = scanDocs(
      ['CLAUDE.md', 'docs/style.md', 'docs/unrelated.md'].map((p) => join(dir, p)),
      dir,
    );
    const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
    expect(byName['CLAUDE.md'].autoLoaded).toBe(true);
    expect(byName['docs/style.md'].autoLoaded).toBe(true);
    expect(byName['docs/unrelated.md'].autoLoaded).toBe(false);
  });
});

describe('docs CLI', () => {
  test('a markdown-only directory analyzes and prints the docs table', () => {
    const dir = fixture({ 'notes.md': '# Notes\n\nSome notes about `missing/file.ts`.\n' });
    const r = run(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Docs (agent-context weight)');
    expect(r.out).toContain('notes.md');
  });

  test('--json emits typed entries for code and docs', () => {
    const dir = fixture({
      'a.js': 'export const x = 1;\n',
      'CLAUDE.md': '# Rules\n\nAlways test.\n',
    });
    const r = run(dir, '--json');
    expect(r.code).toBe(0);
    const entries = JSON.parse(r.out);
    const doc = entries.find((e) => e.type === 'doc');
    expect(entries.find((e) => e.type === 'code').file).toBe('a.js');
    expect(doc.file).toBe('CLAUDE.md');
    expect(doc.autoLoaded).toBe(true);
  });

  test('--no-docs skips markdown', () => {
    const dir = fixture({ 'a.js': 'export const x = 1;\n', 'README.md': '# hi\n' });
    const r = run(dir, '--no-docs', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).some((e) => e.type === 'doc')).toBe(false);
  });

  test('--check catches a doc that grew past the threshold', () => {
    const dir = fixture({
      'a.js': 'export const x = 1;\n',
      'CLAUDE.md': '# Rules\n\nShort.\n',
    });
    expect(run(dir, '--save-baseline').code).toBe(0);
    writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n' + 'Endless catalog prose. '.repeat(600) + '\n');
    const checked = run(dir, '--check');
    expect(checked.code).toBe(1);
    expect(checked.err).toContain('CLAUDE.md');
    expect(checked.err).toContain('exceeded the delta threshold');
  });

  test('--agent includes a context-docs section', () => {
    const dir = fixture({
      'a.js': 'export const x = 1;\n',
      'CLAUDE.md': '# Rules\n\n' + 'Lots of rules. '.repeat(200) + '\n',
    });
    const r = run(dir, '--agent');
    expect(r.code).toBe(0);
    expect(r.out).toContain('**Context docs (markdown):**');
    expect(r.out).toContain('| CLAUDE.md |');
    expect(r.out).toContain('auto-loaded every turn');
  });
});
