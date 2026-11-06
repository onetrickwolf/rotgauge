// The --check gate: what fails, what is merely named, and what to do about it.

import { checkFinding } from './score.js';
import { docBudgetFailures } from './budgets.js';

// Advice is said once per kind of failure, and only when that kind fires. A
// rule read at the moment it is tripped costs nothing on the turns it is not;
// the same sentence in an always-loaded AGENTS.md is paid for on every turn.
export const ADVICE = {
  code: 'Code: extract a seam (shared mutable state first) rather than raising the baseline. `--ratchet` records a drop; `--save-baseline` accepts every current score, in a diff a reviewer sees.',
  born: 'New files are held to the bands as if born green: one born yellow or red is a seam to extract before it lands, or `--ratchet` records it as it is.',
  doc: 'Docs score by tokens and stale refs (6 each). Replace the sentence that went false instead of adding one; fix or drop a dead path.',
  budget: 'Budgets: a file\'s facts belong in its header comment, narrative in the commit message. A cap is raised in .rotgauge.json by a decision someone signs, never by a rebaseline.',
  total: 'Docs total: it only moves down. Trim elsewhere to add here, then `--ratchet` records the new total.',
  totalBudget: 'Docs total: trim, or raise `totalTokens` in .rotgauge.json by a decision someone signs.',
  allow: 'Location: move the doc into an allowed location or delete it; a report or session note belongs in the commit message.',
};

// Prints findings and returns the exit code. `note` carries the lines that are
// not failures (exempt files the gate let through, the clean summary): stdout
// normally, stderr under --json/--agent where stdout is the document itself.
export function runCheck({ everything, docResults, baseline, budgets, docs, threshold, isExempt, note }) {
  if (docs && docs.ratchet && docs.totalTokens === null) {
    console.error('docs.ratchet is on but docs.totalTokens is unset: run rotgauge --ratchet to record the current total.');
    return 1;
  }
  const byDoc = new Map(docResults.map((d) => [d.name, d]));
  const failures = [];
  const exemptOver = [];
  const kinds = new Set();
  let exemptCount = 0;
  for (const r of everything) {
    const exempt = isExempt(r.name);
    if (exempt) exemptCount++;
    const base = baseline[r.name];
    if (!base && exempt) continue; // untracked by design: the baseline holds no entry for it
    const doc = byDoc.get(r.name);
    let finding = checkFinding(r.score, base ? base.score : null, threshold, Boolean(doc));
    if (!finding) continue;
    if (doc) finding += `; ~${doc.tokens} tokens, ${doc.staleRefs} stale ref${doc.staleRefs === 1 ? '' : 's'}`;
    if (exempt) { exemptOver.push(`${r.name}: ${finding} (exempt)`); continue; }
    failures.push(`${r.name}: ${finding}`);
    kinds.add(doc ? 'doc' : base ? 'code' : 'born');
  }
  for (const line of failures) console.error(line);
  // Exemptions are never silent: name what the gate let through.
  for (const line of exemptOver) note(line);
  // Budgets are absolute: they catch the new doc the delta check cannot see.
  const budgetReport = docBudgetFailures(docResults, budgets, isExempt);
  for (const line of budgetReport.exempt) note(line);
  for (const line of budgetReport.failures) console.error(line);
  for (const kind of budgetReport.kinds) kinds.add(kind === 'total' && !(docs && docs.ratchet) ? 'totalBudget' : kind);

  if (failures.length > 0 || budgetReport.failures.length > 0) {
    console.error('');
    for (const kind of Object.keys(ADVICE)) if (kinds.has(kind)) console.error(`  ${ADVICE[kind]}`);
    const parts = [];
    if (failures.length > 0) parts.push(`${failures.length} file(s) failed the check at +${threshold} over baseline`);
    if (budgetReport.failures.length > 0) parts.push(`${budgetReport.failures.length} doc budget failure(s)`);
    console.error(`\n${parts.join('; ')}.`);
    return 1;
  }
  const checked = everything.length - exemptCount;
  note(`rotgauge --check: clean (${checked} file(s) checked at +${threshold} over baseline${exemptCount ? `, ${exemptCount} exempt` : ''})`);
  return 0;
}
