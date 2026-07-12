import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { listCatalogLenses } from '../catalog';
import { loadConfig, getLensDir } from '../config';
import { NOT_INITIALIZED, loadReviewContext } from '../context';
import { discoverLenses } from '../lenses';
import { parseReviewArgs } from '../parse-args';
import { resolveRepoCwd } from '../resolve-cwd';

export function registerReviewLensesCommand(pi: ExtensionAPI) {
  pi.registerCommand('review-lenses', {
    description:
      'List active project lenses and packaged catalog lenses not yet enabled. Usage: /review-lenses [--repo dir]',
    handler: async (args, ctx) => {
      const parsed = parseReviewArgs(args ?? '');

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

      // Context gate — every command except init/status hard-fails when missing.
      const context = await loadReviewContext(cwd);
      if (!context) {
        ctx.ui.notify(NOT_INITIALIZED, 'error');
        return;
      }

      const config = await loadConfig(cwd);
      const lensDir = getLensDir(cwd, config);
      const available = await discoverLenses(lensDir);

      const lines: string[] = [`Active lenses (${config.lensDir}):`];
      if (available.size === 0) {
        lines.push('  (none — reviews run as pure context-driven bug hunts)');
      } else {
        for (const [key, lens] of available) {
          const isDefault = config.defaultLenses.includes(key);
          const marker = isDefault ? ' ★' : '';
          const tools = lens.tools.length > 0 ? ` [${lens.tools.length} tool(s)]` : '';
          lines.push(`  ${key}${marker} — ${lens.description}${tools}`);
        }
        if (config.defaultLenses.length > 0) {
          lines.push('  ★ = default (runs when no --lens is passed)');
        }
      }

      // Catalog lenses not yet copied into the project.
      const catalog = listCatalogLenses().filter((lens) => !available.has(lens.id));
      if (catalog.length > 0) {
        lines.push('', 'Packaged catalog lenses not yet enabled (run /review-init to add):');
        for (const lens of catalog) {
          lines.push(`  ${lens.id} — ${lens.description}`);
        }
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
