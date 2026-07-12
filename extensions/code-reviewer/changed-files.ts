/**
 * Read the full contents of changed files for the review engine.
 *
 * The diff shows only hunks; the finder needs whole files to judge reachability
 * and existing guards (per `references/review.md` Step 1). Reads run through the
 * FileSystem service so they stay injectable and never throw: deleted or
 * unreadable (binary/permission) files are skipped, oversized files are
 * truncated, and a total budget caps the prompt so a huge changeset can't blow
 * past the model context window.
 */

import { Effect } from 'effect';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { FileSystem, nodeFileSystemService } from './effects/filesystem';

/** Per-file cap before truncation. */
const MAX_FILE_BYTES = 100_000;
/** Aggregate cap across all changed files. */
const MAX_TOTAL_BYTES = 400_000;

const TRUNCATION_NOTE = '\n… (file truncated for review)';

export function readChangedFilesEffect(
  cwd: string,
  files: string[],
): Effect.Effect<Record<string, string>, never, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const out: Record<string, string> = {};
    let total = 0;

    const canonicalRootResult = yield* fs.realPath(cwd).pipe(Effect.either);
    if (canonicalRootResult._tag === 'Left') return out;
    const canonicalRoot = canonicalRootResult.right;

    for (const file of files) {
      if (total >= MAX_TOTAL_BYTES) break;
      const candidate = resolve(cwd, file);
      const canonicalFileResult = yield* fs.realPath(candidate).pipe(Effect.either);
      if (canonicalFileResult._tag === 'Left') continue;
      const canonicalFile = canonicalFileResult.right;
      const fromRoot = relative(canonicalRoot, canonicalFile);
      // Never follow a changed symlink or crafted path outside the reviewed repo.
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        continue;
      }

      const raw = yield* fs.readTextFile(canonicalFile).pipe(Effect.either);
      // Deleted, binary, or otherwise unreadable — skip rather than fail.
      if (raw._tag === 'Left') continue;

      let content = raw.right;
      if (content.length > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES) + TRUNCATION_NOTE;
      }
      out[file] = content;
      total += content.length;
    }

    return out;
  });
}

export function readChangedFiles(cwd: string, files: string[]): Promise<Record<string, string>> {
  return Effect.runPromise(
    readChangedFilesEffect(cwd, files).pipe(
      Effect.provideService(FileSystem, nodeFileSystemService),
    ),
  );
}
