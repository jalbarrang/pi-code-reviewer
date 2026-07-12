/**
 * Finder + verifier review engine.
 *
 * One discovery call (vendored bug-finder prompt) → conditional verifier gate →
 * one verification call (vendored bug-verifier prompt). Fail-open on verifier
 * errors so a flaky model never silently drops findings.
 *
 * Everything here is pure over the {@link Reviewer} service so it is unit
 * testable with a deterministic fake model.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';

import { extractGateSections } from './context';
import { causeMessage } from './errors';
import { type ModelResolution, Reviewer, makeReviewerService } from './effects/model';
import type {
  DismissedFinding,
  EngineLensFindings,
  EngineResult,
  EngineTelemetry,
  Finding,
  LensFinding,
  LensSeverity,
  ModelPlan,
  ReviewEngineConfig,
  VerificationStatus,
} from './types';

const VALID_LENS_SEVERITIES = new Set<LensSeverity>(['blocker', 'warning', 'note']);

const UNVERIFIED_BELOW_THRESHOLD = 'unverified — below verification threshold';
const UNVERIFIED_DISABLED = 'unverified — verification disabled';
const UNVERIFIED_VERIFIER_FAILED = 'unverified — verifier unavailable';

const FINDER_JSON_CONTRACT = [
  '',
  '## Extension output contract (mandatory)',
  'Respond with ONLY a single JSON object. No prose, no markdown fences.',
  'Shape:',
  '{',
  '  "findings": [',
  '    {',
  '      "file": "path/to/file.ts",',
  '      "lineRange": "42" | "10-14",',
  '      "category": "logic|state-management|null-safety|control-flow|security|concurrency|type-safety|error-handling",',
  '      "severity": 1-10,',
  '      "confidence": 0-100,',
  '      "summary": "short summary",',
  '      "reasoning": "evidence grounded in the code"',
  '    }',
  '  ],',
  '  "lenses": {',
  '    "<lens-name>": [',
  '      { "file": "path", "line": 42, "severity": "blocker|warning|note", "message": "..." }',
  '    ]',
  '  }',
  '}',
  'Use "lenses": {} when no lenses are active or a lens has nothing to report.',
  'If there are no bug findings, return { "findings": [], "lenses": {} }.',
].join('\n');

const VERIFIER_JSON_CONTRACT = [
  '',
  '## Extension output contract (mandatory)',
  'Respond with ONLY a JSON array. No prose, no markdown fences.',
  'One entry per candidate id from the user message:',
  '[',
  '  {',
  '    "id": 0,',
  '    "verdict": "CONFIRMED" | "DISMISSED",',
  '    "severity": 1-10,',
  '    "confidence": 0-100,',
  '    "evidence": "reachable path / missing guard (CONFIRMED)",',
  '    "reason": "one-line dismissal reason (DISMISSED)"',
  '  }',
  ']',
  'Drop any finding below confidence 50 by returning DISMISSED or confidence < 50.',
].join('\n');

// ── Vendored agent prompts ───────────────────────────────────────────────────

/** Strip YAML frontmatter (`---` … `---`) from a markdown agent file. */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown.trim();
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return markdown.trim();
  return markdown.slice(match[0].length).trim();
}

function extensionDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve a vendored skill asset path relative to this extension module.
 * Works for both source checkouts and npm installs (`files` includes skills/).
 */
export function resolveSkillAsset(...parts: string[]): string {
  return join(extensionDir(), '..', '..', 'skills', 'code-reviewer', ...parts);
}

export function loadAgentPromptBody(agent: 'bug-finder' | 'bug-verifier'): string {
  const path = resolveSkillAsset('agents', `${agent}.md`);
  return stripFrontmatter(readFileSync(path, 'utf8'));
}

// ── JSON extraction / parsing ────────────────────────────────────────────────

/** Extract the first balanced top-level JSON value (`[` or `{`) from model text. */
export function extractJsonValue(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;

  const startObj = haystack.indexOf('{');
  const startArr = haystack.indexOf('[');
  let start = -1;
  let open = '';
  let close = '';
  if (startObj === -1 && startArr === -1) return null;
  if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    start = startObj;
    open = '{';
    close = '}';
  } else {
    start = startArr;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < haystack.length; index += 1) {
    const char = haystack[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return haystack.slice(start, index + 1);
    }
  }
  return null;
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function coerceLineRange(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const start = clampInt(record.start ?? record.from, 1, Number.MAX_SAFE_INTEGER);
    const end = clampInt(record.end ?? record.to, 1, Number.MAX_SAFE_INTEGER);
    if (start !== null && end !== null && end !== start) return `${start}-${end}`;
    if (start !== null) return String(start);
  }
  return undefined;
}

