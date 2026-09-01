#!/usr/bin/env bun
// Rebuilds the README screenshots in docs/ from a throwaway demo project, so
// they never drift from what the tool actually prints.
//
//   bun scripts/screenshots.js
//
// The demo is a small browser game with the usual rot: module state in the
// game loop, a class that mutates itself, docs that cite files which no longer
// exist, and a git history with one verbose commit and two tiny ones.

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'rotgauge.js');
const OUT = join(ROOT, 'docs');

// --- demo project (it all lives in template literals, so backticks are escaped) ---

const GAME = `import { spawnWave } from './waves.js';
import { Renderer } from './renderer.js';
import { clamp, rand } from './utils.js';

let score = 0;
let lives = 3;
let level = 1;
let tick = 0;
let paused = false;
let enemies = [];
let bullets = [];
let player = { x: 400, y: 560, vx: 0 };
let renderer = null;
let lastSpawn = 0;
let combo = 0;
let highScore = 0;

export function start(canvas) {
  renderer = new Renderer(canvas);
  enemies = spawnWave(level);
  paused = false;
  tick = 0;
  requestAnimationFrame(loop);
}

export function togglePause() {
  paused = !paused;
}

export function steer(dir) {
  player.vx = dir * 4;
}

export function fire() {
  bullets.push({ x: player.x, y: player.y });
}

export function loop(now) {
  if (!paused) {
    tick++;
    player.x = clamp(player.x + player.vx, 0, 800);
    if (now - lastSpawn > 2000) {
      enemies.push(...spawnWave(level));
      lastSpawn = now;
    }
    for (const b of bullets) {
      b.y -= 8;
      for (const e of enemies) {
        if (Math.abs(e.x - b.x) < 12 && Math.abs(e.y - b.y) < 12) {
          e.hp--;
          b.dead = true;
          if (e.hp <= 0) {
            e.dead = true;
            combo++;
            score += 10 * level * combo;
            highScore = Math.max(highScore, score);
            if (score > level * 500) {
              level++;
              if (level % 3 === 0) {
                lives++;
              }
            }
          }
        }
      }
    }
    for (const e of enemies) {
      e.y += e.speed;
      if (e.y > 600) {
        e.dead = true;
        lives--;
        combo = 0;
        if (lives <= 0) {
          paused = true;
          renderer.gameOver(score);
        }
      }
    }
    enemies = enemies.filter((e) => !e.dead);
    bullets = bullets.filter((b) => !b.dead && b.y > 0);
    if (rand() < 0.001) lives = Math.min(lives + 1, 5);
    if (tick % 600 === 0) combo = 0;
  }
  renderer.draw({ player, enemies, bullets, score, lives, level, combo, highScore });
  requestAnimationFrame(loop);
}
`;

const WAVES = `import { rand } from './utils.js';

let waveNumber = 0;
let difficulty = 1;
let lastKind = 'drone';
let spawned = 0;
let bossPending = false;
let pattern = [];
let cooldown = 0;
let seed = 42;
let elite = 0;

const KINDS = ['drone', 'dart', 'tank'];

function nextKind() {
  lastKind = KINDS[Math.floor(rand() * KINDS.length)];
  return lastKind;
}

function speedFor(kind) {
  if (kind === 'tank') return 0.6 * difficulty;
  if (kind === 'dart') return 2.4 * difficulty;
  return 1.2 * difficulty;
}

function makeEnemy(kind, x) {
  spawned++;
  return { kind, x, y: -20, speed: speedFor(kind), hp: kind === 'tank' ? 3 : 1 };
}

export function spawnWave(level) {
  waveNumber++;
  difficulty = 1 + level * 0.15;
  cooldown = Math.max(400, 2000 - level * 100);
  pattern = [];
  for (let i = 0; i < 4 + level; i++) pattern.push(makeEnemy(nextKind(), 60 + i * 80));
  if (waveNumber % 5 === 0) {
    bossPending = true;
    elite++;
    pattern.push({ kind: 'boss', x: 400, y: -60, speed: 0.4, hp: 20 + level * 5 });
  }
  seed = (seed * 9301 + 49297) % 233280;
  return pattern;
}

export function bossDefeated() {
  bossPending = false;
  difficulty += 0.1;
}

export function waveCooldown() {
  return cooldown;
}

export const stats = () => ({ waveNumber, spawned, elite, lastKind, bossPending });
`;

