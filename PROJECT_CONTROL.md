# Project Control

## Product North Star

Deliver a production-safe Story Engine V3 that can generate long-form fiction without continuity drift, hidden-truth leakage, cross-arc contamination, model-tier downgrades, or partial persistence. Author settings must compile into one deterministic runtime contract shared by planning, writing, validation, repair, diagnostics, and save.

## Release Stage

Pre-finalization — CEO hidden-truth rework implementation complete and ready for final acceptance.

## Current Work Package

Close the CEO final-audit hidden-truth blocker after the original three rework items:

1. Make Writer language allowlisting chapter-scoped and projection-safe.
2. Prevent registry, Bible, and explicit author allowlists from exposing gated future identities.
3. Preserve legitimate currently-visible foreign-script canonical names.
4. Keep Validator authority while isolating Writer and AutoRepair context.

Scope also includes finalization control documents, complete automated verification, diff review, and a local-only commit. Push, merge, and pull request creation are out of scope.

## Completed Milestones

- Story Engine V3 authoritative control/state architecture.
- Fail-closed semantic QA and safe diagnostics.
- Atomic batch acceptance and state integration.
- Writer continuity hardening, exact chapter envelopes, hidden-truth-safe repair, and maximum two AutoRepair passes.
- CEO rework regression suite covering language, pacing, and role-aware routing.
- CEO final-audit regression suite covering pre-gate Writer/AutoRepair isolation, post-gate unlock, foreign-script canonical names, and explicit-allowlist filtering.

## P0/P1/P2 Issues

### P0

- None open.

### P1

- None open.

### P2

- Retire the legacy generic `aiFastRunner` / `aiProRunner` / `aiSemanticRunner` compatibility adapters after all non-UI callers migrate to `aiRoleRunner`.
- Add a sanitized, tracked golden fixture for the complete production one-file artifact if that artifact becomes repository-managed; the current regression uses its exact relevant `storyEngineSettingsV3.chapterWordTarget` shape.
- Resolve the repository baseline ESLint debt (10 React-hook errors outside this work package) and the existing Vite large-chunk warning.

## Non-Negotiable Invariants

- Semantic QA fails closed when approved QUALITY candidates are unavailable or exhausted.
- No QUALITY role silently falls back to FAST.
- AutoRepair is capped at two attempts.
- Hidden author truths never enter Writer View, repair requests, diagnostics, or persisted logs before their gates.
- Batch save is atomic; rejected chapters and derived state are not persisted.
- Writer output contains the exact requested chapter set and valid chapter envelopes.
- Cross-arc chapter planning and Writer View projection remain isolated.
- Production code contains no novel-specific hard-code.
- Canonical and explicitly allowlisted foreign terms remain legal only when they are chapter-safe for the current Writer projection.
- Full registry/Bible character identities are Validator-only; Writer and AutoRepair receive only currently legal projected terms.
- `chapterWordTarget.soft=true` softens only the minimum; ideal remains the drafting target and maximum remains hard.
- `neverPadWithFiller=true` remains explicit in Writer and AutoRepair instructions.

## Acceptance Status

PASS candidate. The hidden-truth regression is closed by chapter-scoped language contracts across Writer context, Writer output validation, and AutoRepair. Full tests, TypeScript, production build, and final diff review pass. The work package is finalized in local-only commits with a clean worktree at handoff.

## Next Milestone

CEO final acceptance review, followed by a separately authorized release action. No push, merge, or pull request is authorized in this work package.
