import { describe, expect, test } from 'bun:test';
import { Effect, Layer } from 'effect';

import { Reviewer, type ReviewerService } from '../extensions/code-reviewer/effects/model';
import {
  extractJsonValue,
  fileTouchesGateToken,
  loadAgentPromptBody,
  parseFinderOutput,
  parseFinderOutputStrict,
  parseVerifierOutput,
  runEngineEffect,
  shouldRunVerifier,
  stripFrontmatter,
} from '../extensions/code-reviewer/engine';
import { defaultModelPlan } from '../extensions/code-reviewer/model-plan';
import type { Finding, ReviewEngineConfig } from '../extensions/code-reviewer/types';

const CONFIG: ReviewEngineConfig = { verify: true, maxFindings: 50 };
const PLAN = defaultModelPlan();

const CONTEXT = `# Review context

## Critical invariants
- Auth tokens must be validated in \`src/auth/session.ts\` before use.

## Historical bug classes
- NaN typeof guards in \`manifest.ts\`

## Intentional patterns
- none
`;

const LOW_SEV: Finding = {
  file: 'src/utils/format.ts',
  lineRange: '10',
  category: 'logic',
  severity: 3,
  confidence: 70,
  summary: 'minor edge case',
  reasoning: 'unlikely path',
};

const HIGH_SEV: Finding = {
  file: 'src/utils/format.ts',
  lineRange: '20',
  category: 'null-safety',
  severity: 7,
  confidence: 80,
  summary: 'null deref',
  reasoning: 'missing guard',
};

const INVARIANT_FILE: Finding = {
  file: 'src/auth/session.ts',
  lineRange: '5',
  category: 'security',
  severity: 3,
  confidence: 60,
  summary: 'token check gap',
  reasoning: 'touches critical auth path',
};

function fakeReviewer(opts: {
  onFinder?: (user: string) => string;
  onVerifier?: (user: string) => string;
  failFinder?: boolean;
  failVerifier?: boolean;
}) {
  const service: ReviewerService = {
    complete: (request) => {
      if (request.stage === 'finder') {
        if (opts.failFinder) {
          return Effect.fail({
            _tag: 'ModelError',
            stage: request.stage,
            cause: new Error('finder boom'),
          } as never);
        }
        return Effect.succeed(
          opts.onFinder ? opts.onFinder(request.user) : '{"findings":[],"lenses":{}}',
        );
      }
      if (request.stage === 'verifier') {
        if (opts.failVerifier) {
          return Effect.fail({
            _tag: 'ModelError',
            stage: request.stage,
            cause: new Error('verifier boom'),
          } as never);
        }
        return Effect.succeed(opts.onVerifier ? opts.onVerifier(request.user) : '[]');
      }
      return Effect.succeed('{}');
    },
  };
  return Layer.succeed(Reviewer, service);
}

function findingsJson(findings: Finding[]): string {
  return JSON.stringify({ findings, lenses: {} });
}

const INPUT = {
  contextMarkdown: CONTEXT,
  diff: 'diff --git a/src/utils/format.ts b/src/utils/format.ts\n+x',
  changedFiles: { 'src/utils/format.ts': 'export const x = 1;\n' },
};

describe('stripFrontmatter + loadAgentPromptBody', () => {
  test('strips YAML frontmatter from markdown', () => {
    const body = stripFrontmatter('---\nname: x\n---\n\nHello agent\n');
    expect(body).toBe('Hello agent');
  });

  test('loads vendored bug-finder and bug-verifier prompt bodies', () => {
    const finder = loadAgentPromptBody('bug-finder');
    const verifier = loadAgentPromptBody('bug-verifier');
    expect(finder.startsWith('---')).toBe(false);
    expect(finder).toContain('bug-finding specialist');
    expect(verifier.startsWith('---')).toBe(false);
    expect(verifier).toContain('skeptical code-review verifier');
  });
});

