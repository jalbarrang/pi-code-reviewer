import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  buildInlineSummary,
  buildLensResult,
  buildPointer,
  buildSinglePassResult,
  pickLensToolOutputs,
  renderTieredReport,
  runToolsEffect,
} from '../extensions/code-reviewer/reviewer';
import type {
  EngineResult,
  EngineTelemetry,
  Finding,
  LensConfig,
} from '../extensions/code-reviewer/types';
import type { DiffSource } from '../extensions/code-reviewer/diff';
import { fakeExecutor } from './helpers';

const lens: LensConfig = {
  name: 'Code Quality',
  description: 'desc',
  criteria: 'no dead code',
  tools: ['bun run lint', 'bun run typecheck'],
  severityRules: { blocker: 'b', warning: 'w', note: 'n' },
};

const opts = { timeoutMs: 60_000, concurrency: 4 };

const diffSource: DiffSource = { diff: 'x', stat: 's', label: 'all uncommitted changes' };

function telemetry(over: Partial<EngineTelemetry> = {}): EngineTelemetry {
  return {
    discoveryCount: 0,
    postVerificationCount: null,
    finalCount: 0,
    verification: 'no-findings',
    finderModel: 'default',
    verifierModel: 'default',
    ...over,
  };
}

function engineResult(over: Partial<EngineResult> = {}): EngineResult {
  return {
    findings: [],
    dismissed: [],
    lensFindings: {},
    telemetry: telemetry(),
    ...over,
  };
}

const critical: Finding = {
  file: 'src/auth/session.ts',
  lineRange: '42',
  category: 'security',
  severity: 9,
  confidence: 90,
  summary: 'token not validated',
  reasoning: 'reachable',
};

const important: Finding = {
  file: 'src/api/handler.ts',
  lineRange: '10-14',
  category: 'null-safety',
  severity: 6,
  confidence: 70,
  summary: 'possible null deref',
  reasoning: 'missing guard',
};

const minorUnverified: Finding = {
  file: 'src/util/fmt.ts',
  lineRange: '3',
  category: 'logic',
  severity: 4,
  confidence: 55,
  summary: 'edge case',
  reasoning: 'unlikely',
  unverified: true,
  unverifiedTag: 'unverified — below verification threshold',
};

const belowFloor: Finding = {
  file: 'src/util/noise.ts',
  category: 'logic',
  severity: 2,
  confidence: 30,
  summary: 'noise',
  reasoning: 'ignore',
};

describe('renderTieredReport', () => {
  test('clean run plainly says no confirmed findings, never invents concerns', () => {
    const report = renderTieredReport(engineResult(), diffSource, []);
    expect(report).toContain('No confirmed findings');
    expect(report).toContain('✅');
    expect(report).not.toContain('## Critical');
    expect(report).toContain('**Lenses**: none');
    expect(report).toContain('**Verification**: skipped (low-risk diff; no findings)');
  });

  test('finder failure is inconclusive, not a clean check', () => {
    const report = renderTieredReport(
      engineResult({
        telemetry: telemetry({ finderFailed: true, finderErrorSample: 'model x unavailable' }),
      }),
      diffSource,
      [],
    );
    expect(report).not.toContain('✅');
    expect(report).toContain('Inconclusive');
    expect(report).toContain('model x unavailable');
  });

  test('buckets findings into the highest tier they qualify for', () => {
    const report = renderTieredReport(
      engineResult({
        findings: [critical, important, minorUnverified, belowFloor],
        telemetry: telemetry({
          discoveryCount: 4,
          postVerificationCount: 3,
          finalCount: 3,
          verification: 'ran',
        }),
      }),
      diffSource,
      ['code-quality'],
      ['src/auth/session.ts', 'src/api/handler.ts', 'src/util/fmt.ts', 'src/util/noise.ts'],
    );

    expect(report).toContain('## Critical (1)');
    expect(report).toContain('🔴 **Critical** `src/auth/session.ts:42` — token not validated');
    expect(report).toContain('## Important (1)');
    expect(report).toContain('🟡 **Important** `src/api/handler.ts:10-14`');
    expect(report).toContain('## Minor (1)');
    expect(report).toContain('🔵 **Minor** `src/util/fmt.ts:3`');
    // Below-floor finding (sev 2 / conf 30) is dropped, not shown.
    expect(report).not.toContain('src/util/noise.ts');
  });

  test('tags unverified findings and skips verification label', () => {
    const report = renderTieredReport(
      engineResult({
        findings: [minorUnverified],
        telemetry: telemetry({
          discoveryCount: 1,
          postVerificationCount: null,
          finalCount: 1,
          verification: 'skipped',
        }),
      }),
      diffSource,
      [],
    );
    expect(report).toContain('unverified — below verification threshold');
    expect(report).toContain('**Verification**: skipped (low-risk diff)');
    expect(report).toContain('- post-verification: n/a');
  });

  test('maps lens blocker/warning/note to tiers', () => {
    const report = renderTieredReport(
      engineResult({
        lensFindings: {
          security: [{ file: 'a.ts', line: 1, severity: 'blocker', message: 'xss' }],
          quality: [{ file: 'b.ts', severity: 'note', message: 'dead code' }],
        },
        telemetry: telemetry({ discoveryCount: 0, finalCount: 2, verification: 'ran' }),
      }),
      diffSource,
      ['security', 'quality'],
    );
    expect(report).toContain('## Critical (1)');
    expect(report).toContain('🔴 **blocker** `a.ts:1` — xss _(lens: security)_');
    expect(report).toContain('## Minor (1)');
    expect(report).toContain('🔵 **note** `b.ts` — dead code _(lens: quality)_');
  });

  test('renders Dismissed only when the verifier produced dismissals', () => {
    const withDismissals = renderTieredReport(
      engineResult({
        findings: [critical],
        dismissed: [{ finding: important, reason: 'guarded upstream' }],
        telemetry: telemetry({
          discoveryCount: 2,
          postVerificationCount: 1,
          finalCount: 1,
          verification: 'ran',
        }),
      }),
      diffSource,
      [],
    );
    expect(withDismissals).toContain('## Dismissed (1)');
    expect(withDismissals).toContain('guarded upstream');

    const noDismissals = renderTieredReport(
      engineResult({ findings: [critical], telemetry: telemetry({ verification: 'skipped' }) }),
      diffSource,
      [],
    );
    expect(noDismissals).not.toContain('## Dismissed');
  });

  test('metadata reports files reviewed, discovery, post-verification and final counts', () => {
    const report = renderTieredReport(
      engineResult({
        findings: [critical, important],
        telemetry: telemetry({
          discoveryCount: 5,
          postVerificationCount: 2,
          finalCount: 2,
          verification: 'ran',
        }),
      }),
      diffSource,
      ['code-quality'],
      ['a.ts', 'b.ts', 'c.ts'],
    );
    expect(report).toContain('**Lenses**: code-quality');
    expect(report).toContain('**Verification**: ran');
    expect(report).toContain('- files reviewed: 3');
    expect(report).toContain('- discovery: 5');
    expect(report).toContain('- post-verification: 2');
    expect(report).toContain('- final: 2');
  });
});

