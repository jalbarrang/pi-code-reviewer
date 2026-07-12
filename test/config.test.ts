import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { resolve } from 'node:path';

import { loadConfigEffect } from '../extensions/code-reviewer/config';
import { fileSystemLayer } from './helpers';

const cwd = '/repo';
const configPath = resolve(cwd, '.code-review.json');

function run(opts: Parameters<typeof fileSystemLayer>[0]) {
  return Effect.runPromise(loadConfigEffect(cwd).pipe(Effect.provide(fileSystemLayer(opts))));
}

describe('loadConfigEffect', () => {
  const DEFAULT_ENGINE = {
    verify: true,
    maxFindings: 50,
  };

  const DEFAULTS = {
    lensDir: '.code-review/lenses',
    defaultLenses: [],
    toolTimeoutMs: 60_000,
    toolConcurrency: 4,
    review: DEFAULT_ENGINE,
  };

  test('returns defaults when no config file exists', async () => {
    const config = await run({});
    expect(config).toEqual(DEFAULTS);
  });

  test('returns defaults when config JSON is malformed', async () => {
    const config = await run({ files: { [configPath]: '{ not json' } });
    expect(config).toEqual(DEFAULTS);
  });

  test('reads lensDir and defaultLenses from the config file', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({ lensDir: 'review/lenses', defaultLenses: ['code-quality'] }),
      },
    });
    expect(config).toEqual({
      ...DEFAULTS,
      lensDir: 'review/lenses',
      defaultLenses: ['code-quality'],
    });
  });

  test('reads review engine overrides', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({
          review: { verify: false, maxFindings: 25 },
        }),
      },
    });
    expect(config.review.verify).toBe(false);
    expect(config.review.maxFindings).toBe(25);
  });

  test('parses per-step model overrides (string + { model, reasoning })', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({
          review: {
            finderModel: 'anthropic/claude-opus-4-8',
            verifierModel: { model: 'anthropic/claude-opus-4-8', reasoning: 'medium' },
          },
        }),
      },
    });
    expect(config.review.finderModel).toBe('anthropic/claude-opus-4-8');
    expect(config.review.verifierModel).toEqual({
      model: 'anthropic/claude-opus-4-8',
      reasoning: 'medium',
    });
  });

  test('drops an invalid reasoning level but keeps the model', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({
          review: { verifierModel: { model: 'openai/gpt-5.5', reasoning: 'ultra' } },
        }),
      },
    });
    expect(config.review.verifierModel).toEqual({ model: 'openai/gpt-5.5' });
  });

  test('ignores invalid maxFindings, falling back to default', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({ review: { maxFindings: -2 } }),
      },
    });
    expect(config.review.maxFindings).toBe(50);
  });

  test('ignores legacy pipeline keys without throwing', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({
          rejectionsFile: '.code-review/rejections.jsonl',
          review: {
            passes: 3,
            validate: false,
            minVotes: 1,
            concurrency: 8,
            temperature: 0.9,
            recordRejections: false,
            passModel: 'anthropic/claude-opus-4-8',
            passModels: [{ model: 'openai/gpt-5.5', reasoning: 'low' }],
            validateModel: { model: 'anthropic/claude-opus-4-8', reasoning: 'high' },
          },
        }),
      },
    });
    expect(config).toEqual(DEFAULTS);
  });

  test('fills missing fields with defaults', async () => {
    const config = await run({
      files: { [configPath]: JSON.stringify({ defaultLenses: ['a', 'b'] }) },
    });
    expect(config.lensDir).toBe('.code-review/lenses');
    expect(config.defaultLenses).toEqual(['a', 'b']);
    expect(config.toolTimeoutMs).toBe(60_000);
    expect(config.toolConcurrency).toBe(4);
    expect(config.review).toEqual(DEFAULT_ENGINE);
  });

  test('reads toolTimeoutMs / toolConcurrency overrides', async () => {
    const config = await run({
      files: { [configPath]: JSON.stringify({ toolTimeoutMs: 15_000, toolConcurrency: 2 }) },
    });
    expect(config.toolTimeoutMs).toBe(15_000);
    expect(config.toolConcurrency).toBe(2);
  });

  test('ignores non-positive / invalid tool knobs, falling back to defaults', async () => {
    const config = await run({
      files: {
        [configPath]: JSON.stringify({ toolTimeoutMs: 0, toolConcurrency: -3 }),
      },
    });
    expect(config.toolTimeoutMs).toBe(60_000);
    expect(config.toolConcurrency).toBe(4);
  });
});
