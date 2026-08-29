# Project Control

## Directive Source and Baseline

- Authoritative directive: `PROJECT_CONTROL.md` and `FINAL_ACCEPTANCE.md` on `main`.
- Accepted predecessor package: CEO rework/finalization package at `ccb52a4`.
- Gate 1/2 audit branch: `codex/finalization-gates-1-2`, created directly from clean `main`; current Gate 3 branch is recorded below.
- Audit date: 2026-08-29 (Asia/Saigon).
- Scope constraint: Gate 2 is audit and work-package definition only. No finding is remediated in this gate.

## Product North Star

Deliver a production-safe, browser-first Vietnamese AI workspace for long-form fiction translation, editing, repair, publishing, and original story generation. The product must preserve manuscripts and project state, protect credentials and hidden author truth, handle supported document formats safely, route AI work according to declared quality tiers, and produce recoverable, deterministic outputs under network, model, browser-storage, and malformed-input failure.

Story Engine V3 remains a release-critical subsystem, but final product acceptance applies to the whole application: access/edition behavior, UI workflows, import and export, translation and analysis pipelines, Gemini and DeepSeek integrations, local persistence and backup/restore, logs and diagnostics, text utilities, and build/deployment controls.

## Release Stage

FINALIZATION PROGRAM — Gate 1 and Gate 2 complete. Gate 3 rework leaves WP-FIN-01 accepted and WP-FIN-02 **CONDITIONAL / BLOCKED ON WP-FIN-03**. Release remains **BLOCKED** by the provider authorization dependency, four open P1 findings, and later work packages. The predecessor Story Engine package remains accepted; this decision concerns whole-app production acceptance.

## Gate 3 — P0 Closure Program (CEO Rework Recorded)

Branch: `codex/finalization-p0-closure`, created from clean updated `main` at `4c190170e44196f245e8cddaa0062b85f1a43072`.

### WP-FIN-01 — PDF Security and Runtime Containment

Status: **PASS**.

| Finding | Verdict | Evidence |
| --- | --- | --- |
| P0-SEC-001 | PASS | `pdfjs-dist` remains pinned at 6.2.108; both npm audits report zero vulnerabilities; document initialization is fail-closed (`stopAtErrors: true`) with XFA, PDF scripting (`enableScripting: false`), and eval compatibility (`isEvalSupported: false`) disabled. |
| P1-FUN-001 | PASS | Vite emits a hashed local `pdf.worker.min-*.mjs` and same-origin CMap/ICC/font/WASM assets. Production CSP remains `worker-src 'self' blob:` without `unsafe-eval` or a public PDF CDN. |

Automated evidence: six WP-FIN-01 Vitest regressions cover ordinary and malformed fixtures, eval/XFA/scripting defenses, local worker/CSP, dependency range, and accepted-workspace preservation. `npm run test:pdf-build` now also asserts that the emitted browser artifact sets `enableScripting` false. The prior production-browser PDF import evidence remains valid.

Selected version rationale: 6.2.108 was the current npm release on 2026-08-29, is maintained upstream, is well beyond the vulnerable `<=4.1.392` range, declares compatibility with the repository's Node 24 runtime, and removes the vulnerable optional `canvas`/`node-pre-gyp`/`tar` chain from the active lock tree.

### WP-FIN-02 — Credential and Provider Boundary

Status: **CONDITIONAL / BLOCKED ON WP-FIN-03**.

| Finding | Verdict | Evidence |
| --- | --- | --- |
| P0-SEC-002 | CONDITIONAL / BLOCKED ON WP-FIN-03 | Browser secret substitution/client SDK construction remain removed. A real Node production entry serves `dist` and `/api/provider` without `vite preview`, but owner-key execution is deliberately unavailable until WP-FIN-03 supplies a server-side session/entitlement authorizer. The route returns `AUTHORIZATION_NOT_CONFIGURED` fail-closed; therefore this package is not yet production-safe for provider calls. |
| P1-CRED-001 | PASS WITH WP-FIN-02 NOT FINALLY ACCEPTED | DeepSeek owner secret remains server-side; optional BYOK remains memory/request-only. Legacy localStorage/session/auto-backup/downloaded-backup credential fields are purged or recursively sanitized without changing manuscript fields. Network use remains blocked by the same WP-FIN-03 authorization dependency. |
| P2-LOG-001 (credential scope) | PASS | One narrow credential redactor now protects global persisted logs, crash/unhandled-rejection paths, Story Engine diagnostics, and provider error normalization. Broader non-credential P2 log/content policy remains for WP-FIN-07. |

