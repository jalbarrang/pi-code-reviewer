/** Parse /review command arguments into structured options. */
export function parseReviewArgs(args: string): {
  lenses: string[];
  /** Merge-base triple-dot diff against this ref (`--branch`). */
  branch?: string;
  /** Single-commit patch (`--commit`). */
  commit?: string;
  /** @deprecated Alias for `branch` (`--base`). */
  base?: string;
  /** Staged-only slice of uncommitted changes (back-compat). */
  staged: boolean;
  /** Override directory for git operations (--repo, alias --cwd). */
  repo?: string;
} {
  const lenses: string[] = [];
  let branch: string | undefined;
  let commit: string | undefined;
  let staged = false;
  let repo: string | undefined;

  const parts = args.split(/\s+/).filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '--lens' && i + 1 < parts.length) {
      lenses.push(...parts[++i].split(','));
    } else if ((part === '--branch' || part === '--base') && i + 1 < parts.length) {
      branch = parts[++i];
    } else if (part === '--commit' && i + 1 < parts.length) {
      commit = parts[++i];
    } else if (part === '--staged') {
      staged = true;
    } else if ((part === '--repo' || part === '--cwd') && i + 1 < parts.length) {
      repo = parts[++i];
    }
  }

  return { lenses, branch, commit, base: branch, staged, repo };
}
