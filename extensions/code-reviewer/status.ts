/**
 * Pure `/review-status` report builder.
 *
 * A read-only glance at `.code-reviewer/context.md` health: placeholder/empty
 * sections, presence of the high-value sections, active lenses, and a
 * caller-computed staleness line. IO (git, fs stat, lens discovery) lives in the
 * command; this stays pure so it is unit-testable.
 */

import {
  SECTION_CRITICAL_INVARIANTS,
  SECTION_INTENTIONAL_PATTERNS,
  isSectionEmpty,
  parseSections,
  sectionHasPlaceholders,
} from './context';

export type StatusInput = {
  content: string;
  activeLenses: string[];
  /** One-line staleness signal (already formatted), or null when unknown. */
  stalenessLine: string | null;
};

/** Sections still holding template `<placeholders>` or empty (unfinished). */
function unfinishedSections(content: string): string[] {
  const out: string[] = [];
  for (const title of parseSections(content).keys()) {
    if (sectionHasPlaceholders(content, title) || isSectionEmpty(content, title)) {
      out.push(title);
    }
  }
  return out;
}

export function buildStatusReport(input: StatusInput): string {
  const { content, activeLenses, stalenessLine } = input;
  const lines: string[] = ['code-reviewer status:'];

  const unfinished = unfinishedSections(content);
  if (unfinished.length > 0) {
    lines.push(`  ⚠ unfinished sections: ${unfinished.join(', ')}`);
  } else {
    lines.push('  ✓ all sections filled');
  }

  const missingHighValue: string[] = [];
  if (isSectionEmpty(content, SECTION_CRITICAL_INVARIANTS)) {
    missingHighValue.push(SECTION_CRITICAL_INVARIANTS);
  }
  if (isSectionEmpty(content, SECTION_INTENTIONAL_PATTERNS)) {
    missingHighValue.push(SECTION_INTENTIONAL_PATTERNS);
  }
  if (missingHighValue.length > 0) {
    lines.push(
      `  ⚠ missing high-value: ${missingHighValue.join(', ')} — reviews lose most project signal`,
    );
  }

  lines.push(`  lenses: ${activeLenses.length > 0 ? activeLenses.join(', ') : 'none'}`);

  if (stalenessLine) lines.push(`  ${stalenessLine}`);

  // Next-command recommendation.
  if (unfinished.length > 0 || missingHighValue.length > 0) {
    lines.push('  → run /review-init to refresh/merge the context');
  } else {
    lines.push('  → healthy; /review to run, /review-learn to fold in a miss');
  }

  return lines.join('\n');
}