describe('runToolsEffect', () => {
  test('captures stdout, and degrades a failed/timed-out tool gracefully', async () => {
    const { layer } = fakeExecutor((_cmd, args) => {
      const script = args[args.length - 1];
      if (script === 'bun run lint') return { stdout: 'lint clean', stderr: '' };
      return { fail: new Error('typecheck blew up') };
    });

    const outputs = await Effect.runPromise(
      runToolsEffect('/repo', lens.tools, opts, undefined).pipe(Effect.provide(layer)),
    );

    expect(outputs['bun run lint']).toBe('lint clean');
    expect(outputs['bun run typecheck']).toBe('(tool failed or timed out: bun run typecheck)');
  });

  test('dedupes commands shared across lenses — each runs ONCE', async () => {
    const { layer, calls } = fakeExecutor(() => ({ stdout: 'ok', stderr: '' }));

    // Two lenses' worth of tools, with overlap. Simulates the union the
    // command layer passes in.
    const union = [...new Set([...lens.tools, 'bun run lint', 'bun run test'])];
    const outputs = await Effect.runPromise(
      runToolsEffect('/repo', union, opts, undefined).pipe(Effect.provide(layer)),
    );

    // 'bun run lint' appeared twice across the inputs but executes once.
    const lintCalls = calls.filter((c) => c.args[c.args.length - 1] === 'bun run lint');
    expect(lintCalls).toHaveLength(1);
    expect(calls).toHaveLength(3); // lint, typecheck, test — distinct only
    expect(Object.keys(outputs).sort()).toEqual([
      'bun run lint',
      'bun run test',
      'bun run typecheck',
    ]);
  });

  test('respects an already-aborted signal by running no tools', async () => {
    const { layer, calls } = fakeExecutor(() => ({ stdout: 'x', stderr: '' }));
    const controller = new AbortController();
    controller.abort();

    const outputs = await Effect.runPromise(
      runToolsEffect('/repo', lens.tools, opts, controller.signal).pipe(Effect.provide(layer)),
    );

    expect(calls).toHaveLength(0);
    expect(outputs).toEqual({});
  });

  test('no tools → no executor calls', async () => {
    const { layer, calls } = fakeExecutor(() => ({ stdout: 'x', stderr: '' }));
    const outputs = await Effect.runPromise(
      runToolsEffect('/repo', [], opts, undefined).pipe(Effect.provide(layer)),
    );
    expect(calls).toHaveLength(0);
    expect(outputs).toEqual({});
  });
});

describe('pickLensToolOutputs', () => {
  test('selects only the tools a lens declares from the shared output map', () => {
    const all = { 'bun run lint': 'L', 'bun run typecheck': 'T', 'bun run test': 'X' };
    expect(pickLensToolOutputs(lens, all)).toEqual({
      'bun run lint': 'L',
      'bun run typecheck': 'T',
    });
  });
});