function parseOneFinding(entry: unknown): Finding | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const file = typeof record.file === 'string' ? record.file.trim() : '';
  const summary =
    typeof record.summary === 'string'
      ? record.summary.trim()
      : typeof record.message === 'string'
        ? record.message.trim()
        : '';
  const reasoning = typeof record.reasoning === 'string' ? record.reasoning.trim() : '';
  const category = typeof record.category === 'string' ? record.category.trim() : 'logic';
  const severity = clampInt(record.severity, 1, 10);
  const confidence = clampInt(record.confidence, 0, 100);
  if (!file || !summary || severity === null || confidence === null) return null;
  return {
    file,
    lineRange: coerceLineRange(record.lineRange ?? record.line),
    category: category || 'logic',
    severity,
    confidence,
    summary,
    reasoning: reasoning || summary,
  };
}

function parseLensFinding(entry: unknown): LensFinding | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const file = typeof record.file === 'string' ? record.file.trim() : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const severity =
    typeof record.severity === 'string' &&
    VALID_LENS_SEVERITIES.has(record.severity as LensSeverity)
      ? (record.severity as LensSeverity)
      : null;
  if (!file || !message || !severity) return null;
  const line = clampInt(record.line, 1, Number.MAX_SAFE_INTEGER) ?? undefined;
  return { file, line, severity, message };
}

export type ParsedFinderOutput = {
  findings: Finding[];
  lensFindings: EngineLensFindings;
};

/** Parse finder model text into findings + optional per-lens arrays. */
export function parseFinderOutput(text: string): ParsedFinderOutput {
  const empty: ParsedFinderOutput = { findings: [], lensFindings: {} };
  const trimmed = text.trim();
  if (!trimmed || /^no findings\.?$/i.test(trimmed)) return empty;

  const json = extractJsonValue(text);
  if (!json) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }

  // Accept a bare findings array as a convenience.
  if (Array.isArray(parsed)) {
    return {
      findings: parsed.map(parseOneFinding).filter((f): f is Finding => f !== null),
      lensFindings: {},
    };
  }

  if (typeof parsed !== 'object' || parsed === null) return empty;
  const record = parsed as Record<string, unknown>;

  const findingsRaw = Array.isArray(record.findings) ? record.findings : [];
  const findings = findingsRaw.map(parseOneFinding).filter((f): f is Finding => f !== null);

  const lensFindings: EngineLensFindings = {};
  const lenses = record.lenses;
  if (typeof lenses === 'object' && lenses !== null && !Array.isArray(lenses)) {
    for (const [name, entries] of Object.entries(lenses as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const parsedLens = entries.map(parseLensFinding).filter((f): f is LensFinding => f !== null);
      if (parsedLens.length > 0) lensFindings[name] = parsedLens;
    }
  }

  return { findings, lensFindings };
}

/** Parse finder output without mistaking malformed model output for a clean review. */
export function parseFinderOutputStrict(text: string): ParsedFinderOutput | null {
  const trimmed = text.trim();
  if (/^no findings\.?$/i.test(trimmed)) return { findings: [], lensFindings: {} };

  const json = extractJsonValue(text);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  let rawFindings: unknown[];
  if (Array.isArray(parsed)) {
    rawFindings = parsed;
  } else if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).findings)
  ) {
    rawFindings = (parsed as Record<string, unknown>).findings as unknown[];
  } else {
    return null;
  }

  const output = parseFinderOutput(text);
  const lensCount = Object.values(output.lensFindings).reduce(
    (count, findings) => count + findings.length,
    0,
  );
  if (rawFindings.length > 0 && output.findings.length === 0 && lensCount === 0) return null;
  return output;
}

type VerifierVerdict = {
  id: number;
  verdict: 'CONFIRMED' | 'DISMISSED';
  severity?: number;
  confidence?: number;
  evidence?: string;
  reason?: string;
};

