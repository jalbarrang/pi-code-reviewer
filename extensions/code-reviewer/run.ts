/**
 * Shared review pipeline used by both `/review` and the `code_review` tool.
 *
 * Collects the diff, runs the deduped lens tool set once, reads the full
 * changed files, then drives the finder+verifier engine (when a model is
 * available) or produces a project-aware single-pass fallback prompt. Keeping
 * this in one place guarantees the command and the tool behave identically.
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readChangedFiles } from './changed-files';
import { collectDiff, getChangedFiles, type DiffOptions, type DiffSource } from './diff';
import { buildFallbackReviewPrompt, runEngine, type EngineInput } from './engine';
import { getLensContent } from './lenses';
import { resolveModelPlan } from './model-plan';
import { buildLensResult, pickLensToolOutputs, runTools } from './reviewer';
import type { EngineResult, LensConfig, ReviewConfig } from './types';

export type ReviewRun =
  | { kind: 'no-changes' }
  | {
      kind: 'engine';
      result: EngineResult;
      diff: DiffSource;
      changedFiles: string[];
      lensNames: string[];
    }
  | {
      kind: 'fallback';
      prompt: string;
      diff: DiffSource;
      changedFiles: string[];
      lensNames: string[];
    };

export type RunReviewArgs = {
  cwd: string;
  config: ReviewConfig;
  contextMarkdown: string;
  diffOptions: DiffOptions;
  lensNames: string[];
  available: Map<string, LensConfig>;
  lensDir: string;
  /** Session model + registry, when present. Absent → fallback prompt. */
  model?: Model<Api>;
  modelRegistry?: { getAll: () => Model<Api>[] };
  onStage?: (stage: string) => void;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
};

/**
 * Assemble the per-lens instruction markdown (definition + severity rules +
 * tool outputs) fed to the finder. Empty string when no lenses are active — a
 * context-only review is valid.
 */
async function buildLensInstructions(
  lensDir: string,
  lensNames: string[],
  selected: LensConfig[],
  toolOutputs: Record<string, string>,
): Promise<string> {
  const sections: string[] = [];
  for (let i = 0; i < lensNames.length; i++) {
    const content = (await getLensContent(lensDir, lensNames[i])) ?? '';
    const result = buildLensResult(
      selected[i],
      content,
      pickLensToolOutputs(selected[i], toolOutputs),
    );
    if (result._lensSection) sections.push(result._lensSection);
  }
  return sections.join('\n\n');
}

export async function runReview(
  pi: Pick<ExtensionAPI, 'exec'>,
  args: RunReviewArgs,
): Promise<ReviewRun> {
  const {
    cwd,
    config,
    contextMarkdown,
    diffOptions,
    lensNames,
    available,
    lensDir,
    model,
    modelRegistry,
    onStage,
    onWarning,
    signal,
  } = args;

  onStage?.('collecting diff');
  const diff = await collectDiff(pi, cwd, diffOptions);
  if (!diff.diff.trim()) return { kind: 'no-changes' };

  const selected = lensNames.map((name) => available.get(name)!);

  // Run the DISTINCT tool set once (deduped across lenses), concurrently.
  const allTools = [...new Set(selected.flatMap((lens) => lens.tools))];
  if (allTools.length > 0) onStage?.(`running ${allTools.length} tool(s)`);
  const toolOutputs = await runTools(
    pi,
    cwd,
    allTools,
    { timeoutMs: config.toolTimeoutMs, concurrency: config.toolConcurrency },
    signal,
  );

  const lensInstructions = await buildLensInstructions(lensDir, lensNames, selected, toolOutputs);

  const changedFiles = await getChangedFiles(pi, cwd, diffOptions);
  const fileContents = await readChangedFiles(cwd, changedFiles);

  const input: EngineInput = {
    contextMarkdown,
    diff: diff.diff,
    changedFiles: fileContents,
    lensInstructions,
  };

  // No session model (e.g. print mode) → hand the calling agent a project-aware
  // review prompt instead of a generic one.
  if (!model || !modelRegistry) {
    return {
      kind: 'fallback',
      prompt: buildFallbackReviewPrompt(input),
      diff,
      changedFiles,
      lensNames,
    };
  }

  const { resolution, plan, warnings } = resolveModelPlan(config.review, model, modelRegistry);
  for (const warning of warnings) onWarning?.(warning);

  const result = await runEngine(resolution, plan, input, config.review, { onStage }, signal);
  return { kind: 'engine', result, diff, changedFiles, lensNames };
}

/** Resolve which lens names to run from explicit selection, defaults, or all. */
export function resolveLensNames(
  requested: string[] | undefined,
  defaults: string[],
  available: Map<string, unknown>,
  warn?: (msg: string) => void,
): string[] {
  if (requested && requested.length > 0) {
    const missing = requested.filter((l) => !available.has(l));
    if (missing.length > 0) warn?.(`Unknown lenses: ${missing.join(', ')}`);
    return requested.filter((l) => available.has(l));
  }
  if (defaults.length > 0) {
    return defaults.filter((l) => available.has(l));
  }
  return [...available.keys()];
}
