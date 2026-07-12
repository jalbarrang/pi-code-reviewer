import { describe, expect, test } from 'bun:test';

import { resolveModelSpec } from '../extensions/code-reviewer/effects/model';
import { resolveModelPlan } from '../extensions/code-reviewer/model-plan';
import type { ReviewEngineConfig } from '../extensions/code-reviewer/types';

type FakeModel = { id: string; name: string; provider: string };

const MODELS = [
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'google' },
] satisfies FakeModel[];

const registry = { getAll: () => MODELS as never };
const sessionModel = { id: 'session', name: 'Session', provider: 'local' } as never;

function config(overrides: Partial<ReviewEngineConfig> = {}): ReviewEngineConfig {
  return {
    verify: true,
    maxFindings: 50,
    ...overrides,
  };
}

describe('resolveModelSpec', () => {
  test('matches by provider/id, bare id, and display name', () => {
    expect(resolveModelSpec(registry, 'openai/gpt-5.5')?.id).toBe('gpt-5.5');
    expect(resolveModelSpec(registry, 'claude-opus-4-6')?.provider).toBe('anthropic');
    expect(resolveModelSpec(registry, 'Gemini 3 Pro')?.id).toBe('gemini-3-pro');
  });

  test('returns undefined for unknown or empty specs', () => {
    expect(resolveModelSpec(registry, 'openai/does-not-exist')).toBeUndefined();
    expect(resolveModelSpec(registry, '   ')).toBeUndefined();
  });
});

describe('resolveModelPlan', () => {
  test('no overrides → finder and verifier use the session model', () => {
    const { plan, resolution, warnings } = resolveModelPlan(config(), sessionModel, registry);
    expect(plan.finder.key).toBe('default');
    expect(plan.verifier.key).toBe('default');
    expect(resolution.byKey.size).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  test('finderModel and verifierModel resolve independently', () => {
    const { plan, resolution } = resolveModelPlan(
      config({
        finderModel: 'openai/gpt-5.5',
        verifierModel: 'google/gemini-3-pro',
      }),
      sessionModel,
      registry,
    );
    expect(plan.finder.key).toBe('openai/gpt-5.5');
    expect(plan.verifier.key).toBe('google/gemini-3-pro');
    expect([...resolution.byKey.keys()].sort()).toEqual(['google/gemini-3-pro', 'openai/gpt-5.5']);
  });

  test('a reasoning-bearing object spec carries reasoning + a labelled assignment', () => {
    const { plan } = resolveModelPlan(
      config({
        finderModel: { model: 'anthropic/claude-opus-4-6', reasoning: 'low' },
        verifierModel: { model: 'anthropic/claude-opus-4-6', reasoning: 'medium' },
      }),
      sessionModel,
      registry,
    );
    expect(plan.finder).toEqual({
      key: 'anthropic/claude-opus-4-6',
      label: 'anthropic/claude-opus-4-6 (low)',
      reasoning: 'low',
    });
    expect(plan.verifier.reasoning).toBe('medium');
    expect(plan.verifier.label).toBe('anthropic/claude-opus-4-6 (medium)');
  });

  test('an unknown spec degrades to the session model with a warning', () => {
    const { plan, warnings } = resolveModelPlan(
      config({ finderModel: 'openai/ghost', verifierModel: 'openai/gpt-5.5' }),
      sessionModel,
      registry,
    );
    expect(plan.finder.key).toBe('default');
    expect(plan.verifier.key).toBe('openai/gpt-5.5');
    expect(warnings.some((warning) => warning.includes('openai/ghost'))).toBe(true);
  });
});
