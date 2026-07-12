import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { loadConfig, getLensDir } from '../config';
import { NOT_INITIALIZED, loadReviewContext } from '../context';
import { discoverLenses } from '../lenses';
import { parseReviewArgs } from '../parse-args';
import { resolveRepoCwd } from '../resolve-cwd';
import { renderTieredReport } from '../reviewer';
import { runReview, resolveLensNames } from '../run';

export function registerReviewCommand(pi: ExtensionAPI) {
  pi.registerCommand('review', {
    description:
      'Run a context-aware bug review on changes. Requires /review-init. Usage: /review [--branch base | --commit sha] [--lens a,b] [--staged] [--repo dir]',
    handler: async (args, ctx) => {
      const parsed = parseReviewArgs(args ?? '');

      // Override directory for git/config/lens/context resolution (worktrees,
      // sibling repos). Resolved relative to the session CWD and validated; the
      // session CWD itself is left unchanged.
      let cwd: string;
      try {
        cwd = await resolveRepoCwd(pi, ctx.cwd, parsed.repo);
      } catch (cause) {
        ctx.ui.notify(
          `--repo ${parsed.repo} is not a git work tree (${cause instanceof Error ? cause.message : String(cause)})`,
          'error',
        );
        return;
      }

      // Mandatory context gate — no degraded review, no auto-generation.
      const context = await loadReviewContext(cwd);
      if (!context) {
        ctx.ui.notify(NOT_INITIALIZED, 'error');
        return;
      }

      const config = await loadConfig(cwd);
      const lensDir = getLensDir(cwd, config);
      const available = await discoverLenses(lensDir);

      // Zero lenses is VALID — a pure context-driven bug hunt.
      const lensNames = resolveLensNames(parsed.lenses, config.defaultLenses, available, (msg) =>
        ctx.ui.notify(msg, 'warning'),
      );

      ctx.ui.setStatus('code-review', '🔍 Collecting diff...');
      let run;
      try {
        run = await runReview(pi, {
          cwd,
          config,
          contextMarkdown: context.content,
          diffOptions: { branch: parsed.branch, commit: parsed.commit, staged: parsed.staged },
          lensNames,
          available,
          lensDir,
          model: ctx.model,
          modelRegistry: ctx.modelRegistry,
          onStage: (stage) => ctx.ui.setStatus('code-review', `🔍 ${stage}...`),
          onWarning: (msg) => ctx.ui.notify(msg, 'warning'),
        });
      } catch (cause) {
        ctx.ui.setStatus('code-review', undefined);
        ctx.ui.notify(
          `Review failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          'error',
        );
        return;
      }

      ctx.ui.setStatus('code-review', undefined);

      if (run.kind === 'no-changes') {
        ctx.ui.notify('No changes to review', 'info');
        return;
      }

      if (run.kind === 'fallback') {
        pi.sendUserMessage(run.prompt, { deliverAs: 'followUp' });
        return;
      }

      const report = renderTieredReport(run.result, run.diff, run.lensNames, run.changedFiles);
      pi.sendUserMessage(report, { deliverAs: 'followUp' });
    },
  });
}