const RENDERER = `export class Renderer {
  constructor(canvas) {
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.frame = 0;
    this.flash = 0;
  }

  draw(state) {
    this.frame++;
    if (this.flash > 0) this.flash--;
    this.ctx.fillStyle = this.flash > 0 ? '#fff' : '#111';
    this.ctx.fillRect(0, 0, this.width, this.height);
    for (const e of state.enemies) this.sprite(e.kind, e.x, e.y);
    for (const b of state.bullets) this.ctx.fillRect(b.x - 1, b.y, 2, 8);
    this.sprite('ship', state.player.x, state.player.y);
    this.hud(state);
  }

  sprite(kind, x, y) {
    this.ctx.fillStyle = kind === 'boss' ? '#e06547' : kind === 'ship' ? '#95b268' : '#d8a544';
    this.ctx.fillRect(x - 10, y - 10, 20, 20);
  }

  hud({ score, lives, level }) {
    this.ctx.fillStyle = '#eee';
    this.ctx.fillText('score ' + score + '  lives ' + lives + '  level ' + level, 12, 20);
  }

  gameOver(score) {
    this.flash = 30;
    this.ctx.fillText('game over: ' + score, this.width / 2 - 40, this.height / 2);
  }
}
`;

const INPUT = `import { fire, togglePause, steer } from './game.js';

export function bind(target) {
  target.addEventListener('keydown', (e) => {
    if (e.key === ' ') fire();
    else if (e.key === 'p') togglePause();
    else if (e.key === 'ArrowLeft') steer(-1);
    else if (e.key === 'ArrowRight') steer(1);
  });
  target.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') steer(0);
  });
}
`;

// The same file after someone "improved" it: module state creeps in.
const INPUT_ROTTED = `import { fire, togglePause, steer } from './game.js';

let held = new Set();
let repeatTimer = 0;
let lastKey = null;
let bound = false;

export function bind(target) {
  if (bound) return;
  bound = true;
  target.addEventListener('keydown', (e) => {
    held.add(e.key);
    lastKey = e.key;
    if (e.key === ' ') fire();
    else if (e.key === 'p') togglePause();
    update();
  });
  target.addEventListener('keyup', (e) => {
    held.delete(e.key);
    update();
  });
}

function update() {
  if (held.has('ArrowLeft')) steer(-1);
  else if (held.has('ArrowRight')) steer(1);
  else steer(0);
  if (held.has(' ')) {
    repeatTimer++;
    if (repeatTimer % 6 === 0) fire();
  } else repeatTimer = 0;
}

export function lastPressed() {
  return lastKey;
}
`;

const UTILS = `export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function rand() {
  return Math.random();
}
`;

const HTML = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; background: #111; }
  canvas { display: block; margin: 0 auto; }
  #hud { position: fixed; top: 8px; left: 8px; color: #eee; }
</style>
</head>
<body onload="boot()">
<canvas id="game" width="800" height="600"></canvas>
<div id="hud"></div>
<script type="module">
  import { start } from './src/game.js';
  import { bind } from './src/input.js';
  let booted = false;
  window.boot = () => {
    if (booted) return;
    booted = true;
    start(document.getElementById('game'));
    bind(window);
  };
</script>
</body>
</html>
`;

const CLAUDE_MD = `# Demo game

Rules for agents working in this repo.

- The loop lives in src/game.js. Rendering goes through the Renderer class in
  src/renderer.js, never draw from the loop.
- Input is bound once from index.html, see src/input.js.
- Sound effects live in src/audio.js and are triggered from the loop.
- Design notes: @docs/design.md
`;

const DESIGN_MD = `# Design notes

The game loop in \`src/game.js:120\` advances every entity, then hands a snapshot
to src/renderer.js. Waves come from src/waves.js and difficulty scales with
level. Input events are translated in src/input.js and shared helpers sit in
src/utils.js. The old canvas fallback in src/canvas2d.js is gone.
`;

const VERBOSE_BODY = [
  'feat: input handling',
  '',
  'This commit introduces a comprehensive input handling layer for the game.',
  'It wires keyboard events to the loop through a small binding module so that',
  'the loop itself never touches the DOM. Arrow keys steer, space fires, and p',
  'toggles pause. The binding is idempotent and safe to call from index.html.',
  'Future work could add gamepad support and rebinding, both of which would',
  'live behind the same interface without touching the loop.',
].join('\n');

