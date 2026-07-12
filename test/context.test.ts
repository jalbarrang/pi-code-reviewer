import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { resolve } from 'node:path';

import {
  NOT_INITIALIZED,
  SECTION_CRITICAL_INVARIANTS,
  SECTION_INTENTIONAL_PATTERNS,
  extractGateSections,
  getContextPath,
  getSectionBody,
  hasPlaceholders,
  hasSection,
  isSectionEmpty,
  loadReviewContextEffect,
  parseSections,
  sectionHasPlaceholders,
} from '../extensions/code-reviewer/context';
import { fileSystemLayer } from './helpers';

const cwd = '/repo';
const contextPath = getContextPath(cwd);

function runLoad(opts: Parameters<typeof fileSystemLayer>[0]) {
  return Effect.runPromise(
    loadReviewContextEffect(cwd).pipe(Effect.provide(fileSystemLayer(opts))),
  );
}

const SAMPLE_CONTEXT = `# Review Context — demo

## Mode signals
Default: uncommitted diff.

## Critical invariants
- **Auth tokens redacted:** owner \`src/auth/logger.ts\`. Breaks → credential leak.
- **Session TTL enforced:** owner \`session\`. Breaks → stale sessions.

## Intentional patterns (false-positive suppressors)
- **Lazy init:** looks like a race; intentional because single-threaded bootstrap.

## Historical bug classes
- **Null deref in parsers:** trigger missing guard in \`src/parsers/\`, impact crash on bad input.

## Review priorities
1. Auth paths
`;

describe('loadReviewContextEffect', () => {
  test('returns null when context.md is missing', async () => {
    const ctx = await runLoad({});
    expect(ctx).toBeNull();
  });

  test('returns path and content when context.md exists', async () => {
    const ctx = await runLoad({ files: { [contextPath]: SAMPLE_CONTEXT } });
    expect(ctx).toEqual({ path: contextPath, content: SAMPLE_CONTEXT });
  });

  test('resolves context under .code-reviewer/context.md', () => {
    expect(contextPath).toBe(resolve(cwd, '.code-reviewer/context.md'));
  });
});

describe('NOT_INITIALIZED', () => {
  test('is the exact hard-fail message', () => {
    expect(NOT_INITIALIZED).toBe(
      'code-reviewer is not initialized for this project — run /review-init first.',
    );
  });
});

describe('parseSections', () => {
  test('indexes bodies by ## heading title', () => {
    const sections = parseSections(SAMPLE_CONTEXT);
    expect(sections.get(SECTION_CRITICAL_INVARIANTS)).toContain('Auth tokens redacted');
    expect(sections.get('Review priorities')).toBe('1. Auth paths');
  });
});

describe('placeholder and section helpers', () => {
  const withPlaceholder = `## Critical invariants
- **<invariant>:** owner \`path\`.`;

  test('hasPlaceholders detects angle-bracket template tokens', () => {
    expect(hasPlaceholders(withPlaceholder)).toBe(true);
    expect(hasPlaceholders(SAMPLE_CONTEXT)).toBe(false);
  });

  test('hasSection and getSectionBody reflect heading presence', () => {
    expect(hasSection(SAMPLE_CONTEXT, SECTION_CRITICAL_INVARIANTS)).toBe(true);
    expect(hasSection(SAMPLE_CONTEXT, 'Missing section')).toBe(false);
    expect(getSectionBody(SAMPLE_CONTEXT, SECTION_INTENTIONAL_PATTERNS)).toContain('Lazy init');
    expect(getSectionBody(SAMPLE_CONTEXT, 'Missing section')).toBeNull();
  });

  test('isSectionEmpty flags missing or blank sections', () => {
    const blank = `## Critical invariants

## Historical bug classes
- real content`;

    expect(isSectionEmpty(blank, SECTION_CRITICAL_INVARIANTS)).toBe(true);
    expect(isSectionEmpty(blank, 'Historical bug classes')).toBe(false);
    expect(isSectionEmpty(SAMPLE_CONTEXT, 'Missing section')).toBe(true);
  });

  test('sectionHasPlaceholders scopes placeholder detection to one section', () => {
    expect(sectionHasPlaceholders(withPlaceholder, SECTION_CRITICAL_INVARIANTS)).toBe(true);
    expect(sectionHasPlaceholders(SAMPLE_CONTEXT, SECTION_CRITICAL_INVARIANTS)).toBe(false);
  });
});

describe('extractGateSections', () => {
  test('collects unique backticked path-like tokens from gate sections only', () => {
    const tokens = extractGateSections(SAMPLE_CONTEXT);
    expect(tokens.sort()).toEqual(['session', 'src/auth/logger.ts', 'src/parsers/'].sort());
  });

  test('ignores backticks outside Critical invariants and Historical bug classes', () => {
    const content = `## Intentional patterns (false-positive suppressors)
- owner \`ignored.ts\`

## Critical invariants
- owner \`kept.ts\``;

    expect(extractGateSections(content)).toEqual(['kept.ts']);
  });

  test('returns an empty array when gate sections are absent', () => {
    expect(extractGateSections('# Review Context\n\n## Mode signals\nnone')).toEqual([]);
  });
});
