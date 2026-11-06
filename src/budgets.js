// Doc budgets: absolute caps from .rotgauge.json, applied on top of the delta
// gate. The delta gate only compares files that have a baseline entry, so a
// repo can rot by accretion: forty new report files, each small, each new.
// Budgets close that hole. `allow` names the places docs may live, `budgets`
// caps tokens per pattern (first match wins), `totalTokens` caps the whole
// scanned set. A budget failure says which cap it broke; raising a cap is a
// decision someone makes in the config, not a rebaseline.

import { globToRegExp } from './config.js';

// Annotates each doc result (allowed, budgetTokens, overBudget) and returns the
// totals. Returns null when the config carries no docs section.
export function applyDocBudgets(docResults, docs) {
  if (!docs) return null;
  const allow = docs.allow ? docs.allow.map(globToRegExp) : null;
  const budgets = docs.budgets.map((b) => ({ re: globToRegExp(b.match), tokens: b.tokens }));
  let totalTokens = 0;
  for (const r of docResults) {
    r.allowed = allow ? allow.some((re) => re.test(r.name)) : true;
    const budget = budgets.find((b) => b.re.test(r.name));
    r.budgetTokens = budget ? budget.tokens : null;
    r.overBudget = budget ? r.tokens > budget.tokens : false;
    totalTokens += r.tokens;
  }
  return {
    totalTokens,
    totalBudget: docs.totalTokens,
    overTotal: docs.totalTokens !== null && totalTokens > docs.totalTokens,
    ratchet: docs.ratchet,
  };
}

// What --check reports for a budgeted scan: `failures` fail the gate;
// `exempt` are the same findings on exempt files, which the gate lets through
// but names, never silently; `kinds` says which rules failed (allow, budget,
// total) so the gate can say once what to do about each. Exempt files still
// count toward the total: an exemption means "do not gate this file", not
// "pretend it costs nothing".
export function docBudgetFailures(docResults, summary, isExempt = () => false) {
  const failures = [];
  const exempt = [];
  const kinds = new Set();
  if (!summary) return { failures, exempt, kinds };
  for (const r of docResults) {
    const findings = [];
    if (!r.allowed) findings.push(['allow', `${r.name}: not an allowed doc location (.rotgauge.json "docs.allow")`]);
    if (r.overBudget) {
      const auto = r.autoLoaded ? ', auto-loaded every turn' : '';
      findings.push(['budget', `${r.name}: ~${r.tokens} tokens over its ${r.budgetTokens}-token budget${auto}`]);
    }
    if (isExempt(r.name)) exempt.push(...findings.map(([, line]) => `${line} (exempt)`));
    else for (const [kind, line] of findings) { failures.push(line); kinds.add(kind); }
  }
  if (summary.overTotal) {
    failures.push(summary.ratchet
      ? `docs: ~${summary.totalTokens} tokens over the recorded total of ${summary.totalBudget} (it only moves down)`
      : `docs: ~${summary.totalTokens} tokens over the ${summary.totalBudget}-token total budget`);
    kinds.add('total');
  }
  return { failures, exempt, kinds };
}