// Each entry: [commit message, files written before it]. Two commits change a
// single line so the history row has something to say about tiny commits.
const COMMITS = [
  ['initial game loop', { 'src/game.js': GAME, 'src/utils.js': UTILS, 'index.html': HTML }],
  ['add waves and renderer', { 'src/waves.js': WAVES, 'src/renderer.js': RENDERER }],
  [VERBOSE_BODY, { 'src/input.js': INPUT }],
  ['docs: design notes and agent rules', { 'docs/design.md': DESIGN_MD, 'CLAUDE.md': CLAUDE_MD }],
  ['typo', { 'src/utils.js': UTILS.replace('return v < lo', 'return v < lo /* inclusive */') }],
  ['bump', { 'src/utils.js': UTILS + '\nexport const TAU = Math.PI * 2;\n' }],
];

function git(cwd, ...args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-07-12T12:00:00Z', GIT_COMMITTER_DATE: '2026-07-12T12:00:00Z' };
  const p = Bun.spawnSync(
    ['git', '-c', 'user.name=demo', '-c', 'user.email=demo@example.com', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
    { env, stderr: 'pipe' },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString()}`);
}

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

function buildDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'rotgauge-demo-'));
  git(dir, 'init', '-q');
  for (const [message, files] of COMMITS) {
    write(dir, files);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
  }
  return dir;
}

function rotgauge(cwd, ...args) {
  const env = { ...process.env, FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// --- ANSI to SVG, in the style the README has used since 0.1 ---

const THEME = {
  bg: '#16110e', bar: '#211a15', text: '#d6cdbd', muted: '#8a7d6d',
  red: '#e06547', yellow: '#d8a544', green: '#95b268', cyan: '#6fb3c9',
};
const SGR = { 31: THEME.red, 32: THEME.green, 33: THEME.yellow, 36: THEME.cyan, 2: THEME.muted };
const CH = 8; // px per column at 13px monospace
const LH = 19; // line height
const PAD = 20;
const TOP = 60.3; // first baseline, below the title bar

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSVG(title, ansi) {
  const lines = ansi.replace(/\n$/, '').split('\n');
  let maxCols = 0;
  const rows = lines.map((line) => {
    const spans = [];
    let color = THEME.text;
    let cols = 0;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (m) {
        color = m[1] === '' || m[1] === '0' ? THEME.text : (SGR[m[1]] ?? color);
        continue;
      }
      if (!part) continue;
      spans.push({ text: part, color });
      cols += [...part].length;
    }
    maxCols = Math.max(maxCols, cols);
    return { spans, cols };
  });
  const width = PAD * 2 + maxCols * CH;
  const height = Math.round(TOP + LH * (lines.length - 1) + 42);
  const text = rows.map(({ spans, cols }, i) => {
    if (spans.length === 0) return '';
    const tspans = spans.map((s) => `<tspan fill="${s.color}">${esc(s.text)}</tspan>`).join('');
    return `<text x="${PAD}" y="${(TOP + LH * i).toFixed(1)}" xml:space="preserve" textLength="${cols * CH}" lengthAdjust="spacingAndGlyphs">${tspans}</text>`;
  }).filter(Boolean).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="13">
  <rect width="${width}" height="${height}" rx="10" fill="${THEME.bg}"/>
  <rect width="${width}" height="32" rx="10" fill="${THEME.bar}"/>
  <rect y="22" width="${width}" height="14" fill="${THEME.bar}"/>
  <circle cx="22" cy="16" r="5.5" fill="${THEME.red}80"/>
  <circle cx="42" cy="16" r="5.5" fill="${THEME.yellow}80"/>
  <circle cx="62" cy="16" r="5.5" fill="${THEME.green}80"/>
  <text x="${width / 2}" y="20" text-anchor="middle" fill="${THEME.muted}" font-size="12">${esc(title)}</text>
${text}
</svg>
`;
}

function shot(name, title, ansi) {
  const path = join(OUT, name);
  writeFileSync(path, toSVG(title, ansi));
  console.log(`wrote ${path} (${ansi.split('\n').length} lines)`);
}

// --- the three screenshots ---

const demo = buildDemo();

const table = rotgauge(demo);
if (table.code !== 0) throw new Error(`default run failed: ${table.err}`);
shot('output-table.svg', 'rotgauge', table.out);

const agent = rotgauge(demo, '--agent');
if (agent.code !== 0) throw new Error(`--agent failed: ${agent.err}`);
shot('output-agent.svg', 'rotgauge --agent', agent.out);

if (rotgauge(demo, '--save-baseline', '--quiet').code !== 0) throw new Error('--save-baseline failed');
write(demo, { 'src/input.js': INPUT_ROTTED });
const check = rotgauge(demo, '--check', '5');
if (check.code !== 1) throw new Error(`expected --check to fail, exit ${check.code}: ${check.err}`);
shot('output-check.svg', 'rotgauge --check 5', check.out + check.err);