describe('extractJsonValue + parseFinderOutput', () => {
  test('extracts balanced objects and arrays from fences/prose', () => {
    expect(extractJsonValue('here:\n```json\n{"a":1}\n```\nok')).toBe('{"a":1}');
    expect(extractJsonValue('noise [1, [2, 3], 4] tail')).toBe('[1, [2, 3], 4]');
    expect(extractJsonValue('no json')).toBeNull();
  });

  test('parses finder findings and drops malformed entries', () => {
    const text = JSON.stringify({
      findings: [
        HIGH_SEV,
        { file: '', severity: 5, confidence: 80, summary: 'bad' },
        { file: 'x.ts', severity: 99, confidence: 50, summary: 'clamped' },
        { file: 'y.ts', line: 3, severity: 4, confidence: 60, summary: 'line as range' },
      ],
      lenses: {
        security: [{ file: 'a.ts', line: 1, severity: 'blocker', message: 'xss' }],
        noise: [{ file: 'b.ts', severity: 'nope', message: 'drop' }],
      },
    });
    const parsed = parseFinderOutput(text);
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.findings[1].severity).toBe(10);
    expect(parsed.findings[2].lineRange).toBe('3');
    expect(parsed.lensFindings.security).toHaveLength(1);
    expect(parsed.lensFindings.noise).toBeUndefined();
  });

  test('treats "No findings." and empty text as empty', () => {
    expect(parseFinderOutput('No findings.')).toEqual({ findings: [], lensFindings: {} });
    expect(parseFinderOutput('')).toEqual({ findings: [], lensFindings: {} });
  });

  test('strict parsing distinguishes malformed output from a clean review', () => {
    expect(parseFinderOutputStrict('No findings.')).toEqual({ findings: [], lensFindings: {} });
    expect(parseFinderOutputStrict('{"findings":[],"lenses":{}}')).toEqual({
      findings: [],
      lensFindings: {},
    });
    expect(parseFinderOutputStrict('')).toBeNull();
    expect(parseFinderOutputStrict('{}')).toBeNull();
    expect(parseFinderOutputStrict('{"findings":[{"file":"missing scores"}]}')).toBeNull();
  });
});

describe('parseVerifierOutput', () => {
  test('parses CONFIRMED/DISMISSED verdicts', () => {
    const map = parseVerifierOutput(
      JSON.stringify([
        { id: 0, verdict: 'CONFIRMED', severity: 8, confidence: 90, evidence: 'path' },
        { id: 1, verdict: 'DISMISSED', reason: 'guarded' },
        { id: 2, verdict: 'real', confidence: 70 },
      ]),
    );
    expect(map.get(0)?.verdict).toBe('CONFIRMED');
    expect(map.get(1)?.verdict).toBe('DISMISSED');
    expect(map.get(2)?.verdict).toBe('CONFIRMED');
  });
});

describe('verifier gate', () => {
  test('skips when all severity < 5 and no invariant file match', () => {
    expect(shouldRunVerifier([LOW_SEV], CONTEXT, true)).toBe(false);
  });

  test('triggers when any severity >= 5', () => {
    expect(shouldRunVerifier([LOW_SEV, HIGH_SEV], CONTEXT, true)).toBe(true);
  });

  test('triggers when a finding file touches a gate token', () => {
    expect(shouldRunVerifier([INVARIANT_FILE], CONTEXT, true)).toBe(true);
    expect(fileTouchesGateToken('src/auth/session.ts', ['src/auth/session.ts'])).toBe(true);
    expect(fileTouchesGateToken('pkg/manifest.ts', ['manifest.ts'])).toBe(true);
  });

  test('respects verify=false', () => {
    expect(shouldRunVerifier([HIGH_SEV], CONTEXT, false)).toBe(false);
  });
});

