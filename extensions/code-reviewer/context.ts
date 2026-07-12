/**
 * Review context loader and parsers.
 *
 * `.code-reviewer/context.md` is mandatory for every command except init/status.
 * Missing context is a hard fail — no degraded review.
 */

import { Effect } from 'effect';
import { resolve } from 'node:path';

import { FileSystem, nodeFileSystemService } from './effects/filesystem';

const CONTEXT_DIR = '.code-reviewer';
const CONTEXT_FILE = 'context.md';

export const NOT_INITIALIZED =
  'code-reviewer is not initialized for this project — run /review-init first.';

/** High-value sections checked by `/review-status`. */
export const SECTION_CRITICAL_INVARIANTS = 'Critical invariants';
export const SECTION_INTENTIONAL_PATTERNS = 'Intentional patterns (false-positive suppressors)';
export const SECTION_HISTORICAL_BUG_CLASSES = 'Historical bug classes';

const GATE_SECTIONS = [SECTION_CRITICAL_INVARIANTS, SECTION_HISTORICAL_BUG_CLASSES] as const;

const PLACEHOLDER_RE = /<[^>]+>/;
const BACKTICK_RE = /`([^`]+)`/g;

export interface ReviewContext {
  readonly path: string;
  readonly content: string;
}

/** Absolute path to `.code-reviewer/context.md` under `cwd`. */
export function getContextPath(cwd: string): string {
  return resolve(cwd, CONTEXT_DIR, CONTEXT_FILE);
}

export function loadReviewContextEffect(
  cwd: string,
): Effect.Effect<ReviewContext | null, never, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = getContextPath(cwd);
    const raw = yield* fs.readTextFile(path).pipe(Effect.either);
    if (raw._tag === 'Left') return null;
    return { path, content: raw.right };
  });
}

export function loadReviewContext(cwd: string): Promise<ReviewContext | null> {
  return Effect.runPromise(
    loadReviewContextEffect(cwd).pipe(Effect.provideService(FileSystem, nodeFileSystemService)),
  );
}

/** Parse `##` section bodies keyed by heading title (text after `## `). */
export function parseSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headerRe = /^## (.+)$/gm;
  const matches = [...content.matchAll(headerRe)];

  for (let i = 0; i < matches.length; i++) {
    const title = matches[i][1].trim();
    const bodyStart = matches[i].index! + matches[i][0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    sections.set(title, content.slice(bodyStart, bodyEnd).trim());
  }

  return sections;
}

/** Whether `content` contains template-style `<placeholders>`. */
export function hasPlaceholders(content: string): boolean {
  return PLACEHOLDER_RE.test(content);
}

/** Whether a `##` section with the given title exists. */
export function hasSection(content: string, sectionTitle: string): boolean {
  return parseSections(content).has(sectionTitle);
}

/** Section body for `sectionTitle`, or null when the heading is absent. */
export function getSectionBody(content: string, sectionTitle: string): string | null {
  const body = parseSections(content).get(sectionTitle);
  return body === undefined ? null : body;
}

/** True when the section is missing or its body is empty/whitespace-only. */
export function isSectionEmpty(content: string, sectionTitle: string): boolean {
  const body = getSectionBody(content, sectionTitle);
  return body === null || body.trim().length === 0;
}

/** True when the section body contains template `<placeholders>`. */
export function sectionHasPlaceholders(content: string, sectionTitle: string): boolean {
  const body = getSectionBody(content, sectionTitle);
  return body !== null && hasPlaceholders(body);
}

/**
 * Backticked path-like tokens from Critical invariants and Historical bug classes.
 * Used by the verifier gate to decide whether low-severity findings warrant verification.
 */
export function extractGateSections(content: string): string[] {
  const sections = parseSections(content);
  const tokens = new Set<string>();

  for (const title of GATE_SECTIONS) {
    const body = sections.get(title);
    if (!body) continue;
    for (const token of extractPathLikeBackticks(body)) tokens.add(token);
  }

  return [...tokens];
}

function extractPathLikeBackticks(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(BACKTICK_RE)) {
    const token = match[1].trim();
    if (isPathLikeToken(token)) tokens.push(token);
  }
  return tokens;
}

function isPathLikeToken(token: string): boolean {
  if (!token || token.startsWith('<')) return false;
  if (token.includes('/') || token.includes('.')) return true;
  return /^[\w@][\w.-]*$/.test(token);
}
