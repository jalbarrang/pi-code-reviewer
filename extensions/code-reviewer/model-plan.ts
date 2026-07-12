/**
 * Resolve the finder + verifier model plan for a review run.
 *
 * Config supplies each stage as a spec string ("provider/id", bare id, or
 * display name) or `{ model, reasoning }`. Unresolvable specs degrade to the
 * session model with a warning, so a typo never fails the review.
 */

import type { Api, Model } from '@earendil-works/pi-ai';

import { DEFAULT_MODEL_KEY, type ModelResolution, resolveModelSpec } from './effects/model';
import type { ModelAssignment, ModelPlan, ModelStepConfig, ReviewEngineConfig } from './types';

export type ResolvedModelPlan = {
  resolution: ModelResolution;
  plan: ModelPlan;
  warnings: string[];
};

function stepParts(step: ModelStepConfig | undefined): {
  spec?: string;
  reasoning?: ModelAssignment['reasoning'];
} {
  if (step === undefined) return {};
  if (typeof step === 'string') return { spec: step };
  return { spec: step.model, reasoning: step.reasoning };
}

function labelFor(key: string, reasoning?: ModelAssignment['reasoning']): string {
  return reasoning ? `${key} (${reasoning})` : key;
}

export function resolveModelPlan(
  review: Pick<ReviewEngineConfig, 'finderModel' | 'verifierModel'>,
  defaultModel: Model<Api>,
  registry: { getAll: () => Model<Api>[] },
): ResolvedModelPlan {
  const byKey = new Map<string, Model<Api>>();
  const warnings: string[] = [];

  const assign = (step: ModelStepConfig | undefined): ModelAssignment => {
    const { spec, reasoning } = stepParts(step);
    if (!spec || !spec.trim()) {
      return { key: DEFAULT_MODEL_KEY, label: labelFor(DEFAULT_MODEL_KEY, reasoning), reasoning };
    }
    const key = spec.trim();
    if (key !== DEFAULT_MODEL_KEY && !byKey.has(key)) {
      const model = resolveModelSpec(registry, key);
      if (!model) {
        warnings.push(`review model "${key}" not found — using the session model for those steps`);
        return { key: DEFAULT_MODEL_KEY, label: labelFor(DEFAULT_MODEL_KEY, reasoning), reasoning };
      }
      byKey.set(key, model);
    }
    return { key, label: labelFor(key, reasoning), reasoning };
  };

  return {
    resolution: { defaultModel, byKey },
    plan: {
      finder: assign(review.finderModel),
      verifier: assign(review.verifierModel),
    },
    warnings,
  };
}

/** Default plan: both stages on the session model. */
export function defaultModelPlan(): ModelPlan {
  const step: ModelAssignment = { key: DEFAULT_MODEL_KEY, label: DEFAULT_MODEL_KEY };
  return { finder: { ...step }, verifier: { ...step } };
}
