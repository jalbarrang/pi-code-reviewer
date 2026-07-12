export type LensSeverity = 'blocker' | 'warning' | 'note';

export type LensFinding = {
  file: string;
  line?: number;
  severity: LensSeverity;
  message: string;
};

export type LensConfig = {
  name: string;
  description: string;
  criteria: string;
  tools: string[];
  severityRules: Record<LensSeverity, string>;
};

export type LensResult = {
  lens: string;
  findings: LensFinding[];
  summary: string;
  toolOutputs?: Record<string, string>;
  /** Lens-specific prompt section (without the diff), assembled by the command
   *  layer with a single shared diff to avoid per-lens duplication. */
  _lensSection?: string;
};

// ── Finder + verifier engine ─────────────────────────────────────────────────

/** A finding as emitted by the bug-finder stage. */
export type Finding = {
  file: string;
  /** Inclusive line span as reported by the model (e.g. "42" or "10-14"). */
  lineRange?: string;
  category: string;
  /** 1–10. */
  severity: number;
  /** 0–100. */
  confidence: number;
  summary: string;
  reasoning: string;
  /** True when the verifier gate skipped or the verifier failed open. */
  unverified?: boolean;
  /** Human tag when unverified (e.g. "unverified — below verification threshold"). */
  unverifiedTag?: string;
};

/** A finder finding after the verifier CONFIRMED it (possibly re-scored). */
export type VerifiedFinding = Finding & {
  evidence?: string;
};

/** A finder finding the verifier DISMISSED. */
export type DismissedFinding = {
  finding: Finding;
  reason: string;
};

/** Per-lens findings using blocker/warning/note (when lenses are active). */
export type EngineLensFindings = Record<string, LensFinding[]>;

export type VerificationStatus = 'ran' | 'skipped' | 'failed-open' | 'disabled' | 'no-findings';

export type EngineTelemetry = {
  discoveryCount: number;
  /** Post-verification count, or null when the verifier did not run. */
  postVerificationCount: number | null;
  finalCount: number;
  verification: VerificationStatus;
  finderModel: string;
  verifierModel: string;
  finderFailed?: boolean;
  finderErrorSample?: string;
  verifierFailed?: boolean;
  verifierErrorSample?: string;
};

export type EngineResult = {
  findings: Finding[];
  dismissed: DismissedFinding[];
  lensFindings: EngineLensFindings;
  telemetry: EngineTelemetry;
};

/** Reasoning/thinking effort for a step (mirrors pi-ai's `ThinkingLevel`). */
export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** A per-step model choice in config: either a bare spec string
 *  ("provider/id", id, or name) or that spec plus a reasoning level. */
export type ModelSpec = { model: string; reasoning?: ReasoningLevel };
export type ModelStepConfig = string | ModelSpec;

/** A resolved per-step assignment the engine runs against. `key` is either
 *  {@link DEFAULT_MODEL_KEY} (the session model) or a spec that resolved to a
 *  real model; `label` is the human display (key + reasoning). */
export type ModelAssignment = {
  key: string;
  label: string;
  reasoning?: ReasoningLevel;
};

export type ModelPlan = {
  finder: ModelAssignment;
  verifier: ModelAssignment;
};

/** Tunables for the finder+verifier engine (all overridable in config). */
export type ReviewEngineConfig = {
  /** Model for the bug-finder stage. Omitted → session model. */
  finderModel?: ModelStepConfig;
  /** Model for the bug-verifier stage. Omitted → session model. */
  verifierModel?: ModelStepConfig;
  /** Run the verifier when the gate triggers. Default true. */
  verify: boolean;
  /** Hard cap on findings returned. */
  maxFindings: number;
};

export type ReviewConfig = {
  lensDir: string;
  defaultLenses: string[];
  /** Per-tool wall-clock timeout in ms. A lens tool that exceeds it is killed
   *  and reported as timed-out (it must never hang the review). */
  toolTimeoutMs: number;
  /** Max lens tools run in parallel. Tools are deduped across lenses first,
   *  so this bounds the distinct command set, not lens count. */
  toolConcurrency: number;
  /** Finder+verifier engine tunables (see {@link ReviewEngineConfig}). */
  review: ReviewEngineConfig;
};
