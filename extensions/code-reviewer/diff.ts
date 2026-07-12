/**
 * Diff collection.
 *
 * Git invocations run through the Executor service as typed Effects. The
 * Promise wrappers build a live Executor from `pi` for imperative call sites.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';

import { Executor, makeExecutorService } from './effects/exec';
import { ExecError } from './errors';

export type DiffSource = {
  diff: string;
  stat: string;
  label: string;
};

export type DiffOptions = {
  /** Merge-base triple-dot diff against this ref. */
  branch?: string;
  /** Single-commit patch for this sha. */
  commit?: string;
  /** Staged-only slice of uncommitted changes (back-compat). */
  staged?: boolean;
  /** @deprecated Use `branch`. Same semantics as `branch`. */
  base?: string;
};

/** git diffs are normally instant; cap them so a pathological repo can't hang
 *  the whole review. */
const GIT_TIMEOUT_MS = 30_000;

/** Cap on untracked files diffed against /dev/null so a repo full of generated
 *  junk can't blow up the prompt. The whole diff is truncated downstream too. */
const MAX_UNTRACKED_FILES = 200;

/** The empty tree object — diffing a path against it yields a full new-file
 *  diff portably (no reliance on /dev/null path handling across platforms). */
const NULL_DEVICE = '/dev/null';

