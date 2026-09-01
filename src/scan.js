// Whole-scan pipeline for code files: read, dispatch to HTML or JS/TS
// analysis, resolve fan-in across the scanned set, score, sort.

import { readFileSync } from 'fs';
import { resolve, relative, dirname, join } from 'path';
import { CODE_EXTS, HAS_EXT_RE } from './files.js';
import {
  analyzeHTML, parseJS, analyzeAST, mergeMetrics, analyzeSource, dialectFor, countLines,
} from './metrics.js';
import { computeScore } from './score.js';

export function scanFiles(filePaths, cwd) {
  const results = [];

  for (const filePath of filePaths) {
    let source;
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error(`Error reading ${filePath}: ${e.message}`);
      continue;
    }

    const isHTML = filePath.endsWith('.html') || filePath.endsWith('.htm');
    let metrics;
    let html = null;

    if (isHTML) {
      html = analyzeHTML(source);
      const blockMetrics = [];
      let failed = 0;
      for (const block of html.scripts) {
        if (!block.code.trim()) continue;
        try {
          const ast = parseJS(block.code, block.isModule ? 'module' : 'script', 'js');
          blockMetrics.push(analyzeAST(ast));
        } catch (e) {
          failed++;
          console.error(`Parse error in ${filePath} (inline script): ${e.message}`);
        }
      }
      if (failed > 0 && blockMetrics.length === 0) continue; // scripts exist, none parseable
      metrics = mergeMetrics(blockMetrics);
    } else {
      try {
        metrics = analyzeSource(source, { dialect: dialectFor(filePath) });
      } catch (e) {
        console.error(`Parse error in ${filePath}: ${e.message}`);
        continue;
      }
    }

    // LOC counts the original source (that's what you edit), even where
    // analysis ran on transpiled or extracted JS.
    const lineInfo = countLines(source);
    const loc = lineInfo.code;
    const commentLines = lineInfo.comments;
    const commentRatio = loc + commentLines > 0 ? commentLines / (loc + commentLines) : 0;

    results.push({
      filePath,
      name: relative(cwd, filePath).replaceAll('\\', '/'),
      loc,
      commentLines,
      commentRatio,
      ...metrics,
      inlineCssLOC: html ? html.inlineCssLOC : 0,
      inlineHandlers: html ? html.inlineHandlers : 0,
      isHTML,
      fanIn: 0, // computed below
    });
  }

  // Fan-in: resolve each import to a scanned file.
  const byPath = new Map(results.map((r) => [r.filePath, r]));
  for (const result of results) {
    for (const importPath of result.imports) {
      const base = resolve(dirname(result.filePath), importPath);
      const candidates = [base];
      if (!HAS_EXT_RE.test(base)) {
        for (const ext of CODE_EXTS) candidates.push(base + ext);
        for (const ext of CODE_EXTS) candidates.push(join(base, 'index' + ext));
      } else if (base.endsWith('.js')) {
        // ESM-style TS: `./x.js` on disk as x.ts/x.tsx
        candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
      }
      for (const c of candidates) {
        const target = byPath.get(c);
        if (target) {
          target.fanIn++;
          break;
        }
      }
    }
  }

  for (const r of results) r.score = computeScore(r);
  results.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return results;
}
