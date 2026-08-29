# Project Control

## Product North Star

Deliver a production-safe Story Engine V3 that can generate long-form fiction without continuity drift, hidden-truth leakage, cross-arc contamination, model-tier downgrades, or partial persistence. Author settings must compile into one deterministic runtime contract shared by planning, writing, validation, repair, diagnostics, and save.

## Release Stage

Pre-finalization — CEO rework implementation complete and ready for final acceptance.

## Current Work Package

Close the three CEO review blockers on the current branch:

1. Safe-by-default output-language enforcement for normal Vietnamese V3 projects that omit explicit language keys.
2. Authoritative normalization and end-to-end use of `chapterWordTarget`.
3. Runtime candidate routing by the actual `StoryModelRole`.

Scope also includes finalization control documents, complete automated verification, diff review, and a local-only commit. Push, merge, and pull request creation are out of scope.

## Completed Milestones

- Story Engine V3 authoritative control/state architecture.
- Fail-closed semantic QA and safe diagnostics.
- Atomic batch acceptance and state integration.
- Writer continuity hardening, exact chapter envelopes, hidden-truth-safe repair, and maximum two AutoRepair passes.
- CEO rework regression suite covering language, pacing, and role-aware routing.

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
- Canonical and explicitly allowlisted foreign terms remain legal under language enforcement.
- `chapterWordTarget.soft=true` softens only the minimum; ideal remains the drafting target and maximum remains hard.
- `neverPadWithFiller=true` remains explicit in Writer and AutoRepair instructions.

## Acceptance Status

PASS candidate. Implementation, regression coverage, full tests, TypeScript, production build, and final diff review pass. The work package is finalized in one local-only commit with a clean worktree at handoff.

## Next Milestone

CEO final acceptance review, followed by a separately authorized release action. No push, merge, or pull request is authorized in this work package.