Architecture evidence: `server/productionServer.ts` is bundled to `dist-server/productionServer.js`; `npm start` executes that artifact directly, binds `process.env.PORT` (safe default 8080), serves the React build with SPA fallback, and routes `/api/provider` to the existing `handleProviderGateway()` implementation. Both production and retained Vite middleware use a common HTTP adapter that requires a server-side authorization callback. No callback is installed in this package because sessions/entitlements belong to WP-FIN-03; there is intentionally no Origin/Referer/browser-secret/static-token substitute.

Automated evidence: thirteen provider-engine/security regressions remain passing, and three new production-server regressions cover static React serving, explicit authorization-blocked and unauthorized responses, safe post-authorization missing-secret handling, and credential non-disclosure. `npm run test:production-server` starts the built Node artifact, fetches the React app, calls `/api/provider`, verifies the `node-production` response marker and fail-closed WP-FIN-03 dependency, and checks browser-observable output for sentinel credentials. `npm run test:credential-build` scans 20 browser artifacts with zero sentinel/provider-boundary leaks.

#### Real Google AI Studio acceptance checklist (blocked until WP-FIN-03)

- Install and test the WP-FIN-03 server-side session/entitlement authorizer; this is the blocking prerequisite.
- Configure `GEMINI_API_KEY` in **AI Studio Settings → Secrets** only after that authority is active.
- Confirm browser DevTools Sources cannot find the key and built browser artifacts contain no key.
- Confirm provider Network request/response bodies never contain the server key.
- Complete one ordinary Gemini request and one streaming request.
- Complete one Story Engine call while preserving the selected role/model route.
- Remove the secret temporarily and confirm the health/config UI shows the explicit server-configuration error.
- Exercise a quota-limited mock/account state and confirm the browser still receives rate-limit semantics.

WP-FIN-03 through WP-FIN-08 remain open. WP-FIN-02 cannot receive final PASS until WP-FIN-03 supplies and tests the real server-side authorization authority.

### Gate 3 CEO-rework verification record

| Check | Result |
| --- | --- |
| Full Vitest | PASS — 21 files, 364/364 tests |
| TypeScript | PASS — `npx tsc --noEmit` |
| Production build | PASS — React build plus `dist-server/productionServer.js`; 877.69 kB largest application chunk; existing >500 kB P2 warning remains |
| ESLint | Known debt unchanged exactly — 10 errors, 27 warnings |
| Full npm audit | PASS — 0 vulnerabilities (baseline: 1 critical, 2 high) |
| Runtime npm audit | PASS — 0 vulnerabilities (baseline: 1 critical, 2 high) |
| PDF production artifact check | PASS — scripting disabled, local worker/assets, restrictive CSP |
| Credential production artifact check | PASS — 20 artifacts, 0 sentinel/provider-boundary leaks |
| Production Node server smoke | PASS — built React app and fail-closed `/api/provider` served by Node; no Vite preview dependency; credential sentinels absent |

## Gate 1 — Product Definition Freeze

Status: **PASS**.

The frozen product acceptance definition is:

1. A single-user browser application supporting Vietnamese long-form fiction workflows.
2. Supported input surfaces: TXT, SRT, VTT, ZIP, EPUB, DOC/DOCX, PDF, paste, full backup JSON, support-info JSON, and Story Engine setup import.
3. Supported core journeys: project setup; translation and AI validation; manual editing and repair; knowledge/dictionary/prompt management; original-story planning and generation; session persistence, backup, restore, and recovery; TXT/ZIP/DOCX/EPUB output.
4. AI providers: Gemini/Gemma and optional DeepSeek, with explicit model routing, bounded retries, visible failures, and no shared credential exposure.
5. Data-safety contract: no silent manuscript loss, no partial accepted batch, no unsafe restore mutation, bounded input resource use, recoverable local state, and secret-safe logs/diagnostics.
6. Story Engine contract: all previously accepted hidden-truth, pacing, routing, atomicity, context isolation, language, validation, and repair invariants remain mandatory.
7. Release-quality contract: production build, TypeScript, lint, dependency security, full automated suite, and representative browser smoke/E2E paths must pass from a reproducible install.
8. Edition/access contract: the declared Full/Lite entitlement behavior must match runtime behavior; a client-visible flag or hash alone is not accepted as enforceable access control.

