import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readReference } from '../catalog';
import { NOT_INITIALIZED, getContextPath, loadReviewContext } from '../context';

export function registerReviewLearnCommand(pi: ExtensionAPI) {
  pi.registerCommand('review-learn', {
    description: 'Fold a review miss (false positive or missed bug) into .code-reviewer/context.md',
    handler: async (args, ctx) => {
      // Context gate: learn maintains a context, it never bootstraps one.
      const context = await loadReviewContext(ctx.cwd);
      if (!context) {
        ctx.ui.notify(NOT_INITIALIZED, 'error');
        return;
      }

      const learnFlow = readReference('learn.md');
      const note = (args ?? '').trim();

      const prompt = [
        'Fold a review lesson into the project review context by following the vendored',
        'learn flow below. Distill the lesson to a durable invariant, dedupe against',
        'existing lines, and CONFIRM the exact one-line edit with the user before writing.',
        'Keep the rest of the file untouched.',
        '',
        `- Context file: \`${getContextPath(ctx.cwd)}\``,
        note
          ? `- User note: ${note}`
          : '- No note provided — ask the user what the review got wrong.',
        '',
        '## Learn flow (references/learn.md)',
        '',
        learnFlow.trim() || '(learn.md unavailable)',
        '',
        '## Current context.md',
        '',
        '```markdown',
        context.content.trim() || '(empty)',
        '```',
      ].join('\n');

      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
    },
  });
}
