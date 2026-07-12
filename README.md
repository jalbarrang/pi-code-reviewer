# @dreki-gg/pi-code-reviewer

Bug-focused code review extension for [pi](https://github.com/earendil-works/pi). Reviews are driven by a **per-project review context** (`.code-reviewer/context.md`) plus optional **criteria lenses** — the context carries invariants, intentional patterns, and failure classes; lenses add criteria-specific evaluation. This package is the native pi implementation of the harness-agnostic [code-reviewer skill](skills/code-reviewer/SKILL.md), which it vendors verbatim.

## Install

```bash
pi install npm:@dreki-gg/pi-code-reviewer
```

This is a **project-local** extension. Install it per-project so each project owns its own review context, lenses, and tools.

## Quick start

```
/review-init     # one-time setup: scan + interview → .code-reviewer/context.md
/review          # review uncommitted changes (incl. untracked files)
```

The context is **mandatory**: without it `/review`, `/review-learn`, `/review-lenses`, and the `code_review` tool hard-fail with `code-reviewer is not initialized for this project — run /review-init first.` `/review-status` reports the uninitialized state and stops. This is deliberate — a generic review is worse than no review, because its findings look authoritative while carrying no project signal. There is no degraded mode and no silent auto-generation.

## Setup (`/review-init`)

`/review-init` runs an interactive setup flow: it scans the codebase, interviews you in short rounds (2–3 questions each, only what the scan could not answer), and — after you confirm — writes `.code-reviewer/context.md`. It then offers the packaged lens catalog as a multi-select (defaulting to **none**), copies the lenses you pick into `.code-review/lenses/`, and merges their ids into `.code-review.json` `defaultLenses`.

It never overwrites an existing `context.md` silently — if one exists it offers to refresh or fill gaps and merge. See [references/CONTEXT-TEMPLATE.md](skills/code-reviewer/references/CONTEXT-TEMPLATE.md) for the context shape and the anti-rot rules (durable invariants, one owner per fact, every line changes a review decision).

## Commands

| Command | Behavior |
| --- | --- |
| `/review [--branch base \| --commit sha] [--lens a,b] [--staged] [--repo dir]` | Context gate → resolve diff → load lenses → finder + conditional verifier → tiered report. A lens-less review is valid (pure context-driven bug hunt). |
| `/review-init` | One-time setup: codebase scan → short interview → write `.code-reviewer/context.md` → offer the lens catalog and copy the chosen lenses into the project. |
| `/review-learn [note]` | Fold a false positive or a missed bug back into `context.md` (anti-rot). Requires an initialized project; confirms the exact one-line edit before writing. |
| `/review-status` | Read-only health report: unfinished/placeholder sections, presence of the high-value sections, active lenses, and staleness vs git history. Reports "not initialized" and stops if there is no context. |
| `/review-lenses [--repo dir]` | List the active project lenses (★ = default) plus catalog lenses not yet enabled. |
| `code_review` tool | Same context gate + engine as `/review`, callable by the agent. Params: `lenses`, `branch`, `base` (alias), `commit`, `staged`, `cwd`. Returns a tiered Markdown report plus structured `details`; large output spills to a temp file to survive pi's tool-output cap. |

## Diff targets

`/review` with no target reviews all uncommitted changes — staged + unstaged vs `HEAD` **plus untracked new files** (diffed against `/dev/null` so brand-new files an agent just created are covered). Untracked collection is read-only (never `git add -N`), capped at 200 files, and degrades per-file on failure.

| Flag | Diff |
| --- | --- |
| *(none)* | All uncommitted changes incl. untracked new files (falls back to the working tree in a repo with no commits). |
| `--staged` | Staged changes only (pure git, no untracked files). |
| `--branch <base>` | Merge-base triple-dot diff: `base...HEAD`. **`--base` is a kept alias** for `--branch`. |
| `--commit <sha>` | The single commit's patch (`parent..sha`, or the full patch for a root commit). |
| `--repo <dir>` | Run git/config/lens/context resolution against a different directory — a worktree or sibling repo. **`--cwd` is an alias.** |

### Reviewing worktrees & other repos (`--repo`)

By default `/review` runs git against the pi session directory. Pass `--repo <dir>` (alias `--cwd <dir>`) to target a git worktree (sibling or nested) or another repo without leaving the session:

```
/review --repo /path/to/worktree --branch main --lens security,concurrency
```

The path is resolved relative to the session directory and validated as a git work tree (relative paths like `../project-pr35` work). `.code-review.json`, lenses, and `.code-reviewer/context.md` all resolve relative to the override directory; the session directory itself is left unchanged — only git/config/lens/context resolution is redirected. The `code_review` tool exposes the same override via its optional `cwd` parameter.

## How the review runs (finder + verifier)

When a session model is available, `/review` and the `code_review` tool run the review themselves through a two-stage engine:

1. **Finder pass** — one model call with the vendored `bug-finder` prompt plus `context.md`, the diff, the full contents of every changed file, and any active lens instructions. It emits findings (`file`, `lineRange`, `category`, `severity` 1–10, `confidence` 0–100, `summary`, `reasoning`) and, when lenses are active, per-lens `blocker`/`warning`/`note` findings.
2. **Conditional verifier gate** — the verifier is **skipped** when there are no findings, when `review.verify` is `false`, or when every finding is severity < 5 **and** none touch a file named in the context's *Critical invariants* or *Historical bug classes* sections (path-like backticked tokens are extracted from those sections as the gate). Skipped findings are still reported (as Minor, tagged `unverified — below verification threshold`), never dropped.
3. **Verifier pass** (when the gate triggers) — the vendored `bug-verifier` prompt tries to falsify each finding against `context.md` and the diff, re-scoring survivors and dismissing false positives (and anything below confidence 50). It **fails open**: if the verifier errors or returns incomplete output, the affected findings are surfaced tagged `unverified — verifier unavailable` rather than silently lost.

**Fallback:** when no session model is available (e.g. print mode), the tool returns a project-aware single-pass review prompt — embedding the bug-finder role, `context.md`, the diff, changed files, and lens instructions — so the calling agent still performs a context-grounded review, never a generic one.

## Report format

Findings are grouped into tiers with a leading emoji, followed by supporting sections:

```
## Critical (1)

- 🔴 **Critical** `src/auth/session.ts:42` — token expiry compared with `>` instead of `>=` _(severity 9, confidence 85%, logic)_

## Important (1)

- 🟡 **Important** `src/api/user.ts:10` — unbounded query on an unindexed column _(severity 6, confidence 70%, logic)_

## Dismissed (1)

- `src/util/parse.ts:8` — off-by-one on an empty slice _(guarded by the length check on line 6)_

**Lenses**: security, concurrency
**Verification**: ran

**Metadata**
- files reviewed: 4
- discovery: 3
- post-verification: 2
- final: 2
```

Tier thresholds: **Critical** = severity ≥ 8 & confidence ≥ 70; **Important** = severity ≥ 5 & confidence ≥ 60; **Minor** = severity ≥ 3 & confidence ≥ 50. Lens findings map directly: blocker → Critical, warning → Important, note → Minor. The **Dismissed** section appears only when the verifier actually ran; **Verification** reports `ran` / `skipped (low-risk diff)` / `disabled` / failed-open. A discovery-pass failure is reported as **Inconclusive** — never as a clean review — and a genuinely clean diff says so plainly without inventing concerns.

## Lenses

A lens is a markdown file defining review criteria, project tools to run, and severity rules:

```md
# Security

Find exploitable weaknesses introduced or worsened by the diff.

## Criteria
- Is untrusted input validated before it reaches a sink?
- Are new endpoints authorized?

## Tools
- `npm run typecheck`
- `npm run lint`

## Severity
- blocker: Injection, missing authorization, secret exposure
- warning: Unsafe handling of untrusted input
- note: Defensive-hardening suggestions
```

> **Tools must be fast and exit on their own** (typecheck, lint, unit tests). Do **not** list dev servers, watch mode, e2e suites, or full production builds — they bind ports / run for minutes and belong in CI. Tools are **deduped across lenses and run concurrently**, so a command shared by several lenses runs once, and a slow/hanging command stalls the whole review (bounded by `toolTimeoutMs`).

### Packaged lens catalog

The package ships five example lenses; none are active by default. `/review-init` offers them as a multi-select and **copies** the chosen ones into `.code-review/lenses/`.

| Lens | Focus |
| --- | --- |
| `clean-code` | Maintainability hazards that make bugs likely or hide them — over-large functions, misleading names, duplicated logic, dense control flow |
| `ddd` | Domain boundaries — domain logic in the domain layer, invariants inside aggregates, consistent ubiquitous language |
| `security` | Injection, missing authorization, secret exposure, unsafe handling of untrusted input |
| `concurrency` | Race conditions, ordering hazards, shared-state bugs, async/await gaps |
| `api-compat` | Breaking changes to exported functions/types, HTTP/RPC contracts, persisted schemas, and event formats |

Copies are **project-owned**: you edit them freely and they are never auto-synced with the catalog. Hand-written custom lenses in the same directory are discovered identically. With zero lenses selected, review is pure context-driven bug hunting — a valid, common setup.

## Configuration

`.code-review.json`:

```json
{
  "lensDir": ".code-review/lenses",
  "defaultLenses": ["security", "concurrency"],
  "toolTimeoutMs": 60000,
  "toolConcurrency": 4,
  "review": {
    "finderModel": { "model": "anthropic/claude-opus-4-8", "reasoning": "medium" },
    "verifierModel": "anthropic/claude-opus-4-8",
    "verify": true,
    "maxFindings": 50
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `lensDir` | `.code-review/lenses` | Directory containing lens files |
| `defaultLenses` | `[]` | Lenses to run when none are passed (empty = all discovered lenses, i.e. a context-only hunt when there are none) |
| `toolTimeoutMs` | `60000` | Per-tool wall-clock timeout (ms); an exceeding tool is killed and reported as timed-out |
| `toolConcurrency` | `4` | Max distinct tools run in parallel (tools are deduped across lenses first) |
| `review.finderModel` | session model | Model for the bug-finder stage: a spec string (`"provider/id"`, bare id, or name) or `{ "model", "reasoning" }` |
| `review.verifierModel` | session model | Model for the bug-verifier stage (string or `{ "model", "reasoning" }`) |
| `review.verify` | `true` | Run the verifier when the gate triggers; `false` disables it entirely (findings reported unverified) |
| `review.maxFindings` | `50` | Hard cap on findings returned |

Each model step accepts either a plain spec string or `{ "model": "provider/id", "reasoning": "low" }`, where `reasoning` is one of `minimal` / `low` / `medium` / `high` / `xhigh` (applied as the thinking effort for that step; ignored by providers that don't support it). By default both stages reuse the **session's current model** (`ctx.model`) — no separate API key or model config. An unresolvable spec degrades to the session model with a warning, so a typo never fails a review. Unknown or legacy config keys are ignored silently — the loader never fails.

## Vendored skill & canonical source

`skills/code-reviewer/` is a **verbatim copy** of the canonical, harness-agnostic [code-reviewer skill](skills/code-reviewer/SKILL.md). The extension reads its assets (agent prompts, lens catalog, reference flows, context template) from that directory, so the same behavior ships to skill users and extension users.

The canonical source lives in a sibling repo. Refresh the vendored copy with:

```bash
bun run sync:canonical                       # from ../skills/code-reviewer (default)
bun run sync:canonical --from /path/to/skill # or an explicit source
```

The default source path is `../skills/code-reviewer` (override via `--from` or the `CODE_REVIEWER_CANONICAL` env var).

## Migration from the Bugbot-style pipeline (≤ 0.9.x)

The multi-pass adversarial voting engine was replaced by the finder + verifier engine described above. If you are upgrading, the following are **removed**:

- **Multi-pass voting and temperature jitter** — `review.passes`, `review.concurrency`, `review.temperature`, and the majority-vote `minVotes` bucketing are gone. Discovery is now a single context-grounded finder call.
- **Model bake-off** — `review.passModel` / `review.passModels` (round-robin models across passes) and `review.validate` / `review.validateModel` are replaced by `review.finderModel`, `review.verifierModel`, and `review.verify`.
- **Recorded rejections** — `.code-review/rejections.jsonl`, `review.recordRejections`, and `rejectionsFile` are gone. Persisting and downranking machine-refuted false positives is superseded by the human-curated **learn loop**: when a review gets something wrong, `/review-learn` folds the lesson into `.code-reviewer/context.md` as a durable intentional-pattern or invariant, and the verifier honors it on every later run.

These keys are now ignored rather than honored; the config loader will not fail on them. Delete them and adopt the `review` block above.
