/**
 * Review configuration loader.
 *
 * Reading `.code-review.json` is an Effect program against the FileSystem
 * service; a missing or malformed file falls back to defaults (never fails).
 * The Promise wrapper provides the live service for imperative call sites.
 */

import { Effect } from 'effect';
import { resolve } from 'node:path';

import { FileSystem, nodeFileSystemService } from './effects/filesystem';
import type { ModelStepConfig, ReasoningLevel, ReviewConfig, ReviewEngineConfig } from './types';

const REASONING_LEVELS = new Set<ReasoningLevel>(['minimal', 'low', 'medium', 'high', 'xhigh']);

const CONFIG_FILE = '.code-review.json';
const DEFAULT_LENS_DIR = '.code-review/lenses';
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_CONCURRENCY = 4;

const DEFAULT_ENGINE: ReviewEngineConfig = {
  verify: true,
  maxFindings: 50,
};

function defaultConfig(): ReviewConfig {
  return {
    lensDir: DEFAULT_LENS_DIR,
    defaultLenses: [],
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    toolConcurrency: DEFAULT_TOOL_CONCURRENCY,
    review: { ...DEFAULT_ENGINE },
  };
}

/** Coerce a config value to a model step: a non-empty spec string or
 *  `{ model, reasoning }`. Returns undefined for anything else. */
function parseModelStep(value: unknown): ModelStepConfig | undefined {
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const model = typeof record.model === 'string' ? record.model.trim() : '';
    if (!model) return undefined;
    const reasoning =
      typeof record.reasoning === 'string' &&
      REASONING_LEVELS.has(record.reasoning as ReasoningLevel)
        ? (record.reasoning as ReasoningLevel)
        : undefined;
    return reasoning ? { model, reasoning } : { model };
  }
  return undefined;
}

function parseReviewEngine(raw: unknown): ReviewEngineConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_ENGINE };
  const review = raw as Record<string, unknown>;
  return {
    finderModel: parseModelStep(review.finderModel),
    verifierModel: parseModelStep(review.verifierModel),
    verify: typeof review.verify === 'boolean' ? review.verify : DEFAULT_ENGINE.verify,
    maxFindings: positiveIntOr(review.maxFindings, DEFAULT_ENGINE.maxFindings),
  };
}

/** Coerce a config value to a positive integer, falling back when absent/invalid. */
function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function loadConfigEffect(cwd: string): Effect.Effect<ReviewConfig, never, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const raw = yield* fs.readTextFile(getConfigPath(cwd)).pipe(Effect.either);
    if (raw._tag === 'Left') return defaultConfig();

    try {
      const parsed = JSON.parse(raw.right) as Partial<ReviewConfig>;
      return {
        lensDir: parsed.lensDir ?? DEFAULT_LENS_DIR,
        defaultLenses: parsed.defaultLenses ?? [],
        toolTimeoutMs: positiveIntOr(parsed.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
        toolConcurrency: positiveIntOr(parsed.toolConcurrency, DEFAULT_TOOL_CONCURRENCY),
        review: parseReviewEngine((parsed as { review?: unknown }).review),
      };
    } catch {
      // Malformed config — fall back to defaults.
      return defaultConfig();
    }
  });
}

export function loadConfig(cwd: string): Promise<ReviewConfig> {
  return Effect.runPromise(
    loadConfigEffect(cwd).pipe(Effect.provideService(FileSystem, nodeFileSystemService)),
  );
}

export function getLensDir(cwd: string, config: ReviewConfig): string {
  return resolve(cwd, config.lensDir);
}

export function getConfigPath(cwd: string): string {
  return resolve(cwd, CONFIG_FILE);
}
