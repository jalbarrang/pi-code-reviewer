import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { resolve } from 'node:path';

import { readChangedFilesEffect } from '../extensions/code-reviewer/changed-files';
import { fileSystemLayer } from './helpers';

const cwd = '/repo';

function read(files: string[], opts: Parameters<typeof fileSystemLayer>[0]) {
  return Effect.runPromise(
    readChangedFilesEffect(cwd, files).pipe(Effect.provide(fileSystemLayer(opts))),
  );
}

describe('readChangedFilesEffect', () => {
  test('reads existing files keyed by their relative path', async () => {
    const out = await read(['src/a.ts', 'src/b.ts'], {
      files: {
        [resolve(cwd, 'src/a.ts')]: 'a-contents',
        [resolve(cwd, 'src/b.ts')]: 'b-contents',
      },
    });
    expect(out).toEqual({ 'src/a.ts': 'a-contents', 'src/b.ts': 'b-contents' });
  });

  test('skips deleted / unreadable files rather than failing', async () => {
    const out = await read(['src/gone.ts', 'src/here.ts'], {
      files: { [resolve(cwd, 'src/here.ts')]: 'here' },
    });
    expect(out).toEqual({ 'src/here.ts': 'here' });
  });

  test('does not follow changed symlinks outside the reviewed repo', async () => {
    const candidate = resolve(cwd, 'src/link.ts');
    const out = await read(['src/link.ts'], {
      files: { '/outside/secret.ts': 'secret' },
      realPaths: { [candidate]: '/outside/secret.ts' },
    });
    expect(out).toEqual({});
  });

  test('truncates oversized files', async () => {
    const big = 'x'.repeat(120_000);
    const out = await read(['src/big.ts'], { files: { [resolve(cwd, 'src/big.ts')]: big } });
    expect(out['src/big.ts'].length).toBeLessThan(big.length);
    expect(out['src/big.ts']).toContain('truncated');
  });
});
