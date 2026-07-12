import { describe, expect, test } from 'bun:test';

import { parseReviewArgs } from '../extensions/code-reviewer/parse-args';

describe('parseReviewArgs', () => {
  test('parses lenses, branch, commit, and staged', () => {
    const parsed = parseReviewArgs('--lens a,b --branch main --commit abc123 --staged');
    expect(parsed.lenses).toEqual(['a', 'b']);
    expect(parsed.branch).toBe('main');
    expect(parsed.commit).toBe('abc123');
    expect(parsed.base).toBe('main');
    expect(parsed.staged).toBe(true);
    expect(parsed.repo).toBeUndefined();
  });

  test('treats --base as a deprecated alias for --branch', () => {
    const parsed = parseReviewArgs('--base main');
    expect(parsed.branch).toBe('main');
    expect(parsed.base).toBe('main');
    expect(parsed.commit).toBeUndefined();
  });

  test('parses --repo', () => {
    const parsed = parseReviewArgs('--repo /path/to/worktree --branch HEAD~1');
    expect(parsed.repo).toBe('/path/to/worktree');
    expect(parsed.branch).toBe('HEAD~1');
    expect(parsed.base).toBe('HEAD~1');
  });

  test('accepts --cwd as an alias for --repo', () => {
    const parsed = parseReviewArgs('--cwd ../project-pr35');
    expect(parsed.repo).toBe('../project-pr35');
  });

  test('empty args yield defaults', () => {
    const parsed = parseReviewArgs('');
    expect(parsed.lenses).toEqual([]);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.commit).toBeUndefined();
    expect(parsed.base).toBeUndefined();
    expect(parsed.staged).toBe(false);
    expect(parsed.repo).toBeUndefined();
  });
});
