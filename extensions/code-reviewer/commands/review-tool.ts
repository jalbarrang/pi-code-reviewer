import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolUpdateCallback, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { loadConfig, getLensDir } from '../config';
import { NOT_INITIALIZED, loadReviewContext } from '../context';
import { discoverLenses } from '../lenses';
import { resolveRepoCwd } from '../resolve-cwd';
import { buildPointer, renderTieredReport, type ReviewPointer } from '../reviewer';
import { runReview, resolveLensNames } from '../run';

/** Spill large review output to a temp file so it survives pi's ~50KB tool-output
 *  cap and context compaction. Node-only IO per the extension runtime constraint. */
async function writeReviewTempFile(content: string): Promise<ReviewPointer> {
  const path = join(tmpdir(), `pi-code-review-${Date.now()}.md`);
  await writeFile(path, content, 'utf8');
  return {
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content.split('\n').length,
  };
}

/** Inline payloads above this size spill to a temp file + pointer instead. */
const INLINE_LIMIT_BYTES = 40_000;

export function registerReviewTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'code_review',
    label: 'Code Review',
    description:
      'Run a context-aware bug review on working-directory changes using the finder+verifier engine. Requires the project to be initialized (.code-reviewer/context.md, via /review-init). Returns a tiered report (Critical/Important/Minor) plus structured details.',
    promptSnippet: 'Run a context-aware bug review against working directory changes',
    promptGuidelines: [
      'Use code_review when the user asks to review their changes, hunt for bugs, or check code before committing.',
      'code_review REQUIRES an initialized project: it reads .code-reviewer/context.md and refuses when missing (tell the user to run /review-init).',
      'Lenses are optional — a review with zero lenses is a valid context-driven bug hunt.',
    ],
    parameters: Type.Object({
      lenses: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Specific lenses to apply. If omitted, uses project defaults or all available. Zero lenses is valid.',
        }),
      ),
      branch: Type.Optional(
        Type.String({
          description: 'Base branch/ref for a merge-base (triple-dot) diff, e.g. "main".',
        }),
      ),
      base: Type.Optional(
        Type.String({
          description: 'Deprecated alias for branch.',
        }),
      ),
      commit: Type.Optional(Type.String({ description: "Review a single commit's patch by sha." })),
      staged: Type.Optional(
        Type.Boolean({
          description: 'Review only staged changes instead of all working directory changes.',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            'Override directory for git/config/lens/context resolution (e.g. a worktree or sibling repo). Resolved relative to the session directory and validated as a git work tree. The session directory is left unchanged.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let cwd: string;
      try {
        cwd = await resolveRepoCwd(pi, ctx.cwd, params.cwd);
      } catch (cause) {
        return {
          content: [
            {
              type: 'text',
              text: `cwd "${params.cwd}" is not a git work tree (${cause instanceof Error ? cause.message : String(cause)}).`,
            },
          ],
          details: {},
        };
      }

      // Mandatory context gate.
      const context = await loadReviewContext(cwd);
      if (!context) {
        return {
          content: [{ type: 'text', text: NOT_INITIALIZED }],
          details: { initialized: false },
        };
      }

      const config = await loadConfig(cwd);
      const lensDir = getLensDir(cwd, config);
      const available = await discoverLenses(lensDir);
      const lensNames = resolveLensNames(params.lenses, config.defaultLenses, available);

      ctx.ui.setStatus('code-review', '🔍 Collecting diff...');
      let run;
      try {
        run = await runReview(pi, {
          cwd,
          config,
          contextMarkdown: context.content,
          diffOptions: {
            branch: params.branch ?? params.base,
            commit: params.commit,
            staged: params.staged,
          },
          lensNames,
          available,
          lensDir,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          onStage: (stage) => {
            ctx.ui.setStatus('code-review', `🔍 ${stage}...`);
            onUpdate?.({ content: [{ type: 'text', text: stage }], details: { stage } });
          },
          onWarning: (msg) => ctx.ui.notify(msg, 'warning'),
          signal,
        });
      } catch (cause) {
        ctx.ui.setStatus('code-review', undefined);
        return {
          content: [
            {
              type: 'text',
              text: `Review failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          ],
          details: {},
        };
      }

      ctx.ui.setStatus('code-review', undefined);

      if (run.kind === 'no-changes') {
        return { content: [{ type: 'text', text: 'No changes to review.' }], details: {} };
      }

      const baseDetails: Record<string, unknown> = {
        lensNames: run.lensNames,
        availableLenses: [...available.keys()],
        changedFiles: run.changedFiles,
      };

      // No session model → return the project-aware fallback prompt (spilled if
      // large so it survives the tool-output cap).
      if (run.kind === 'fallback') {
        return spill(run.prompt, { ...baseDetails, mode: 'fallback' }, 'single-pass', onUpdate);
      }

      const report = renderTieredReport(run.result, run.diff, run.lensNames, run.changedFiles);
      const { telemetry } = run.result;
      const details = {
        ...baseDetails,
        mode: 'engine',
        verification: telemetry.verification,
        discoveryCount: telemetry.discoveryCount,
        postVerificationCount: telemetry.postVerificationCount,
        finalCount: telemetry.finalCount,
        finderModel: telemetry.finderModel,
        verifierModel: telemetry.verifierModel,
        finderFailed: telemetry.finderFailed,
      };
      return spill(report, details, 'pipeline', onUpdate);
    },
  });
}

/** Return content inline when small; otherwise spill to temp + return a pointer. */
async function spill(
  content: string,
  details: Record<string, unknown>,
  mode: 'single-pass' | 'pipeline',
  onUpdate?: AgentToolUpdateCallback,
): Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }> {
  if (Buffer.byteLength(content, 'utf8') <= INLINE_LIMIT_BYTES) {
    return { content: [{ type: 'text', text: content }], details };
  }
  try {
    const pointer = await writeReviewTempFile(content);
    return {
      content: [{ type: 'text', text: buildPointer(pointer, mode) }],
      details: { ...details, contextFile: pointer.path },
    };
  } catch (cause) {
    onUpdate?.({
      content: [{ type: 'text', text: 'temp-file write failed — returning inline content' }],
      details: { writeError: cause instanceof Error ? cause.message : String(cause) },
    });
    return { content: [{ type: 'text', text: content }], details };
  }
}
