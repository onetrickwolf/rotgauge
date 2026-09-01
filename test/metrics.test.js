import { test, expect, describe } from 'bun:test';
import {
  parseArgs, makeExemptMatcher, analyzeSource, analyzeHTML, computeScore, emptyMetrics,
  dominantSignals, dialectFor, CLOSURE_FN_LINES,
} from '../rotgauge.js';

describe('parseArgs', () => {
  test('path after --check stays a path, threshold defaults to 0', () => {
    const opts = parseArgs(['--check', 'src/main.js']);
    expect(opts.check).toBe(true);
    expect(opts.checkThreshold).toBe(0);
    expect(opts.paths).toEqual(['src/main.js']);
  });

  test('numeric token after --check is consumed as threshold', () => {
    const opts = parseArgs(['--check', '5', 'a.js']);
    expect(opts.checkThreshold).toBe(5);
    expect(opts.paths).toEqual(['a.js']);
  });

  test('unknown flags are an error, not a filename', () => {
    expect(() => parseArgs(['--jsn'])).toThrow('Unknown flag');
  });
});

describe('fan-out', () => {
  test('asset imports do not count; code imports and require do', () => {
    const m = analyzeSource(`
      import './styles.css';
      import data from './data.json';
      import { helper } from './helper.js';
      import util from './util';
      const legacy = require('./legacy.js');
      export const x = 1;
    `);
    expect(m.fanOut).toBe(3); // helper.js, util, legacy.js
    expect(m.imports.sort()).toEqual(['./helper.js', './legacy.js', './util']);
  });
});

describe('module mutable state', () => {
  test('destructured module-scope let bindings are tracked', () => {
    const m = analyzeSource(`
      let { count, total } = loadState();
      let plain = 0;
      export function bump() {
        count = count + 1;
        total = total + 1;
        plain = plain + 1;
      }
    `);
    expect(m.moduleLets).toBe(3);
    expect(m.mutations).toBe(3);
    expect(m.moduleMutations).toBe(3);
  });

  test('module-scope var counts as mutable state', () => {
    const m = analyzeSource(`
      var total = 0;
      export function f() { total++; total = total * 2; }
    `);
    expect(m.moduleLets).toBe(1);
    expect(m.mutations).toBe(2);
    expect(m.moduleMutations).toBe(2);
  });
});

describe('closure state', () => {
  function giantFnWith(bodyLines) {
    const filler = Array.from({ length: CLOSURE_FN_LINES }, (_, i) => `  const c${i} = ${i};`);
    return `export function setup() {\n${bodyLines}\n${filler.join('\n')}\n}`;
  }

  test('lets inside large functions count as closure state', () => {
    const m = analyzeSource(giantFnWith(
      '  let hp = 3;\n  let combo = 0;\n  function hit() { hp -= 1; combo += 1; }'
    ));
    expect(m.closureLets).toBe(2);
    expect(m.closureMutations).toBe(2);
    expect(m.moduleLets).toBe(0);
  });

  test('lets in small functions stay local', () => {
    const m = analyzeSource('export function f() {\n  let n = 0;\n  n += 1;\n  return n;\n}');
    expect(m.closureLets).toBe(0);
    expect(m.letCount).toBe(1);
  });

  test('lets in a small function nested inside a giant one stay local', () => {
    const m = analyzeSource(giantFnWith(
      '  function inner() { let tmp = 1; tmp += 1; return tmp; }'
    ));
    expect(m.closureLets).toBe(0);
  });

  test('closure state outweighs the same code at local weight', () => {
    const base = { ...emptyMetrics(), loc: 120, commentRatio: 0.1, fanIn: 0, isHTML: false };
    const asLocal = computeScore({ ...base, letCount: 20, mutations: 30 });
    const asClosure = computeScore({ ...base, letCount: 20, mutations: 30, closureLets: 20, closureMutations: 30 });
    expect(asClosure).toBeGreaterThan(asLocal);
  });
});

describe('dominant signals', () => {
  test('surfaces the outlier metric, not just the biggest raw term', () => {
    const base = () => ({
      ...emptyMetrics(), loc: 300, commentRatio: 0.1, fanIn: 0, isHTML: false,
      functions: 50, maxFnComplexity: 400, maxNesting: 3,
    });
    // Nine typical files establish the norm; one has a freak destructure.
    const results = Array.from({ length: 9 }, base);
    const freak = { ...base(), maxDestructureWidth: 27 };
    results.push(freak);
    const signalsFor = dominantSignals(results);
    const signals = signalsFor(freak).join(' | ');
    expect(signals).toContain('wide interfaces');
    // the universal function term must not crowd it out of first place
    expect(signalsFor(freak)[0]).toContain('wide interfaces');
  });

  test('falls back to the top raw term when nothing clears the floor', () => {
    const tiny = { ...emptyMetrics(), loc: 10, commentRatio: 0, fanIn: 0, isHTML: false, functions: 1 };
    const signalsFor = dominantSignals([tiny]);
    expect(signalsFor(tiny).length).toBeGreaterThan(0);
  });
});

