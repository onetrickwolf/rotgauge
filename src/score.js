// Composite score, its named contributions, and the per-repo outlier ranking
// behind the "dominant signals" column of --agent output.

export function computeScore(m) {
  const effectiveLoc = Math.max(0, m.loc - m.templateLiteralLOC);
  let raw =
    effectiveLoc * 0.15 +
    m.fanOut * 8 +
    m.fanIn * 1 +
    m.exports * 3 +
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
    m.functions * 3 +
    m.maxFnComplexity * 0.3 +
    m.maxNesting * 6 +
    (m.loc > 100 && m.commentRatio < 0.05 ? 5 : 0);

  if (m.isHTML) {
    raw += m.inlineCssLOC * 0.25; // large inline CSS = harder to edit
    raw += m.inlineHandlers * 3; // inline handlers mix concerns
  }

  return Math.round(raw / 8);
}

// Named score contributions, largest first — used by --agent output.
export function scoreContributions(m) {
  const effectiveLoc = Math.max(0, m.loc - m.templateLiteralLOC);
  const terms = [
    ['size', effectiveLoc * 0.15],
    ['fan-out', m.fanOut * 8],
    ['fan-in', m.fanIn * 1],
    ['exports', m.exports * 3],
    ['module mutable state', m.moduleLets * 12 + m.moduleMutations * 10],
    ['closure state', m.closureLets * 5 + m.closureMutations * 3],
    ['instance state (this.*)', m.thisMutations * 5],
    ['const-object mutations', m.constObjMutations * 1],
    ['local mutable state', (m.letCount - m.moduleLets - m.closureLets) * 2 + (m.mutations - m.moduleMutations - m.closureMutations) * 1],
    ['param mutations', m.paramPropMutations * 2],
    ['wide interfaces', Math.max(0, m.maxDestructureWidth - 5) * 3 + Math.max(0, m.maxParamCount - 4) * 2],
    ['function count/size', m.functions * 3 + m.maxFnComplexity * 0.3],
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