describe('runEngineEffect', () => {
  test('finder parse → gate skip tags unverified', async () => {
    const layer = fakeReviewer({
      onFinder: () => findingsJson([LOW_SEV]),
      onVerifier: () => {
        throw new Error('verifier should not run');
      },
    });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.telemetry.verification).toBe('skipped');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].unverified).toBe(true);
    expect(result.findings[0].unverifiedTag).toContain('below verification threshold');
    expect(result.dismissed).toHaveLength(0);
  });

  test('verify=false keeps findings with an accurate disabled tag', async () => {
    const layer = fakeReviewer({ onFinder: () => findingsJson([HIGH_SEV]) });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, { ...CONFIG, verify: false }, PLAN, {}, undefined).pipe(
        Effect.provide(layer),
      ),
    );
    expect(result.telemetry.verification).toBe('disabled');
    expect(result.findings[0].unverifiedTag).toContain('verification disabled');
  });

  test('severity >= 5 triggers verifier with full files, then confirms/dismisses', async () => {
    let verifierPrompt = '';
    const layer = fakeReviewer({
      onFinder: () => findingsJson([HIGH_SEV, LOW_SEV]),
      onVerifier: (user) => {
        verifierPrompt = user;
        return JSON.stringify([
          { id: 0, verdict: 'CONFIRMED', severity: 8, confidence: 95, evidence: 'reachable' },
          { id: 1, verdict: 'DISMISSED', reason: 'intentional' },
        ]);
      },
    });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.telemetry.verification).toBe('ran');
    expect(verifierPrompt).toContain('## Full changed files');
    expect(verifierPrompt).toContain('export const x = 1;');
    expect(verifierPrompt).toContain('unavailable files or tests');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(8);
    expect(result.findings[0].confidence).toBe(95);
    expect(result.findings[0].unverified).toBeUndefined();
    expect(result.dismissed).toHaveLength(1);
    expect(result.dismissed[0].reason).toBe('intentional');
  });

  test('invariant-file match triggers verifier even at low severity', async () => {
    let verifierCalled = false;
    const layer = fakeReviewer({
      onFinder: () => findingsJson([INVARIANT_FILE]),
      onVerifier: () => {
        verifierCalled = true;
        return JSON.stringify([
          { id: 0, verdict: 'CONFIRMED', severity: 3, confidence: 40, evidence: 'low conf' },
        ]);
      },
    });
    const result = await Effect.runPromise(
      runEngineEffect(
        {
          ...INPUT,
          changedFiles: { 'src/auth/session.ts': 'export {}' },
          diff: 'diff --git a/src/auth/session.ts',
        },
        CONFIG,
        PLAN,
        {},
        undefined,
      ).pipe(Effect.provide(layer)),
    );
    expect(verifierCalled).toBe(true);
    expect(result.telemetry.verification).toBe('ran');
    // confidence < 50 dropped
    expect(result.findings).toHaveLength(0);
    expect(result.dismissed).toHaveLength(1);
  });

  test('verifier failure fails open (keeps findings, tagged unverified)', async () => {
    const layer = fakeReviewer({
      onFinder: () => findingsJson([HIGH_SEV]),
      failVerifier: true,
    });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.telemetry.verification).toBe('failed-open');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].unverified).toBe(true);
    expect(result.findings[0].summary).toBe(HIGH_SEV.summary);
  });

  test('malformed finder output cannot masquerade as a clean review', async () => {
    const layer = fakeReviewer({ onFinder: () => 'not json' });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.telemetry.finderFailed).toBe(true);
    expect(result.telemetry.finderErrorSample).toContain('malformed');
  });

  test('partial verifier output keeps unmatched findings visibly unverified', async () => {
    const layer = fakeReviewer({
      onFinder: () => findingsJson([HIGH_SEV, LOW_SEV]),
      onVerifier: () =>
        JSON.stringify([
          { id: 0, verdict: 'CONFIRMED', severity: 8, confidence: 95, evidence: 'reachable' },
        ]),
    });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.telemetry.verification).toBe('failed-open');
    expect(result.telemetry.verifierFailed).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((finding) => finding.summary === LOW_SEV.summary)?.unverified).toBe(
      true,
    );
  });

  test('finder failure yields empty result with finderFailed telemetry', async () => {
    const layer = fakeReviewer({ failFinder: true });
    const result = await Effect.runPromise(
      runEngineEffect(INPUT, CONFIG, PLAN, {}, undefined).pipe(Effect.provide(layer)),
    );
    expect(result.findings).toHaveLength(0);
    expect(result.telemetry.finderFailed).toBe(true);
  });
});