describe('instance state', () => {
  test('this.* mutations are counted', () => {
    const m = analyzeSource(`
      class Store {
        constructor() { this.items = []; this.count = 0; }
        add(i) { this.items.push(i); this.count += 1; this.recompute(); }
        recompute() { this.total = this.items.length * this.count; }
      }
      export const store = new Store();
      export function addItem(i) { store.count = 99; }
    `);
    expect(m.thisMutations).toBe(4); // items=, count=, count+=, total=
    expect(m.constObjMutations).toBe(1); // store.count = 99
  });
});

describe('template literals', () => {
  test('nested templates are not double-counted', () => {
    const source = [
      'export const outer = `',
      '  a',
      '  ${`',
      '    b',
      '    c',
      '  `}',
      '  d',
      '`;',
    ].join('\n');
    const m = analyzeSource(source);
    expect(m.templateLiteralLOC).toBe(8); // outer span only
  });

  test('effectiveLOC never goes negative in the score', () => {
    const m = {
      ...emptyMetrics(),
      loc: 5, templateLiteralLOC: 20, commentRatio: 0, fanIn: 0, isHTML: false,
    };
    expect(computeScore(m)).toBeGreaterThanOrEqual(0);
  });
});

describe('exports', () => {
  test('export * from is counted', () => {
    const m = analyzeSource(`
      export * from './a.js';
      export const b = 1;
    `);
    expect(m.exports).toBe(2);
  });
});

describe('parsing', () => {
  test('CommonJS-flavored files fall back to script parse', () => {
    // `with` is only valid in sloppy (script) mode
    expect(() => analyzeSource('with (Math) { PI; }')).not.toThrow();
  });

  test('TS analyzes as written', () => {
    const m = analyzeSource('let x: number = 1;\nexport function f(): void { x = 2; }', { dialect: 'ts' });
    expect(m.moduleLets).toBe(1);
    expect(m.moduleMutations).toBe(1);
  });

  test('JSX analyzes as written, in .js files too', () => {
    const m = analyzeSource('export const App = () => <div onClick={() => 1}>hi</div>;', { dialect: 'js' });
    expect(m.functions).toBe(2);
  });
});

describe('HTML extraction', () => {
  test('script blocks stay separate so duplicate lets can parse', () => {
    const html = analyzeHTML(`
      <script>let x = 1; x = 2;</script>
      <p onclick="go()">hi</p>
      <style>.a { color: red; }</style>
      <script>let x = 5;</script>
      <script src="external.js"></script>
    `);
    expect(html.scripts.length).toBe(2);
    expect(html.inlineHandlers).toBe(1);
    expect(html.inlineCssLOC).toBe(1);
  });
});

describe('exemptions', () => {
  test('--exempt collects comma lists, repeats, and the = form', () => {
    const opts = parseArgs(['--exempt', 'a/**, *.gen.ts', '--exempt=b/*', 'src']);
    expect(opts.exempt).toEqual(['a/**', '*.gen.ts', 'b/*']);
    expect(opts.paths).toEqual(['src']);
    expect(parseArgs(['-q']).quiet).toBe(true);
  });
  test('globs match at any depth unless anchored with /', () => {
    const m = makeExemptMatcher(['module_bindings/**', '*.generated.ts', '/tools/x.mjs', 'docs/*.md', '**/vendor/*.js']);
    expect(m('packages/p/module_bindings/index.ts')).toBe(true);
    expect(m('module_bindings/types/a.ts')).toBe(true);
    expect(m('a/module_bindings.ts')).toBe(false);
    expect(m('spacetime/src/catalogs.generated.ts')).toBe(true);
    expect(m('spacetime/src/catalogs.generated.ts.bak')).toBe(false);
    expect(m('tools/x.mjs')).toBe(true);
    expect(m('sub/tools/x.mjs')).toBe(false);
    expect(m('docs/a.md')).toBe(true);
    expect(m('docs/sub/a.md')).toBe(false);
    expect(m('vendor/a.js')).toBe(true);
    expect(m('x/y/vendor/a.js')).toBe(true);
    expect(m('x/vendor/deep/a.js')).toBe(false);
  });
});

