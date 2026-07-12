/**
 * Vendored skill-asset catalog helpers.
 *
 * The extension ships a verbatim copy of the canonical skill under
 * `skills/code-reviewer/` (see {@link resolveSkillAsset}). `/review-init` inlines
 * the init flow + context template and offers the packaged lens catalog; this
 * module enumerates that catalog and reads the flow docs.
 *
 * Node-only IO (readFileSync/readdirSync) per the extension runtime constraint.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';

import { resolveSkillAsset } from './engine';

export type CatalogLens = {
  /** Basename id used for copies + `defaultLenses` (e.g. `security`). */
  id: string;
  /** Display title (the `# H1` line). */
  title: string;
  /** One-line description (first prose line under the H1). */
  description: string;
  /** Absolute path to the vendored lens file, for copy instructions. */
  path: string;
};

/** First `# H1` title and first prose line beneath it. */
function parseLensHeader(markdown: string): { title: string; description: string } {
  const lines = markdown.split('\n');
  let title = '';
  let description = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!title) {
      if (line.startsWith('# ')) title = line.slice(2).trim();
      continue;
    }
    if (line && !line.startsWith('#')) {
      description = line;
      break;
    }
  }
  return { title, description };
}

/** Enumerate the vendored lens catalog (missing dir → empty list). */
export function listCatalogLenses(): CatalogLens[] {
  const dir = resolveSkillAsset('lenses');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const lenses: CatalogLens[] = [];
  for (const file of files.sort()) {
    const path = resolveSkillAsset('lenses', file);
    let markdown: string;
    try {
      markdown = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const id = basename(file, '.md');
    const { title, description } = parseLensHeader(markdown);
    lenses.push({ id, title: title || id, description, path });
  }
  return lenses;
}

/** Read a vendored reference doc body (e.g. `init.md`). Missing → empty string. */
export function readReference(name: string): string {
  try {
    return readFileSync(resolveSkillAsset('references', name), 'utf8');
  } catch {
    return '';
  }
}