describe('buildInlineSummary', () => {
  test('lists lens names and the diff label', () => {
    const summary = buildInlineSummary(['code-quality', 'maintainability'], diffSource);
    expect(summary).toContain('# Code Review Summary');
    expect(summary).toContain('code-quality, maintainability');
    expect(summary).toContain('all uncommitted changes');
  });

  test('condenses a git diffstat summary line into files/+/-', () => {
    const summary = buildInlineSummary(['code-quality'], {
      diff: 'x',
      label: 'all uncommitted changes',
      stat: ' a.ts | 2 +-\n b.ts | 5 +++--\n 2 files changed, 340 insertions(+), 89 deletions(-)',
    });
    expect(summary).toContain('all uncommitted changes (2 files, +340, -89)');
  });

  test('falls back to just the label when the diffstat has no summary line', () => {
    const summary = buildInlineSummary(['code-quality'], {
      diff: 'x',
      label: 'all uncommitted changes',
      stat: '',
    });
    expect(summary).toContain('- **Diff**: all uncommitted changes');
  });

  test('handles an empty lens list', () => {
    expect(buildInlineSummary([], diffSource)).toContain('**Lenses**: (none)');
  });
});

describe('buildPointer', () => {
  const pointer = { path: '/tmp/pi-code-review-123.md', bytes: 96_000, lines: 842 };

  test('single-pass: path, KB size, line count and a read offset/limit directive', () => {
    const out = buildPointer(pointer, 'single-pass');
    expect(out).toContain('/tmp/pi-code-review-123.md');
    expect(out).toContain('842 lines');
    expect(out).toContain('94KB'); // 96000 / 1024 rounded
    expect(out).toContain('Read that file');
    expect(out).toContain('offset/limit');
  });

  test('rounds tiny files up to at least 1KB', () => {
    const out = buildPointer({ path: '/tmp/x.md', bytes: 10, lines: 1 }, 'single-pass');
    expect(out).toContain('1KB');
  });
});

describe('buildLensResult', () => {
  test('embeds the lens body + tool outputs in the lens section (no diff inside)', () => {
    const result = buildLensResult(lens, '# lens body', { 'bun run lint': 'lint clean' });

    expect(result.lens).toBe('Code Quality');
    expect(result.toolOutputs?.['bun run lint']).toBe('lint clean');
    expect(result._lensSection).toContain('Code Quality');
    expect(result._lensSection).toContain('# lens body');
    expect(result._lensSection).toContain('lint clean');
    // The diff is assembled once by the command layer, never per lens.
    expect(result._lensSection).not.toContain('diff --git a b');
  });
});

// Tool-result content is `(TextContent | ImageContent)[]`; these helpers only
// ever emit text, so narrow to the text payload for assertions.
function firstText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  return block?.type === 'text' && block.text !== undefined ? block.text : '';
}

// A spy writer that records the spilled content and returns a fake pointer.
function okWriter() {
  const calls: string[] = [];
  const write = async (content: string) => {
    calls.push(content);
    return {
      path: '/tmp/pi-code-review-test.md',
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content.split('\n').length,
    };
  };
  return { write, calls };
}

// A writer that fails, simulating a read-only TMPDIR / full disk.
function failWriter() {
  const calls: string[] = [];
  const write = async (content: string) => {
    calls.push(content);
    throw new Error('EROFS: read-only file system');
  };
  return { write, calls };
}

const singlePassArgs = {
  results: [buildLensResult(lens, '# lens body', { 'bun run lint': 'lint clean' })],
  diff: diffSource,
  lensNames: ['code-quality'],
  availableLenses: ['code-quality', 'maintainability'],
  changedFiles: ['a.ts'],
};

describe('buildSinglePassResult', () => {
  test('spills the full context and returns a summary + pointer', async () => {
    const writer = okWriter();
    const result = await buildSinglePassResult(singlePassArgs, writer.write);

    // The full lens context was written to disk, not returned inline.
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]).toContain('# lens body');

    const text = firstText(result);
    expect(text).toContain('# Code Review Summary');
    expect(text).toContain('code-quality');
    expect(text).toContain('/tmp/pi-code-review-test.md');
    expect(text).toContain('Read that file');
    expect(result.details.mode).toBe('single-pass');
    expect(result.details.contextFile).toBe('/tmp/pi-code-review-test.md');
  });

  test('no applicable lenses → notice, and never touches the disk', async () => {
    const writer = okWriter();
    const result = await buildSinglePassResult(
      { ...singlePassArgs, results: [], lensNames: [] },
      writer.write,
    );

    expect(writer.calls).toHaveLength(0);
    expect(firstText(result)).toContain('No applicable lenses');
    expect(result.details).not.toHaveProperty('contextFile');
  });

  test('write failure degrades to inline context instead of throwing', async () => {
    const writer = failWriter();
    const updates: string[] = [];
    const result = await buildSinglePassResult(singlePassArgs, writer.write, (u) =>
      updates.push(firstText(u)),
    );

    // Falls back to the full inline context (truncation-prone but a real review).
    expect(firstText(result)).toContain('# lens body');
    expect(firstText(result)).toContain('## Instructions');
    expect(result.details).not.toHaveProperty('contextFile');
    expect(updates.some((u) => u.includes('temp-file write failed'))).toBe(true);
  });
});