export function parseVerifierOutput(text: string): Map<number, VerifierVerdict> {
  const verdicts = new Map<number, VerifierVerdict>();
  const json = extractJsonValue(text);
  if (!json) return verdicts;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return verdicts;
  }
  if (!Array.isArray(parsed)) return verdicts;

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'number' || !Number.isInteger(record.id)) continue;

    const rawVerdict =
      typeof record.verdict === 'string' ? record.verdict.trim().toUpperCase() : '';
    const verdict: 'CONFIRMED' | 'DISMISSED' =
      rawVerdict === 'CONFIRMED' || rawVerdict === 'REAL' ? 'CONFIRMED' : 'DISMISSED';

    const severity = clampInt(record.severity, 1, 10) ?? undefined;
    const confidence = clampInt(record.confidence, 0, 100) ?? undefined;
    const evidence = typeof record.evidence === 'string' ? record.evidence.trim() : undefined;
    const reason =
      typeof record.reason === 'string'
        ? record.reason.trim()
        : typeof record.justification === 'string'
          ? record.justification.trim()
          : undefined;

    verdicts.set(record.id, { id: record.id, verdict, severity, confidence, evidence, reason });
  }
  return verdicts;
}

// ── Verifier gate ────────────────────────────────────────────────────────────

/** True when `file` touches a gate token (path/module from context sections). */
export function fileTouchesGateToken(file: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const normalized = file.replace(/\\/g, '/').toLowerCase();
  const base = normalized.split('/').pop() ?? normalized;

  for (const raw of tokens) {
    const token = raw.replace(/\\/g, '/').toLowerCase();
    if (!token) continue;
    if (normalized === token) return true;
    if (normalized.endsWith(`/${token}`) || normalized.includes(`/${token}/`)) return true;
    if (token.includes('/') && (normalized.includes(token) || token.includes(normalized))) {
      return true;
    }
    // Bare module / filename token (e.g. `auth` or `session.ts`).
    if (!token.includes('/') && (base === token || base.startsWith(`${token}.`))) return true;
  }
  return false;
}

/**
 * Whether the verifier should run for this finding set.
 * Skip when: verify disabled, no findings, or all severity<5 AND no file touches
 * Critical invariants / Historical bug classes paths.
 */