Anything outside this definition requires an explicit post-freeze change decision. Detailed acceptance criteria are recorded in `FINAL_ACCEPTANCE.md`.

## Gate 2 — Whole-App Technical Audit

Status: **COMPLETE — release blockers open**.

### Audit Coverage

- Repository/control/config: package manifests and lockfiles, Vite, Vitest, TypeScript, ESLint, CSP, metadata, README, build output.
- Application shell and UI: startup, edition/expiry/access, navigation, modal management, workspace, editor, automation, creative, knowledge, prompt-fix, Sino-Vietnamese, backup UI.
- Provider boundary: Gemini/Gemma client creation and routing, DeepSeek fetch/key rotation, quota handling, health checks, content-safety probing.
- File/data boundary: TXT/SRT/VTT/ZIP/EPUB/DOC/DOCX/PDF parsing; cleanup/splitting; backup/restore; IndexedDB/localStorage; auto-backup; import/export.
- Translation boundary: scheduling, streaming parser, batch application, safety isolation, validation, repair, rescue routing, cancellation and retry paths.
- Story Engine V3: compiler, setup import, projections, planning, writing, validation, semantic QA, repair, state extraction, memory, sanity, diagnostics, routing, pipeline atomicity.
- Verification: 342-test default Vitest run, TypeScript, production build, ESLint, `npm audit`, source/risk-pattern review, and real-browser production-preview smoke of startup, navigation, TXT import, creative page, and PDF import.
- External model inventory check: configured Gemini/Gemma model identifiers were compared with current official Google model documentation on 2026-08-29.

### Findings Register

#### P0 — release blockers

| ID | Finding and impact | Evidence |
| --- | --- | --- |
| P0-SEC-001 | **RESOLVED — WP-FIN-01 PASS.** Original malicious-PDF exposure is closed by current PDF.js, explicit eval defense, local assets, and failure isolation. | Gate 3 WP-FIN-01 evidence above. |
| P0-SEC-002 | **CONDITIONAL — BLOCKED ON WP-FIN-03.** Browser credential exposure is removed and production wiring is real, but provider execution remains fail-closed until a server-side session/entitlement authority is installed. | Gate 3 WP-FIN-02 evidence above. |

#### P1 — must close before final acceptance

| ID | Finding and impact | Evidence |
| --- | --- | --- |
| P1-FUN-001 | **RESOLVED — WP-FIN-01 PASS.** Production PDF import uses a hashed same-origin worker and local assets under the existing restrictive CSP. | Gate 3 WP-FIN-01 evidence above. |
| P1-AUTH-001 | Declared access-code enforcement is absent. `REQUIRE_CODE=true` and `PASSWORD_HASH` are dead configuration; `handleEnter` checks expiry only and enters the app. | `src/constants.ts:44-47`; `src/components/IntroPage.tsx:21-28`; production-browser smoke entered the application with one click and no code prompt. |
| P1-DATA-001 | Full backup restore is not schema-validated or transactional. It clears the persisted current session after only checking that `files` is an array, then dereferences and applies untrusted nested fields. A malformed/incompatible backup can remove the last persisted session before restore fails or can inject invalid runtime state. | `src/hooks/fileHandler/fileBackupRestore.ts:30-51`; no backup version/schema validation or pre-commit rollback is present. |
| P1-QA-001 | “Full tests” is not the full repository suite and has no browser/UI gate. Vitest is Node-only and includes only `tests/**/*.test.ts`; `src/services/storyEngine/storyEngineV3.test.ts` contains a separate 28-test manual harness that is not discovered, and its synchronous helper does not await async callbacks such as Test 17. | `vitest.config.ts:4-9`; `src/services/storyEngine/storyEngineV3.test.ts:20-30,350-351`; direct Vitest invocation reports “No test files found”; no Testing Library/Playwright/Cypress test suite exists. |
| P1-RES-001 | User-controlled imports and restores have no file-count, compressed-size, expanded-size, page-count, or JSON-depth/size budgets. ZIP/DOCX/EPUB are expanded with `loadAsync` and PDF/backup files are read wholly into memory. Crafted or merely very large long-form inputs can freeze/crash the browser and jeopardize unsaved work. | `src/utils/file/parsers.ts:34-79,83-88,127-140,255-261`; `src/hooks/fileHandler/fileBackupRestore.ts:30`; no enforceable maximums were found. |
| P1-CRED-001 | **IMPLEMENTED; WP-FIN-02 NOT FINALLY ACCEPTED.** DeepSeek owner secret stays server-side; BYOK is memory/request-only and legacy durable copies are sanitized. Provider network access is blocked pending WP-FIN-03 authorization. | Gate 3 WP-FIN-02 evidence above. |

