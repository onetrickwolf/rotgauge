#!/usr/bin/env node
// rotgauge: context-rot smoke test for AI-assisted codebases.
//
// Scores estimate how hard each file is for an AI (or anyone) to edit
// correctly, not code quality. Cheap by design: run it often, treat a rising
// score as a smell worth a look, not a verdict.
//
// This file is the executable and the whole public module surface. The work
// lives in src/, one module per concern: cli (flags and the run), config
// (.rotgauge.json), files (discovery), metrics (the AST walk), score, scan
// (the code pipeline), docs (markdown context weight), history (git glance
// cost), output (tables, --agent, --json).

import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { main } from './src/cli.js';

export * from './src/cli.js';
export * from './src/config.js';
export * from './src/files.js';
export * from './src/metrics.js';
export * from './src/score.js';
export * from './src/scan.js';
export * from './src/docs.js';
export * from './src/history.js';
export * from './src/output.js';

// Run when invoked as a command (directly, through a bin symlink, npx, or
// bunx); stay quiet when imported as a module. Works the same on Node and Bun.
function invokedAsCommand() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCommand()) main();