describe('TypeScript as written (no transpile)', () => {
  test('an enum is a type, not module mutable state', () => {
    const m = analyzeSource('export enum Kind { Drone, Dart, Tank }\nexport const k: Kind = Kind.Dart;\n', { dialect: 'ts' });
    expect(m.moduleLets).toBe(0);
    expect(m.moduleMutations).toBe(0);
    expect(m.paramPropMutations).toBe(0);
    expect(m.functions).toBe(0);
    expect(m.exports).toBe(2);
  });

  test('exported interfaces and types are exports; overload signatures are not extra ones', () => {
    const m = analyzeSource([
      'export interface Shape { n: number }',
      'export type Pair = [number, number];',
      'export function over(x: string): string;',
      'export function over(x: number): number;',
      'export function over(x: any): any { return x; }',
      'export declare function ambient(): void;',
      'export type { Shape as S };',
    ].join('\n'), { dialect: 'ts' });
    expect(m.exports).toBe(5); // Shape, Pair, over, ambient, S
    expect(m.functions).toBe(1); // signatures are not functions
  });

  test('type-only imports count toward fan-out; import-equals counts like require', () => {
    const m = analyzeSource([
      "import type { Foo } from './types';",
      "import { bar } from './bar';",
      "import cfg = require('./cfg');",
      "import type React from 'react';",
      'export const x = bar(cfg, {} as Foo);',
    ].join('\n'), { dialect: 'ts' });
    expect(m.fanOut).toBe(3);
    expect([...m.imports].sort()).toEqual(['./bar', './cfg', './types']);
  });

  test('as, satisfies, and ! wrappers do not hide mutations', () => {
    const m = analyzeSource([
      'const state = { n: 0 };',
      'export function f(p: { y?: number }) {',
      '  (state as { n: number }).n++;',
      '  (p as any).y! = 2;',
      '  (state satisfies object).n = 3;',
      '}',
    ].join('\n'), { dialect: 'ts' });
    expect(m.constObjMutations).toBe(2);
    expect(m.paramPropMutations).toBe(1);
  });

  test('parameter properties are declarations: names collected, no this-mutation counted', () => {
    const m = analyzeSource([
      'export class Player {',
      '  private hp = 10;',
      '  constructor(private readonly id: string, public pos: { x: number }) { pos.x = 1; }',
      '  hit(dmg: number): void { this.hp -= dmg; }',
      '}',
    ].join('\n'), { dialect: 'ts' });
    expect(m.thisMutations).toBe(1); // only this.hp -= dmg
    expect(m.paramPropMutations).toBe(1); // pos.x = 1
  });

  test('function length is measured on the source you edit', () => {
    const src = [
      'export function move(',
      '  player: { x: number },',
      '  dir: { dx: number },',
      '  opts: { speed: number } = { speed: 1 },',
      '): { x: number } {',
      '  return { x: player.x + dir.dx * opts.speed };',
      '}',
    ].join('\n');
    expect(analyzeSource(src, { dialect: 'ts' }).maxFnLength).toBe(7);
  });

  test('type space is invisible to the walker', () => {
    const m = analyzeSource([
      'type Tpl = `a',
      '${string}',
      'b',
      '`;',
      'export interface Big { a: 1; b: 2; c: 3; d: 4; e: 5; f: 6; g: 7 }',
      'export function id<T extends { x: number }>(v: T): T { return v; }',
    ].join('\n'), { dialect: 'ts' });
    expect(m.templateLiteralLOC).toBe(0);
    expect(m.maxDestructureWidth).toBe(0);
    expect(m.functions).toBe(1);
  });

  test('.ts keeps JSX off so generic arrows parse; .tsx and .js turn it on', () => {
    expect(() => analyzeSource('export const id = <T>(x: T) => x;', { dialect: 'ts' })).not.toThrow();
    expect(analyzeSource('export const C = () => <div onClick={() => 1} />;', { dialect: 'tsx' }).functions).toBe(2);
    expect(analyzeSource('export const C = () => <div onClick={() => 1} />;', { dialect: 'js' }).functions).toBe(2);
  });

  test('dialectFor maps extensions', () => {
    expect(dialectFor('a.ts')).toBe('ts');
    expect(dialectFor('a.mts')).toBe('ts');
    expect(dialectFor('a.d.ts')).toBe('dts');
    expect(dialectFor('a.tsx')).toBe('tsx');
    for (const f of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) expect(dialectFor(f)).toBe('js');
  });
});