#### P2 — scheduled hardening/debt

| ID | Finding and impact | Evidence |
| --- | --- | --- |
| P2-QUAL-001 | Repository lint baseline fails: 10 errors and 27 warnings, including React effect/ref/immutability findings. | `npm run lint`: 37 findings across `AutoBackupPanel`, `AutomationModal`, `EditorModal`, `Header`, `IntroPage`, `WorkspacePage`, loading/log modals, and other files. |
| P2-PERF-001 | Production build emits an 874.98 kB minified chunk, above Vite's 500 kB warning threshold. | `npm run build`; `dist/assets/index-*.js` build report. |
| P2-TEST-001 | Passing tests write environment errors to stderr because `quotaManager` touches `localStorage` at module initialization in Node. This hides real signal and proves incomplete test isolation. | `npm test`: repeated `ReferenceError: localStorage is not defined` from `src/utils/quotaManager.ts:78,117` in otherwise passing suites. |
| P2-DEP-001 | **RESOLVED INCIDENTALLY BY WP-FIN-01.** Upgrading the PDF runtime removed the obsolete optional `canvas`/`@mapbox/node-pre-gyp`/`tar` lock paths; full and runtime npm audits now report zero vulnerabilities. | Gate 3 verification record; `npm audit --json`; `npm audit --omit=dev --json`. |
| P2-SAFE-001 | Translation content-safety probing explicitly fails open on provider error or quota exhaustion, returning `isSafe: true` for unknown outcomes. This is an undocumented product-policy choice and weakens isolation/routing diagnostics. | `src/services/workflows/translate/contentSafety.ts:85-95`. |
| P2-LOG-001 | **CREDENTIAL SUB-SCOPE IMPLEMENTED.** Global persisted logs and Story Engine diagnostics share provider-credential redaction. This does not override WP-FIN-02's authorization blocker; broader non-credential content/log policy remains scheduled. | `src/utils/secretRedaction.ts`; `src/utils/logStore.ts`; `src/services/storyEngine/diagnostics.ts`; WP-FIN-02 tests. |
| P2-DOC-001 | README remains an AI Studio starter stub and does not document the frozen product, editions, security model, supported workflows, backup compatibility, release checks, or deployment/runbook. Dual npm/bun lockfiles also leave package-manager authority undefined. | `README.md`; `package-lock.json`; `bun.lock`. |
| P2-LEGACY-001 | Previously accepted debt remains open: retire generic Story Engine runner adapters and add a repository-managed full production fixture when that artifact becomes tracked. | Predecessor `PROJECT_CONTROL.md` P2 register at `ccb52a4`. |

### Required Work Packages — execution order

