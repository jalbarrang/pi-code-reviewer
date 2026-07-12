import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import { collectDiffEffect, getChangedFilesEffect } from '../extensions/code-reviewer/diff';
import { ExecError } from '../extensions/code-reviewer/errors';
import { fakeExecutor } from './helpers';

const cwd = '/repo';

describe('collectDiffEffect', () => {
  test('collects staged changes', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => ({
      stdout: args.includes('--stat') ? ' file | 1 +' : 'diff --git a b',
      stderr: '',
    }));

    const diff = await Effect.runPromise(
      collectDiffEffect(cwd, { staged: true }).pipe(Effect.provide(layer)),
    );

    expect(diff.label).toBe('staged changes');
    expect(diff.diff).toBe('diff --git a b');
    expect(calls.every((c) => c.args.includes('--staged'))).toBe(true);
  });

  test('uses merge-base triple-dot diff for branch target', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('rev-parse')) return { stdout: 'main-sha\n', stderr: '' };
      if (args.includes('--stat')) return { stdout: 'stat', stderr: '' };
      return { stdout: 'branchdiff', stderr: '' };
    });

    const diff = await Effect.runPromise(
      collectDiffEffect(cwd, { branch: 'main' }).pipe(Effect.provide(layer)),
    );

    expect(diff.label).toBe('changes since merge-base with main');
    expect(diff.diff).toBe('branchdiff');
    expect(calls.some((c) => c.args.includes('main...HEAD'))).toBe(true);
  });

  test('treats deprecated base option like branch', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('rev-parse')) return { stdout: 'main-sha\n', stderr: '' };
      return { stdout: args.includes('--stat') ? 'stat' : 'basediff', stderr: '' };
    });

    const diff = await Effect.runPromise(
      collectDiffEffect(cwd, { base: 'main' }).pipe(Effect.provide(layer)),
    );

    expect(diff.label).toBe('changes since merge-base with main');
    expect(diff.diff).toBe('basediff');
    expect(calls.some((c) => c.args.includes('main...HEAD'))).toBe(true);
  });

  test('collects a single commit patch', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: 'abc123def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { stdout: 'abc123def456 parent-sha\n', stderr: '' };
      if (args.includes('--stat')) return { stdout: 'commitstat', stderr: '' };
      return { stdout: 'commitdiff', stderr: '' };
    });

    const diff = await Effect.runPromise(
      collectDiffEffect(cwd, { commit: 'abc123' }).pipe(Effect.provide(layer)),
    );

    expect(diff.label).toBe('commit abc123def456');
    expect(diff.diff).toBe('commitdiff');
    expect(calls.some((c) => c.args.includes('parent-sha..abc123def456'))).toBe(true);
  });

  test('collects a root commit with git show', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: 'rootcommit\n', stderr: '' };
      if (args[0] === 'rev-list') return { stdout: 'rootcommit\n', stderr: '' };
      return { stdout: args.includes('--stat') ? 'rootstat' : 'rootpatch', stderr: '' };
    });

    const diff = await Effect.runPromise(
      collectDiffEffect(cwd, { commit: 'rootcommit' }).pipe(Effect.provide(layer)),
    );

    expect(diff.label).toBe('commit rootcommit');
    expect(diff.diff).toBe('rootpatch');
    expect(calls.some((c) => c.args[0] === 'show' && c.args.includes('rootcommit'))).toBe(true);
  });

  test('falls back to working directory when HEAD diff is empty', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('ls-files')) return { stdout: '', stderr: '' };
      if (args.includes('HEAD')) return { stdout: '', stderr: '' };
      return { stdout: args.includes('--stat') ? 'wdstat' : 'wddiff', stderr: '' };
    });

    const diff = await Effect.runPromise(collectDiffEffect(cwd, {}).pipe(Effect.provide(layer)));

    expect(diff.label).toBe('working directory changes');
    expect(diff.diff).toBe('wddiff');
    expect(calls.some((c) => c.args.includes('HEAD'))).toBe(true);
  });

  test('falls back to the working directory when there is no HEAD (fresh repo)', async () => {
    const { layer } = fakeExecutor((_cmd, args) => {
      if (args.includes('ls-files')) return { stdout: '', stderr: '' };
      if (args.includes('HEAD')) return { fail: new Error("fatal: ambiguous argument 'HEAD'") };
      return { stdout: args.includes('--stat') ? 'wdstat' : 'wddiff', stderr: '' };
    });

    const diff = await Effect.runPromise(collectDiffEffect(cwd, {}).pipe(Effect.provide(layer)));

    expect(diff.label).toBe('working directory changes');
    expect(diff.diff).toBe('wddiff');
  });

  test('includes untracked files alongside tracked changes by default', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('--no-index')) {
        const file = args[args.length - 1];
        return { stdout: `diff --git a/${file} b/${file}\n+brand new ${file}`, stderr: '' };
      }
      if (args.includes('ls-files')) return { stdout: 'newfile.ts\n', stderr: '' };
      if (args.includes('--stat')) return { stdout: ' tracked.ts | 2 +-', stderr: '' };
      if (args.includes('HEAD'))
        return { stdout: 'diff --git a/tracked.ts b/tracked.ts', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const diff = await Effect.runPromise(collectDiffEffect(cwd, {}).pipe(Effect.provide(layer)));

    expect(diff.label).toBe('all uncommitted changes');
    expect(diff.diff).toContain('tracked.ts');
    expect(diff.diff).toContain('brand new newfile.ts');
    expect(diff.stat).toContain('newfile.ts');
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(true);
    expect(calls.some((c) => c.args.includes('add'))).toBe(false);
  });

  test('includes untracked files even when there are no tracked changes', async () => {
    const { layer } = fakeExecutor((_cmd, args) => {
      if (args.includes('--no-index')) {
        const file = args[args.length - 1];
        return { stdout: `+brand new ${file}`, stderr: '' };
      }
      if (args.includes('ls-files')) return { stdout: 'a.ts\nb.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const diff = await Effect.runPromise(collectDiffEffect(cwd, {}).pipe(Effect.provide(layer)));

    expect(diff.label).toBe('working directory changes');
    expect(diff.diff).toContain('brand new a.ts');
    expect(diff.diff).toContain('brand new b.ts');
  });

  test('propagates ExecError when git fails', async () => {
    const { layer } = fakeExecutor(() => ({ fail: new Error('not a git repo') }));

    const result = await Effect.runPromise(
      collectDiffEffect(cwd, { staged: true }).pipe(Effect.provide(layer), Effect.either),
    );

    expect(result._tag).toBe('Left');
    expect((result as { left: ExecError }).left).toBeInstanceOf(ExecError);
  });

  test('fails when branch ref is unknown', async () => {
    const { layer } = fakeExecutor((_cmd, args) => {
      if (args.includes('rev-parse')) return { fail: new Error('fatal: bad ref') };
      return { stdout: '', stderr: '' };
    });

    const result = await Effect.runPromise(
      collectDiffEffect(cwd, { branch: 'missing' }).pipe(Effect.provide(layer), Effect.either),
    );

    expect(result._tag).toBe('Left');
    expect((result as { left: ExecError }).left).toBeInstanceOf(ExecError);
  });
});

describe('getChangedFilesEffect', () => {
  test('merges tracked + untracked names by default, deduped and trimmed', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('ls-files')) return { stdout: 'new.ts\n a.ts \n', stderr: '' };
      if (args.includes('--name-only')) return { stdout: 'a.ts\n b.ts \n\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const files = await Effect.runPromise(
      getChangedFilesEffect(cwd, {}).pipe(Effect.provide(layer)),
    );

    expect(files).toEqual(['a.ts', 'b.ts', 'new.ts']);
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(true);
  });

  test('staged uses the index name-only list without untracked files', async () => {
    const { layer, calls } = fakeExecutor(() => ({ stdout: 'staged.ts\n', stderr: '' }));

    const files = await Effect.runPromise(
      getChangedFilesEffect(cwd, { staged: true }).pipe(Effect.provide(layer)),
    );

    expect(files).toEqual(['staged.ts']);
    expect(calls[0].args).toEqual(['diff', '--name-only', '--staged']);
    expect(calls.some((c) => c.args.includes('ls-files'))).toBe(false);
  });

  test('branch uses merge-base triple-dot name-only list', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args.includes('rev-parse')) return { stdout: 'main-sha\n', stderr: '' };
      return { stdout: 'branch.ts\n', stderr: '' };
    });

    const files = await Effect.runPromise(
      getChangedFilesEffect(cwd, { branch: 'main' }).pipe(Effect.provide(layer)),
    );

    expect(files).toEqual(['branch.ts']);
    expect(calls.some((c) => c.args.includes('main...HEAD'))).toBe(true);
  });

  test('commit uses name-only list for the commit range', async () => {
    const { layer, calls } = fakeExecutor((_cmd, args) => {
      if (args[0] === 'rev-parse') return { stdout: 'abc123def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { stdout: 'abc123def456 parent-sha\n', stderr: '' };
      return { stdout: 'commit.ts\n', stderr: '' };
    });

    const files = await Effect.runPromise(
      getChangedFilesEffect(cwd, { commit: 'abc123' }).pipe(Effect.provide(layer)),
    );

    expect(files).toEqual(['commit.ts']);
    expect(calls.some((c) => c.args.includes('parent-sha..abc123def456'))).toBe(true);
  });
});
