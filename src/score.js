// Composite score, its named contributions, and the per-repo outlier ranking
// behind the "dominant signals" column of --agent output.

// Three things are pointers, not units, and weigh less than what they pass for:
// a type-only import (a contract the compiler checks), a re-export (a barrel
// line) and a callback written inline as a call argument or JSX attribute (part
// of its statement). At full weight they made composition roots and barrels
// score as hubs, and extracting a seam cost more than it saved.
export function computeScore(m) {
  const effectiveLoc = Math.max(0, m.loc - m.templateLiteralLOC);
  let raw =
    effectiveLoc * 0.15 +
    fanOutRaw(m) +
    m.fanIn * 1 +
    exportsRaw(m) +
    m.moduleLets * 12 +
    m.moduleMutations * 10 +
    m.closureLets * 5 +
    m.closureMutations * 3 +
    m.constObjMutations * 1 +
    m.thisMutations * 5 +
    (m.letCount - m.moduleLets - m.closureLets) * 2 +
    (m.mutations - m.moduleMutations - m.closureMutations) * 1 +
    m.paramPropMutations * 2 +
    Math.max(0, m.maxDestructureWidth - 5) * 3 +
    Math.max(0, m.maxParamCount - 4) * 2 +
    functionsRaw(m) +
    m.maxFnComplexity * 0.3 +
    m.maxNesting * 6 +
    (m.loc > 100 && m.commentRatio < 0.05 ? 5 : 0);

  if (m.isHTML) {
    raw += m.inlineCssLOC * 0.25; // large inline CSS = harder to edit
    raw += m.inlineHandlers * 3; // inline handlers mix concerns
  }

  return Math.round(raw / 8);
}

const fanOutRaw = (m) => (m.fanOut - (m.typeImports || 0)) * 8 + (m.typeImports || 0) * 2;
const exportsRaw = (m) => (m.exports - (m.reExports || 0)) * 3 + (m.reExports || 0) * 1;
const functionsRaw = (m) => (m.functions - (m.callbacks || 0)) * 3 + (m.callbacks || 0) * 1;

// Severity bands: green under 40, yellow from 40, red from 60.
export const YELLOW = 40;
export const RED = 60;
export function scoreBand(score) {
  return score >= RED ? 'red' : score >= YELLOW ? 'yellow' : 'green';
}
const BAND_RANK = { green: 0, yellow: 1, red: 2 };

// What --check holds against a file with a baseline entry, or null when it
// passes. A green code file may grow: the gauge calls it fine to edit, and
// failing every rise there turns the baseline into a ceiling every live file
// ends up sitting on. Turning yellow or red fails by the whole rise, whatever
// the threshold; from yellow up, rising more than the threshold fails. Docs
// keep the plain delta: their scores sit low, and budgets cap them.
export function checkFinding(score, base, threshold, isDoc = false) {
  const delta = score - base;
  if (isDoc) return delta > threshold ? `score ${score} is +${delta} over baseline ${base} (threshold ${threshold})` : null;
  const was = scoreBand(base), now = scoreBand(score);
  if (BAND_RANK[now] > BAND_RANK[was]) return `score ${score} turned ${now} (+${delta} over baseline ${base}, which was ${was})`;
  if (now !== 'green' && delta > threshold) return `score ${score} is +${delta} over baseline ${base} (threshold ${threshold}, ${now})`;
  return null;
}

// Named score contributions, largest first — used by --agent output.
export function scoreContributions(m) {
  const effectiveLoc = Math.max(0, m.loc - m.templateLiteralLOC);
  const terms = [
    ['size', effectiveLoc * 0.15],
    ['fan-out', fanOutRaw(m)],
    ['fan-in', m.fanIn * 1],
    ['exports', exportsRaw(m)],
    ['module mutable state', m.moduleLets * 12 + m.moduleMutations * 10],
    ['closure state', m.closureLets * 5 + m.closureMutations * 3],
    ['instance state (this.*)', m.thisMutations * 5],
    ['const-object mutations', m.constObjMutations * 1],
    ['local mutable state', (m.letCount - m.moduleLets - m.closureLets) * 2 + (m.mutations - m.moduleMutations - m.closureMutations) * 1],
    ['param mutations', m.paramPropMutations * 2],
    ['wide interfaces', Math.max(0, m.maxDestructureWidth - 5) * 3 + Math.max(0, m.maxParamCount - 4) * 2],
    ['function count/size', functionsRaw(m) + m.maxFnComplexity * 0.3],
    ['nesting', m.maxNesting * 6],
    ['inline css/handlers', m.isHTML ? m.inlineCssLOC * 0.25 + m.inlineHandlers * 3 : 0],
  ];
  return terms.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

// Dominant signals for --agent: rank a file's contributions by how unusual
// they are for THIS repo (ratio to the repo median), not just raw size.
// Raw sorting lets universal terms like function count/size dominate every
// row and bury the interesting outlier (a lone 27-wide destructure reads as
// noise next to a big function term, but it's the actual finding).
export function dominantSignals(results) {
  const MIN_RAW = 8; // ≈ 1 score point; below this a term isn't a signal
  const medians = new Map();
  if (results.length > 0) {
    const byLabel = new Map();
    for (const r of results) {
      const present = new Map(scoreContributions(r));
      for (const label of present.keys()) {
        if (!byLabel.has(label)) byLabel.set(label, []);
      }
    }
    for (const [label, values] of byLabel) {
      for (const r of results) {
        const c = scoreContributions(r).find(([l]) => l === label);
        values.push(c ? c[1] : 0);
      }
      values.sort((a, b) => a - b);
      medians.set(label, values[values.length >> 1]);
    }
  }

  return (r) => {
    const ranked = scoreContributions(r)
      .filter(([, v]) => v >= MIN_RAW)
      .map(([label, v]) => {
        const ratio = v / Math.max(medians.get(label) ?? 0, 4);
        return { label, v, ratio };
      })
      .sort((a, b) => b.ratio - a.ratio);
    if (ranked.length === 0) {
      const top = scoreContributions(r)[0];
      return top ? [top[0]] : [];
    }
    return ranked.slice(0, 2).map(({ label, ratio }) =>
      ratio >= 4 ? `${label} (${Math.min(99, Math.round(ratio))}× typical)` : label
    );
  };
}