export function shouldRunVerifier(
  findings: Finding[],
  contextMarkdown: string,
  verifyEnabled: boolean,
): boolean {
  if (!verifyEnabled) return false;
  if (findings.length === 0) return false;
  if (findings.some((finding) => finding.severity >= 5)) return true;
  const tokens = extractGateSections(contextMarkdown);
  return findings.some((finding) => fileTouchesGateToken(finding.file, tokens));
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

export type EngineInput = {
  /** Full `.code-reviewer/context.md` contents. */
  contextMarkdown: string;
  /** Diff text (unified). */
  diff: string;
  /** Full contents of changed files, keyed by path. */
  changedFiles: Record<string, string>;
  /** Optional lens instruction markdown (already assembled). */
  lensInstructions?: string;
};

function buildChangedFileBlocks(changedFiles: Record<string, string>): string {
  return Object.entries(changedFiles)
    .map(([path, content]) => [`### ${path}`, '```', content, '```'].join('\n'))
    .join('\n\n');
}

export function buildFinderUser(input: EngineInput): string {
  const fileBlocks = buildChangedFileBlocks(input.changedFiles);

  return [
    '## Project review context (`.code-reviewer/context.md`)',
    input.contextMarkdown.trim() || '(empty)',
    '',
    input.lensInstructions?.trim()
      ? ['## Lens instructions', input.lensInstructions.trim(), ''].join('\n')
      : '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
    '',
    '## Full changed files',
    fileBlocks || '(none)',
    FINDER_JSON_CONTRACT,
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function buildVerifierUser(input: EngineInput, findings: Finding[]): string {
  const list = findings
    .map((finding, index) => {
      const where = finding.lineRange ? `${finding.file}:${finding.lineRange}` : finding.file;
      return [
        `[${index}] ${where}`,
        `category=${finding.category} severity=${finding.severity} confidence=${finding.confidence}`,
        `summary: ${finding.summary}`,
        `reasoning: ${finding.reasoning}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    '## Project review context (`.code-reviewer/context.md`)',
    input.contextMarkdown.trim() || '(empty)',
    '',
    '## Diff',
    '```diff',
    input.diff,
    '```',
    '',
    '## Full changed files',
    buildChangedFileBlocks(input.changedFiles) || '(none)',
    '',
    '## Candidate findings to verify',
    list,
    '',
    'Use the full changed files above to trace guards and reachability. If confirming or dismissing a finding requires unavailable files or tests, keep it CONFIRMED at its existing confidence rather than treating missing evidence as a dismissal.',
    VERIFIER_JSON_CONTRACT,
  ].join('\n');
}

/**
 * Single-pass fallback prompt for when no session model is available to drive
 * the engine directly (e.g. print mode). Embeds the vendored bug-finder system
 * prompt + the full finder user payload (context.md, diff, changed files, lens
 * instructions) so the CALLING agent performs a project-aware review — never a
 * generic one. Missing prompt asset degrades to just the payload.
 */
export function buildFallbackReviewPrompt(input: EngineInput): string {
  let role = '';
  try {
    role = loadAgentPromptBody('bug-finder');
  } catch {
    role = '';
  }
  return [
    'Perform a bug-focused code review of the changes below, grounded in the',
    'project review context. Do not invent concerns when the diff is clean.',
    '',
    role ? ['## Reviewer role', role, ''].join('\n') : '',
    buildFinderUser(input),
  ]
    .filter((part) => part !== '')
    .join('\n');
}

function tagUnverified(findings: Finding[], tag: string): Finding[] {
  return findings.map((finding) => ({
    ...finding,
    unverified: true,
    unverifiedTag: tag,
  }));
}

function applyVerifierVerdicts(
  findings: Finding[],
  verdicts: Map<number, VerifierVerdict>,
): { kept: Finding[]; dismissed: DismissedFinding[] } {
  const kept: Finding[] = [];
  const dismissed: DismissedFinding[] = [];

  findings.forEach((finding, index) => {
    const verdict = verdicts.get(index);
    // Missing verdict → fail open, visibly unverified.
    if (!verdict) {
      kept.push({
        ...finding,
        unverified: true,
        unverifiedTag: UNVERIFIED_VERIFIER_FAILED,
      });
      return;
    }
    if (verdict.verdict === 'DISMISSED') {
      dismissed.push({
        finding,
        reason: verdict.reason || 'dismissed by verifier',
      });
      return;
    }

    const confidence = verdict.confidence ?? finding.confidence;
    if (confidence < 50) {
      dismissed.push({
        finding,
        reason: verdict.reason || `confidence ${confidence} below 50`,
      });
      return;
    }

    kept.push({
      ...finding,
      severity: verdict.severity ?? finding.severity,
      confidence,
      reasoning: verdict.evidence
        ? `${finding.reasoning}\n\nEvidence: ${verdict.evidence}`
        : finding.reasoning,
    });
  });

  return { kept, dismissed };
}

function sortFindings(left: Finding, right: Finding): number {
  if (right.severity !== left.severity) return right.severity - left.severity;
  return right.confidence - left.confidence;
}

// ── Engine Effect ────────────────────────────────────────────────────────────

export function runEngineEffect(
  input: EngineInput,
  config: ReviewEngineConfig,
  plan: ModelPlan,
  hooks: { onStage?: (stage: string) => void } = {},
  signal?: AbortSignal,
): Effect.Effect<EngineResult, never, Reviewer> {
  return Effect.gen(function* () {
    const reviewer = yield* Reviewer;
    let finderPrompt: string;
    try {
      finderPrompt = loadAgentPromptBody('bug-finder');
    } catch (cause) {
      return emptyResult(plan, {
        verification: 'no-findings',
        finderFailed: true,
        finderErrorSample: `failed to load bug-finder prompt: ${causeMessage(cause)}`,
      });
    }

    hooks.onStage?.('finding bugs');
    const finderResult = yield* reviewer
      .complete({
        modelKey: plan.finder.key,
        reasoning: plan.finder.reasoning,
        system: finderPrompt,
        user: buildFinderUser(input),
        temperature: 0.2,
        stage: 'finder',
        signal,
      })
      .pipe(Effect.either);

    if (finderResult._tag === 'Left') {
      return emptyResult(plan, {
        verification: 'no-findings',
        finderFailed: true,
        finderErrorSample: describeModelError(finderResult.left),
      });
    }

    const parsedFinder = parseFinderOutputStrict(finderResult.right);
    if (!parsedFinder) {
      return emptyResult(plan, {
        verification: 'no-findings',
        finderFailed: true,
        finderErrorSample: 'finder returned malformed output; review did not run',
      });
    }

    const { findings: discovered, lensFindings } = parsedFinder;
    const discoveryCount = discovered.length;

    if (discoveryCount === 0) {
      return {
        findings: [],
        dismissed: [],
        lensFindings,
        telemetry: baseTelemetry(plan, {
          discoveryCount: 0,
          postVerificationCount: null,
          finalCount: 0,
          verification: 'no-findings',
        }),
      };
    }

    const verifyEnabled = config.verify !== false;
    const runVerifier = shouldRunVerifier(discovered, input.contextMarkdown, verifyEnabled);

    if (!runVerifier) {
      const unverifiedTag = verifyEnabled ? UNVERIFIED_BELOW_THRESHOLD : UNVERIFIED_DISABLED;
      const tagged = tagUnverified(discovered, unverifiedTag)
        .sort(sortFindings)
        .slice(0, config.maxFindings);
      const verification: VerificationStatus = verifyEnabled ? 'skipped' : 'disabled';
      return {
        findings: tagged,
        dismissed: [],
        lensFindings,
        telemetry: baseTelemetry(plan, {
          discoveryCount,
          postVerificationCount: null,
          finalCount: tagged.length,
          verification,
        }),
      };
    }

    hooks.onStage?.(`verifying ${discovered.length} findings`);
    let verifierPrompt: string;
    try {
      verifierPrompt = loadAgentPromptBody('bug-verifier');
    } catch (cause) {
      const tagged = tagUnverified(discovered, UNVERIFIED_VERIFIER_FAILED)
        .sort(sortFindings)
        .slice(0, config.maxFindings);
      return {
        findings: tagged,
        dismissed: [],
        lensFindings,
        telemetry: baseTelemetry(plan, {
          discoveryCount,
          postVerificationCount: null,
          finalCount: tagged.length,
          verification: 'failed-open',
          verifierFailed: true,
          verifierErrorSample: `failed to load bug-verifier prompt: ${causeMessage(cause)}`,
        }),
      };
    }

    const verifierResult = yield* reviewer
      .complete({
        modelKey: plan.verifier.key,
        reasoning: plan.verifier.reasoning,
        system: verifierPrompt,
        user: buildVerifierUser(input, discovered),
        temperature: 0,
        stage: 'verifier',
        signal,
      })
      .pipe(Effect.either);

    if (verifierResult._tag === 'Left') {
      // Fail open: keep findings, tag unverified.
      const tagged = tagUnverified(discovered, UNVERIFIED_VERIFIER_FAILED)
        .sort(sortFindings)
        .slice(0, config.maxFindings);
      return {
        findings: tagged,
        dismissed: [],
        lensFindings,
        telemetry: baseTelemetry(plan, {
          discoveryCount,
          postVerificationCount: null,
          finalCount: tagged.length,
          verification: 'failed-open',
          verifierFailed: true,
          verifierErrorSample: describeModelError(verifierResult.left),
        }),
      };
    }

    const verdicts = parseVerifierOutput(verifierResult.right);
    const incomplete = discovered.some((_, index) => !verdicts.has(index));
    const { kept, dismissed } = applyVerifierVerdicts(discovered, verdicts);
    kept.sort(sortFindings);
    const capped = kept.slice(0, config.maxFindings);

    return {
      findings: capped,
      dismissed,
      lensFindings,
      telemetry: baseTelemetry(plan, {
        discoveryCount,
        postVerificationCount: incomplete ? null : capped.length,
        finalCount: capped.length,
        verification: incomplete ? 'failed-open' : 'ran',
        verifierFailed: incomplete || undefined,
        verifierErrorSample: incomplete
          ? 'verifier returned incomplete or malformed output; unmatched findings kept unverified'
          : undefined,
      }),
    };
  });
}

function describeModelError(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;
  return causeMessage((error as { cause?: unknown }).cause);
}

function baseTelemetry(
  plan: ModelPlan,
  partial: Omit<EngineTelemetry, 'finderModel' | 'verifierModel'>,
): EngineTelemetry {
  return {
    ...partial,
    finderModel: plan.finder.label,
    verifierModel: plan.verifier.label,
  };
}

function emptyResult(
  plan: ModelPlan,
  extra: Partial<EngineTelemetry> & Pick<EngineTelemetry, 'verification'>,
): EngineResult {
  return {
    findings: [],
    dismissed: [],
    lensFindings: {},
    telemetry: baseTelemetry(plan, {
      discoveryCount: 0,
      postVerificationCount: null,
      finalCount: 0,
      verification: extra.verification,
      finderFailed: extra.finderFailed,
      finderErrorSample: extra.finderErrorSample,
      verifierFailed: extra.verifierFailed,
      verifierErrorSample: extra.verifierErrorSample,
    }),
  };
}

/** Promise wrapper: run the engine against a resolved set of models. */
export function runEngine(
  resolution: ModelResolution,
  plan: ModelPlan,
  input: EngineInput,
  config: ReviewEngineConfig,
  hooks: { onStage?: (stage: string) => void } = {},
  signal?: AbortSignal,
): Promise<EngineResult> {
  return Effect.runPromise(
    runEngineEffect(input, config, plan, hooks, signal).pipe(
      Effect.provideService(Reviewer, makeReviewerService(resolution)),
    ),
  );
}
