import { describe, expect, test } from 'bun:test';

import { buildFallbackReviewPrompt } from '../extensions/code-reviewer/engine';
import { resolveLensNames } from '../extensions/code-reviewer/run';

describe('resolveLensNames', () => {
  const available = new Map<string, unknown>([
    ['security', {}],
    ['concurrency', {}],
  ]);

  test('explicit request wins and unknown lenses warn + drop', () => {
    const warnings: string[] = [];
    const names = resolveLensNames(['security', 'nope'], ['concurrency'], available, (m) =>
      warnings.push(m),
    );
    expect(names).toEqual(['security']);
    expect(warnings[0]).toContain('nope');
  });

  test('falls back to defaults, then to all available', () => {
    expect(resolveLensNames(undefined, ['concurrency'], available)).toEqual(['concurrency']);
    expect(resolveLensNames(undefined, [], available)).toEqual(['security', 'concurrency']);
  });

  test('empty available + no defaults → zero lenses (valid)', () => {
    expect(resolveLensNames(undefined, [], new Map())).toEqual([]);
  });
});

describe('buildFallbackReviewPrompt', () => {
  test('embeds context, diff, changed files, and lens instructions', () => {
    const prompt = buildFallbackReviewPrompt({
      contextMarkdown: '## Critical invariants\n- do not leak tokens',
      diff: '@@ -1 +1 @@\n-old\n+new',
      changedFiles: { 'src/a.ts': 'const a = 1;' },
      lensInstructions: '### Lens: Security',
    });
    expect(prompt).toContain('Critical invariants');
    expect(prompt).toContain('+new');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('Lens: Security');
    // Not a generic prompt — carries the project review context header.
    expect(prompt).toContain('Project review context');
  });
});