1. **WP-FIN-01 — PDF Security and Runtime Containment (P0/P1).** Upgrade PDF.js to a non-vulnerable supported version; self-host/version-lock worker/CMap/font assets or otherwise align CSP; disable unsafe evaluation defensively; add malicious-PDF, ordinary-PDF, large-PDF, and production-CSP browser tests.
2. **WP-FIN-02 — Credential and Provider Boundary (P0/P1/P2).** Remove shared Gemini secrets from browser bundles; choose a server-side proxy or explicit BYOK contract for all editions; define ephemeral/encrypted-at-rest behavior; remove credentials from session snapshots; apply common log redaction; add build-secret scanning and provider health acceptance.
3. **WP-FIN-03 — Access and Edition Enforcement (P1).** Decide whether entitlement is real enforcement or presentation only. If enforced, move trust to a server/signed entitlement boundary; make Full/Lite/expiry behavior testable and remove dead client-only password configuration.
4. **WP-FIN-04 — Transactional Restore and Compatibility (P1).** Version and validate backup/support schemas before mutation; enforce size/depth budgets; stage/migrate/verify then atomically replace; preserve a rollback snapshot; add malformed, legacy, partial, oversized, and round-trip recovery tests.
5. **WP-FIN-05 — Test Gate Reconstruction (P1/P2).** Move/convert the 28 manual Story Engine tests into discovered async Vitest tests; make Node tests environment-clean; add React component tests and production-preview Playwright journeys for startup/access, every import family, translate/edit/repair, Story Engine, persistence/restore, and exports; publish coverage thresholds.
6. **WP-FIN-06 — Input Resource Governance (P1).** Define file/count/page/compressed/expanded/JSON budgets, streaming or bounded parsing, cancellation, progress, and graceful recovery across all import surfaces; include archive-bomb and memory-pressure tests.
7. **WP-FIN-07 — Quality, Dependency, and Performance Closure (P2).** Close lint errors/warnings, optional vulnerable lock paths, large chunk, favicon/runtime console noise, global log redaction, and content-safety unknown semantics.
8. **WP-FIN-08 — Release Documentation and Legacy Retirement (P2).** Replace starter README with product/deployment/recovery/security runbook; select the authoritative package manager/lockfile; retire compatibility adapters; add sanitized production fixture and release checklist.

No work package above is implemented by Gate 2. Every package requires its own authorization, branch, verification, and acceptance decision.

## Preserved Story Engine Non-Negotiable Invariants

- Semantic QA fails closed when approved QUALITY candidates are unavailable or exhausted.
- No QUALITY role silently falls back to FAST.
- AutoRepair is capped at two attempts.
- Hidden author truths never enter Writer View, repair requests, diagnostics, or persisted logs before their gates.
- Batch save is atomic; rejected chapters and derived state are not persisted.
- Writer output contains the exact requested chapter set and valid chapter envelopes.
- Cross-arc chapter planning and Writer View projection remain isolated.
- Production code contains no novel-specific hard-code.
- Canonical and explicitly allowlisted foreign terms remain legal only when chapter-safe.
- Full registry/Bible identities are Validator-only; Writer and AutoRepair receive only legal projected terms.
- `chapterWordTarget.soft=true` softens only the minimum; ideal remains the target and maximum remains hard.
- `neverPadWithFiller=true` remains explicit in Writer and AutoRepair instructions.

## Verification Baseline

| Check | Result |
| --- | --- |
| Default Vitest suite | PASS — 18 files, 342 tests; stderr pollution remains P2 |
| Excluded manual Story Engine harness | NOT RUN — blocked by Vitest include; P1-QA-001 |
| TypeScript | PASS — `npx tsc --noEmit` |
| Production build | PASS with warning — 874.98 kB chunk |
| ESLint | FAIL — 10 errors, 27 warnings |
| Dependency audit | FAIL — direct high-severity PDF.js advisory plus optional lockfile findings |
| Production browser startup/navigation | PASS with storage-persistence warning and missing favicon 404 |
| TXT import smoke | PASS — one test document entered workspace |
| PDF import smoke | FAIL — worker blocked by CSP |
| Live Gemini/DeepSeek calls | NOT VERIFIED — no test credentials; Full build credential contract is P0-SEC-002 |

## Acceptance Status and Next Milestone

Recommendation: **BLOCKED**.

Gate 1 and Gate 2 are complete as governance milestones. Product release, push, merge, and pull request remain unauthorized. The next milestone is CEO authorization of the ordered remediation program, beginning with WP-FIN-01 and WP-FIN-02. Re-run whole-app final acceptance only after all P0/P1 packages close and P2 release criteria are explicitly dispositioned.