function git(args: string[], cwd: string): Effect.Effect<string, ExecError, Executor> {
  return Effect.gen(function* () {
    const executor = yield* Executor;
    const result = yield* executor.exec('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
    return result.stdout;
  });
}

function gitEither(
  args: string[],
  cwd: string,
): Effect.Effect<{ ok: true; stdout: string } | { ok: false }, never, Executor> {
  return git(args, cwd).pipe(
    Effect.map((stdout) => ({ ok: true as const, stdout })),
    Effect.catchAll(() => Effect.succeed({ ok: false as const })),
  );
}

function failGitRef(args: string[], message: string): Effect.Effect<never, ExecError> {
  return Effect.fail(new ExecError({ command: 'git', args, cause: new Error(message) }));
}

function resolveBranchRef(options: DiffOptions): string | undefined {
  return options.branch ?? options.base;
}

/**
 * Diff every untracked (new, not-yet-`git add`ed) file against /dev/null so
 * brand-new files show up in a working-directory review — `git diff HEAD`
 * omits them entirely, which is exactly the class of change agents introduce.
 *
 * Read-only: it NEVER touches the index (no `git add -N`). `git diff --no-index`
 * exits non-zero when files differ, but pi.exec resolves with the diff on stdout
 * regardless; any per-file failure degrades to an empty string rather than
 * sinking the whole review.
 */
function collectUntrackedEffect(
  cwd: string,
): Effect.Effect<{ diff: string; files: string[] }, never, Executor> {
  return Effect.gen(function* () {
    const listed = yield* git(['ls-files', '--others', '--exclude-standard'], cwd).pipe(
      Effect.orElseSucceed(() => ''),
    );
    const files = listed
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (files.length === 0) return { diff: '', files: [] };

    const parts = yield* Effect.forEach(
      files.slice(0, MAX_UNTRACKED_FILES),
      (file) =>
        git(['diff', '--no-index', '--', NULL_DEVICE, file], cwd).pipe(
          Effect.orElseSucceed(() => ''),
        ),
      { concurrency: 4 },
    );
    return { diff: parts.filter((part) => part.trim()).join('\n'), files };
  });
}

/** Append a one-line-per-file summary of untracked files to a `--stat` block so
 *  the change overview reflects new files that git's own stat never lists. */
function appendUntrackedStat(stat: string, files: string[]): string {
  if (files.length === 0) return stat;
  const shown = files.slice(0, MAX_UNTRACKED_FILES);
  const lines = shown.map((file) => ` ${file} | (new, untracked)`);
  const note = `${files.length} untracked file(s) included`;
  return [stat.trimEnd(), ...lines, note].filter(Boolean).join('\n');
}

/** Default: staged + unstaged vs HEAD, plus untracked new files. */
function collectUncommittedEffect(cwd: string): Effect.Effect<DiffSource, ExecError, Executor> {
  return Effect.gen(function* () {
    const headDiff = yield* git(['diff', 'HEAD'], cwd).pipe(Effect.either);
    const untracked = yield* collectUntrackedEffect(cwd);

    let tracked: string;
    let stat: string;
    let label: string;
    if (headDiff._tag === 'Left' || !headDiff.right.trim()) {
      tracked = yield* git(['diff'], cwd);
      stat = yield* git(['diff', '--stat'], cwd);
      label = 'working directory changes';
    } else {
      tracked = headDiff.right;
      stat = yield* git(['diff', 'HEAD', '--stat'], cwd);
      label = 'all uncommitted changes';
    }

    const diff = [tracked, untracked.diff].filter((part) => part.trim()).join('\n');
    return { diff, stat: appendUntrackedStat(stat, untracked.files), label };
  });
}

/** Merge-base triple-dot diff against a base branch/ref. */
function collectBranchEffect(
  cwd: string,
  base: string,
): Effect.Effect<DiffSource, ExecError, Executor> {
  return Effect.gen(function* () {
    const check = yield* gitEither(['rev-parse', '--verify', base], cwd);
    if (!check.ok) {
      return yield* failGitRef(['rev-parse', '--verify', base], `Unknown ref '${base}': not found`);
    }

    const range = `${base}...HEAD`;
    const diff = yield* git(['diff', range], cwd);
    const stat = yield* git(['diff', range, '--stat'], cwd);
    return { diff, stat, label: `changes since merge-base with ${base}` };
  });
}

type CommitRange = {
  resolved: string;
  hasParent: boolean;
  range: string;
};

function resolveCommitRangeEffect(
  cwd: string,
  sha: string,
): Effect.Effect<CommitRange, ExecError, Executor> {
  return Effect.gen(function* () {
    const check = yield* gitEither(['rev-parse', '--verify', `${sha}^{commit}`], cwd);
    if (!check.ok) {
      return yield* failGitRef(
        ['rev-parse', '--verify', `${sha}^{commit}`],
        `Unknown commit '${sha}': not found`,
      );
    }

    const resolved = check.stdout.trim();
    const parents = yield* git(['rev-list', '--parents', '-n', '1', resolved], cwd);
    const parts = parents.trim().split(/\s+/);
    const hasParent = parts.length > 1;
    const range = hasParent ? `${parts[1]}..${resolved}` : resolved;
    return { resolved, hasParent, range };
  });
}

/** Single-commit patch (parent..commit, or root commit). */
function collectCommitEffect(
  cwd: string,
  sha: string,
): Effect.Effect<DiffSource, ExecError, Executor> {
  return Effect.gen(function* () {
    const { resolved, hasParent, range } = yield* resolveCommitRangeEffect(cwd, sha);
    const diffArgs = hasParent ? ['diff', range] : ['show', '--format=', '--patch', resolved];
    const statArgs = hasParent
      ? ['diff', range, '--stat']
      : ['show', '--format=', '--stat', resolved];

    const diff = yield* git(diffArgs, cwd);
    const stat = yield* git(statArgs, cwd);
    return { diff, stat, label: `commit ${resolved.slice(0, 12)}` };
  });
}

/** Collect the diff from the working directory or a specific target. */
export function collectDiffEffect(
  cwd: string,
  options: DiffOptions,
): Effect.Effect<DiffSource, ExecError, Executor> {
  return Effect.gen(function* () {
    if (options.commit) {
      return yield* collectCommitEffect(cwd, options.commit);
    }

    const branch = resolveBranchRef(options);
    if (branch) {
      return yield* collectBranchEffect(cwd, branch);
    }

    if (options.staged) {
      const diff = yield* git(['diff', '--staged'], cwd);
      const stat = yield* git(['diff', '--staged', '--stat'], cwd);
      return { diff, stat, label: 'staged changes' };
    }

    return yield* collectUncommittedEffect(cwd);
  });
}

/** Get a list of changed file paths from the diff. */
export function getChangedFilesEffect(
  cwd: string,
  options: DiffOptions,
): Effect.Effect<string[], ExecError, Executor> {
  return Effect.gen(function* () {
    if (options.commit) {
      const { resolved, hasParent, range } = yield* resolveCommitRangeEffect(cwd, options.commit);
      const nameArgs = hasParent
        ? ['diff', '--name-only', range]
        : ['show', '--format=', '--name-only', resolved];
      const stdout = yield* git(nameArgs, cwd);
      return splitPaths(stdout);
    }

    const branch = resolveBranchRef(options);
    if (branch) {
      const check = yield* gitEither(['rev-parse', '--verify', branch], cwd);
      if (!check.ok) {
        return yield* failGitRef(
          ['rev-parse', '--verify', branch],
          `Unknown ref '${branch}': not found`,
        );
      }
      const range = `${branch}...HEAD`;
      const stdout = yield* git(['diff', '--name-only', range], cwd);
      return splitPaths(stdout);
    }

    if (options.staged) {
      const stdout = yield* git(['diff', '--name-only', '--staged'], cwd);
      return splitPaths(stdout);
    }

    const tracked = yield* git(['diff', '--name-only', 'HEAD'], cwd).pipe(
      Effect.orElseSucceed(() => ''),
    );
    const untracked = yield* git(['ls-files', '--others', '--exclude-standard'], cwd).pipe(
      Effect.orElseSucceed(() => ''),
    );
    return [...new Set([...splitPaths(tracked), ...splitPaths(untracked)])];
  });
}

function splitPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
}

// ── Promise wrappers (live Executor from pi) ──────────────────────────────────

export function collectDiff(
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  options: DiffOptions,
): Promise<DiffSource> {
  return Effect.runPromise(
    collectDiffEffect(cwd, options).pipe(Effect.provideService(Executor, makeExecutorService(pi))),
  );
}

export function getChangedFiles(
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  options: DiffOptions,
): Promise<string[]> {
  return Effect.runPromise(
    getChangedFilesEffect(cwd, options).pipe(
      Effect.provideService(Executor, makeExecutorService(pi)),
    ),
  );
}
