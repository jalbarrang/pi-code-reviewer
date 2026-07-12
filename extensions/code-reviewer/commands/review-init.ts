import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { listCatalogLenses, readReference } from '../catalog';
import { getConfigPath } from '../config';
import { getContextPath } from '../context';

export function registerReviewInitCommand(pi: ExtensionAPI) {
  pi.registerCommand('review-init', {
    description:
      'Set up .code-reviewer/context.md (project review context) and optional packaged lenses',
    handler: async (_args, ctx) => {
      const contextPath = getContextPath(ctx.cwd);
      const configPath = getConfigPath(ctx.cwd);

      const initFlow = readReference('init.md');
      const template = readReference('CONTEXT-TEMPLATE.md');
      const catalog = listCatalogLenses();

      const catalogLines =
        catalog.length > 0
          ? catalog.map(
              (lens) => `- **${lens.id}** — ${lens.description}\n  source: \`${lens.path}\``,
            )
          : ['(no packaged lenses found)'];

      const prompt = [
        'Initialize code-reviewer for this project by following the vendored init flow',
        'below. Work interactively: scan first, then interview the user in short rounds,',
        'then write the context file only after they confirm.',
        '',
        `- Context file to create: \`${contextPath}\` (create \`.code-reviewer/\` if needed).`,
        `- Config file to create/merge: \`${configPath}\`.`,
        `- Lens copies go into \`${ctx.cwd}/.code-review/lenses/\`.`,
        '',
        'Key rules:',
        '- NEVER overwrite an existing context.md silently — if it exists, offer to refresh',
        '  or fill gaps and MERGE.',
        '- Interview 2-3 questions per round using the structured question tool when available;',
        '  ask only what the scan could not answer. Propose inferred answers as hypotheses.',
        '- Fill the template with concrete, codebase-specific lines; delete any section the',
        '  project has not earned. A generic line is worse than no line.',
        '- Lens multi-select defaults to NONE. With no lenses selected, reviews are pure',
        '  context-driven bug hunting — that is a valid, common setup.',
        '- For each SELECTED lens, COPY its source file (absolute path listed below) into',
        '  `.code-review/lenses/`, then set `defaultLenses` in `.code-review.json` to the',
        '  selected ids (merge — never drop lenses the project already had).',
        '',
        '## Init flow (references/init.md)',
        '',
        initFlow.trim() || '(init.md unavailable)',
        '',
        '## Context template (references/CONTEXT-TEMPLATE.md)',
        '',
        template.trim() || '(CONTEXT-TEMPLATE.md unavailable)',
        '',
        '## Packaged lens catalog',
        '',
        ...catalogLines,
      ].join('\n');

      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
    },
  });
}
