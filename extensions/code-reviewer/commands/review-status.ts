import { stat } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { loadConfig, getLensDir } from '../config';
import { getContextPath, loadReviewContext } from '../context';
import { discoverLenses } from '../lenses';
import { resolveLensNames } from '../run';
import { buildStatusReport } from '../status';

/** Commits to the whole tree since the context was last touched before we
 *  suggest a refresh. */
const STALE_COMMIT_THRESHOLD = 25;

/** Best-effort `git` via pi.exec; returns trimmed stdout or '' on any failure. */
async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  try {
    const result = await pi.exec('git', args, { cwd, timeout: 30_000 });
    return (result.stdout ?? '').trim();
  } catch {
    return '';
  }
}

/** Compute a one-line staleness signal from git history (or fs mtime fallback). */
async function stalenessLine(
  pi: ExtensionAPI,
  cwd: string,
  contextPath: string,
): Promise<string | null> {
  const contextCommit = await git(pi, cwd, [
    'log',
    '-1',
    '--format=%H',
    '--',
    '.code-reviewer/context.md',
  ]);
  if (contextCommit) {
    const rel = await git(pi, cwd, [
      'log',
      '-1',
      '--format=%cr',
      '--',
      '.code-reviewer/context.md',
    ]);
    const countRaw = await git(pi, cwd, ['rev-list', '--count', `${contextCommit}..HEAD`]);
    const count = Number.parseInt(countRaw, 10);
    const commits = Number.isFinite(count) ? count : 0;
    const stale = commits >= STALE_COMMIT_THRESHOLD ? ' — consider a refresh (/review-init)' : '';
    return `staleness: context updated ${rel || 'unknown'}; ${commits} commit(s) to the tree since${stale}`;
  }

  // Context not committed → fall back to filesystem mtime.
  try {
    const info = await stat(contextPath);
    return `staleness: context.md is uncommitted (edited ${info.mtime.toISOString().slice(0, 10)})`;
  } catch {
    return null;
  }
}

export function registerReviewStatusCommand(pi: ExtensionAPI) {
  pi.registerCommand('review-status', {
    description: "Report the health of this project's code-reviewer context (read-only)",
    handler: async (_args, ctx) => {
      const context = await loadReviewContext(ctx.cwd);
      if (!context) {
        ctx.ui.notify(
          'code-reviewer is not initialized — run /review-init first. Every command except /review-init will refuse until then.',
          'warning',
        );
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const available = await discoverLenses(getLensDir(ctx.cwd, config));
      const activeLenses = resolveLensNames(undefined, config.defaultLenses, available);

      const staleness = await stalenessLine(pi, ctx.cwd, getContextPath(ctx.cwd));

      const report = buildStatusReport({
        content: context.content,
        activeLenses,
        stalenessLine: staleness,
      });
      ctx.ui.notify(report, 'info');
    },
  });
}
