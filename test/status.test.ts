import { describe, expect, test } from 'bun:test';

import { buildStatusReport } from '../extensions/code-reviewer/status';

const FILLED = `# Review Context — demo

## Critical invariants
- **Tokens redacted before logging:** owner \`logger.ts\`. Breaks → leak.

## Intentional patterns (false-positive suppressors)
- **Unchecked env reads:** validated at boot in \`config.ts\`.
`;

const PLACEHOLDER = `# Review Context — demo

## Critical invariants
- **<invariant>:** owner \`path\`. Breaks → <impact>.

## Intentional patterns (false-positive suppressors)
`;

describe('buildStatusReport', () => {
  test('healthy context reports filled sections and lens names', () => {
    const report = buildStatusReport({
      content: FILLED,
      activeLenses: ['security', 'concurrency'],
      stalenessLine: 'staleness: context updated 2 days ago; 3 commit(s) to the tree since',
    });
    expect(report).toContain('✓ all sections filled');
    expect(report).toContain('lenses: security, concurrency');
    expect(report).toContain('staleness:');
    expect(report).toContain('→ healthy');
  });

  test('flags placeholder + empty high-value sections and recommends init', () => {
    const report = buildStatusReport({
      content: PLACEHOLDER,
      activeLenses: [],
      stalenessLine: null,
    });
    expect(report).toContain('unfinished sections');
    expect(report).toContain('Critical invariants');
    expect(report).toContain('missing high-value');
    expect(report).toContain('lenses: none');
    expect(report).toContain('→ run /review-init');
  });

  test('omits the staleness line when it is unknown', () => {
    const report = buildStatusReport({ content: FILLED, activeLenses: [], stalenessLine: null });
    expect(report).not.toContain('staleness:');
  });
});
