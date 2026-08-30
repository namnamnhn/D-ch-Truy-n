# Project Control

> Historical notes below predate the private AI Studio redesign. Current deployments use `APP_DEPLOYMENT_MODE=private-aistudio`, have no access-code/session routes, and fail closed outside private mode. See `README.md` and `docs/provider-routing.md`.

## Current Chairman Directive and Priority

- Chairman: Nguyễn Hoàng Nam.
- Current operating directive: full CEO handover dated 2026-08-30 (Asia/Saigon).
- Immediate product priority: Story Creation, beginning with real Google AI Studio production of *THIÊN HẠ GIAN ĐẠO* under the frozen Story Engine V3 contract.
- Historical WP-FIN packages remain evidence but are not an instruction to resume broad finalization work.
- Current milestone order: direct app entry; private-AI-Studio provider boundary; server-side Gemini profile Secrets; provider/failover verification; canonical V3 setup import and pacing verification; official Chapters 1–2 with QA/state/memory/atomic-save PASS.

## Multi-Gemini implementation checkpoint — 2026-08-30

- Implementation and regression acceptance are complete on `main` (`393145f`, plus AI Studio runtime follow-up `40c9d7d`): direct entry, numbered server-only Gemini profiles, project/quota grouping, per-profile/model health, bounded Retry-After handling, role-aware Story routing, quality floor, streaming cancellation, and atomic Story canon safeguards. Current gates pass with 26 Vitest files / 389 tests, TypeScript, production build, credential scan, and production-server smoke.
- Browser persistence is restricted to safe profile metadata (label, enabled state, disabled model IDs). Credential-looking labels are rejected, and Gemini credential material is absent from browser bundles, storage paths, exports, backups, and normalized logs.
- New-build real AI Studio acceptance is partially complete: GitHub `main` is synchronized, the app opens without the custom access-code screen, `APP_DEPLOYMENT_MODE=private-aistudio` is configured, two server-only Gemini profiles are recognized by masked fingerprints, and a real `gemini-3.5-flash` health call passed in 1113 ms. A `gemini-3.1-pro-preview` test on the newly added profile returned a normalized temporary rate-limit message rather than false daily depletion. Multi-profile execution-target failover, streaming, and official Story Chapters 1-2 remain pending. The older live-runtime evidence below is historical and must not be treated as acceptance of the new build.

## Google AI Studio Runtime Acceptance — PASS

Live app: `https://ai.studio/apps/a3e31270-53c0-42bb-8f66-662c14a7e013`

Verified in the real signed-in AI Studio environment on 2026-08-30:

- Preview executes `npm run dev` as `tsx server.ts --port 3000 --host 0.0.0.0`; it does not use `npm start` for the editable Preview runtime.
- The server binds `0.0.0.0:3000`, logs `AI_STUDIO_PREVIEW_SERVER listening`, and Preview reports Backend CONNECTED.
- `/api/auth/status` reaches the app router and returns HTTP 200 app JSON with `application/json; charset=utf-8`; runtime logs record `AI_STUDIO_AUTH_STATUS_REACHED`.
- The former infrastructure HTML was a cold-start race: the first browser request could arrive while AI Studio still displayed `Starting Server...`. Status checks now accept only valid app JSON, retry transient cold starts with bounded backoff, and keep the intro screen self-healing without replaying login requests.
- After a real AI Studio backend stop/restart and GitHub sync, the UI recovered to the correct `AUTH_NOT_CONFIGURED` message without weakening authentication.
- `GEMINI_API_KEY`, a freshly generated `SESSION_SIGNING_SECRET`, and the Chairman-supplied access-code SHA-256 hash are configured server-side in AI Studio Secrets. The plaintext access code is not stored in the repository or browser persistence.
- AI Studio's reverse proxy changes the public Origin/Host relationship for same-origin POSTs. Browser-controlled Fetch Metadata now permits explicit `same-origin` traffic while `cross-site` remains fail-closed.
- The primary session cookie remains `HttpOnly; SameSite=Strict`. The embedded Preview additionally receives a distinct `__Host-` cookie with `Secure; HttpOnly; SameSite=None; Partitioned`, so it is confined to the AI Studio top-level partition. Login survived the 30-second status poll, and logout cleared both cookies in the real Preview.
- Real `/api/provider` Gemini health passed with `gemini-3.5-flash` in 1,923 ms through the server-side owner key. DeepSeek remains unconfigured and is not on the current Story Engine production route.
- The Story Creation screen is authenticated and currently empty at zero chapters. The canonical `ThienHaGianDao_FINAL_ONE_FILE_V3.txt` is not present in the repository or accessible local workspace, so production import is waiting for that exact file rather than reconstructing or substituting story canon.

Commit evidence: `205054e` (runtime contract), `b21d3b1` (live route trace), `45a96ce` (cold-start recovery), `72954d0` (reverse-proxy same-origin acceptance), and `ec42281` (partitioned Preview session). Current regression evidence is 24 test files / 387 tests PASS, TypeScript PASS, changed-file ESLint PASS, production build PASS, production-server smoke PASS, credential artifact scan PASS, and PDF build verification PASS. Repository-wide ESLint retains the pre-existing nine-error baseline outside these changes.

## Historical Directive Source and Baseline

- Authoritative directive: `PROJECT_CONTROL.md` and `FINAL_ACCEPTANCE.md` on `main`.
- Accepted predecessor package: CEO rework/finalization package at `ccb52a4`.
- Gate 1/2 audit branch: `codex/finalization-gates-1-2`, created directly from clean `main`; current Gate 3 branch is recorded below.
- Audit date: 2026-08-29 (Asia/Saigon).
- Scope constraint: Gate 2 is audit and work-package definition only. No finding is remediated in this gate.

## Product North Star

Deliver a production-safe, browser-first Vietnamese AI workspace for long-form fiction translation, editing, repair, publishing, and original story generation. The product must preserve manuscripts and project state, protect credentials and hidden author truth, handle supported document formats safely, route AI work according to declared quality tiers, and produce recoverable, deterministic outputs under network, model, browser-storage, and malformed-input failure.

Story Engine V3 remains a release-critical subsystem, but final product acceptance applies to the whole application: access/edition behavior, UI workflows, import and export, translation and analysis pipelines, Gemini and DeepSeek integrations, local persistence and backup/restore, logs and diagnostics, text utilities, and build/deployment controls.

## Release Stage

FINALIZATION PROGRAM — Gate 1 and Gate 2 complete. WP-FIN-01, WP-FIN-02, and WP-FIN-03 are **PASS**. Release remains **BLOCKED** by three open P1 findings and later work packages. The predecessor Story Engine package remains accepted; this decision concerns whole-app production acceptance.

## Gate 3 — P0 Credential/PDF Closure and Access Enforcement

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

Status: **PASS**.

| Finding | Verdict | Evidence |
| --- | --- | --- |
| P0-SEC-002 | PASS | Browser secret substitution/client SDK construction remain removed. The production Node and Vite development routes validate the same signed server session before reading the request body or executing owner credentials. Authenticated production-smoke traffic reached the existing provider implementation; unauthenticated and post-logout traffic was rejected first. |
| P1-CRED-001 | PASS | DeepSeek owner secret remains server-side; optional BYOK remains memory/request-only. Legacy localStorage/session/auto-backup/downloaded-backup credential fields are purged or recursively sanitized without changing manuscript fields. |
| P2-LOG-001 (credential scope) | PASS | One narrow credential redactor now protects global persisted logs, crash/unhandled-rejection paths, Story Engine diagnostics, and provider error normalization. Broader non-credential P2 log/content policy remains for WP-FIN-07. |

Architecture evidence: AI Studio's production build bundles `server/productionEntry.ts` with esbuild to the conventional `dist/server.cjs`; `npm start` executes that artifact directly, binds `process.env.PORT` (safe default 8080), emits `AI_STUDIO_RUNTIME_READY`, serves the React build with SPA fallback, and routes the same-origin auth and provider APIs ahead of static files. Production and Vite development instantiate the same `AuthSessionAuthority`; the provider adapter calls it on every request. There is no Origin/Referer/browser-secret/static-token authorization substitute.

Automated evidence: thirteen provider-engine/security regressions and three production-server regressions remain passing. Sixteen WP-FIN-03 regressions cover login, missing configuration, rate limiting, the eight-hour maximum session TTL, forged/expired sessions, logout, provider gating, entitlement expiry, Full/Lite parity, and Vite development parity. `npm run test:production-server` performs login/status/authenticated-provider/logout/post-logout denial against built Node output. `npm run test:credential-build` scans 20 browser artifacts with zero provider/auth sentinel leaks and no legacy `PASSWORD_HASH` authority.

#### Real Google AI Studio acceptance checklist

- [x] Confirm editable Preview starts through `npm run dev`, logs `AI_STUDIO_PREVIEW_SERVER listening`, and `/api/auth/status` reaches the app router as HTTP 200 JSON rather than infrastructure HTML.
- [x] Make the browser recover automatically when AI Studio briefly returns `Starting Server...` during a cold start.
- [x] Configure the Chairman's `APP_ACCESS_CODE_HASH`, `SESSION_SIGNING_SECRET`, and `GEMINI_API_KEY` in **AI Studio Settings → Secrets** without persisting plaintext access credentials in the repository or browser.

- Confirm browser DevTools Sources cannot find the key and built browser artifacts contain no key.
- Confirm provider Network request/response bodies never contain the server key.
- [x] Complete one ordinary Gemini request through the authenticated `/api/provider` route.
- [ ] Complete one streaming Gemini request.
- Complete one Story Engine call while preserving the selected role/model route.
- Remove the secret temporarily and confirm the health/config UI shows the explicit server-configuration error.
- Exercise a quota-limited mock/account state and confirm the browser still receives rate-limit semantics.

### WP-FIN-03 — Access and Edition Enforcement

Status: **PASS**.

`/api/auth/login`, `/api/auth/status`, and `/api/auth/logout` use a narrow stateless authority. A successful access-code check issues an HMAC-SHA256 signed `HttpOnly; SameSite=Strict; Path=/` cookie with explicit issued-at, expiry, and edition claims; production cookies are `Secure`. Tampered, expired, wrong-edition, missing-secret, and entitlement-expired sessions fail closed. Login attempts are bounded per network peer in a fixed window without introducing a database or third-party auth service.

The server requires `APP_ACCESS_CODE_HASH` (64-character SHA-256 hex) and a distinct `SESSION_SIGNING_SECRET` (minimum 32 bytes). Neither is returned, logged, persisted, or compiled into the browser. The old client `PASSWORD_HASH` is removed. The public Full/Lite declaration is shared between server and client only to prevent packaging drift; the server re-evaluates Full expiry or Lite day 1–3 policy at login, status, and every provider request.

The application checks server status before entry, presents the access-code input when required, distinguishes safe wrong-code/expired/configuration/network messages, polls server session state, reacts immediately to provider 401, and exposes server logout. React state and client-visible edition flags are presentation state only.

A real-browser production check confirmed the required password field, safe wrong-code feedback, authenticated entry, an `HttpOnly`/`SameSite=Strict` session cookie, no auth secret or access code in localStorage, and logout cookie removal. The local HTTP check intentionally ran outside production mode; the unit regression separately asserts the production `Secure` cookie flag.

WP-FIN-04 through WP-FIN-08 remain open. Whole-product release remains blocked.

### Gate 3 CEO-rework verification record

| Check | Result |
| --- | --- |
| Full Vitest | PASS — 22 files, 380/380 tests |
| TypeScript | PASS — `npx tsc --noEmit` |
| Production build | PASS — React build plus `dist/server.cjs`; 881.87 kB largest application chunk; existing >500 kB P2 warning remains |
| ESLint | Known debt improved — 9 errors, 27 warnings (baseline 10/27; no new debt) |
| Full npm audit | PASS — 0 vulnerabilities (baseline: 1 critical, 2 high) |
| Runtime npm audit | PASS — 0 vulnerabilities (baseline: 1 critical, 2 high) |
| PDF production artifact check | PASS — scripting disabled, local worker/assets, restrictive CSP |
| Credential/auth production artifact check | PASS — 20 artifacts; no provider/auth sentinels or legacy client password authority |
| Production Node auth smoke | PASS — login, status, authenticated provider mock, logout, and post-logout provider denial on built Node output |
| Production browser access/logout check | PASS — access prompt, wrong-code handling, signed-cookie entry, no auth localStorage, logout/cookie removal |

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
| P0-SEC-002 | **RESOLVED — WP-FIN-02 PASS.** Browser credential exposure is removed; production/dev provider execution requires the signed server session supplied by WP-FIN-03. | Gate 3 WP-FIN-02 evidence above. |

#### P1 — must close before final acceptance

| ID | Finding and impact | Evidence |
| --- | --- | --- |
| P1-FUN-001 | **RESOLVED — WP-FIN-01 PASS.** Production PDF import uses a hashed same-origin worker and local assets under the existing restrictive CSP. | Gate 3 WP-FIN-01 evidence above. |
| P1-AUTH-001 | **RESOLVED — WP-FIN-03 PASS.** Access code, session expiry, Full/Lite entitlement, and provider authorization are enforced server-side through signed HttpOnly sessions. | `server/authSession.ts`; `shared/editionContract.ts`; auth regressions and built production auth smoke. |
| P1-DATA-001 | Full backup restore is not schema-validated or transactional. It clears the persisted current session after only checking that `files` is an array, then dereferences and applies untrusted nested fields. A malformed/incompatible backup can remove the last persisted session before restore fails or can inject invalid runtime state. | `src/hooks/fileHandler/fileBackupRestore.ts:30-51`; no backup version/schema validation or pre-commit rollback is present. |
| P1-QA-001 | “Full tests” is not the full repository suite and has no browser/UI gate. Vitest is Node-only and includes only `tests/**/*.test.ts`; `src/services/storyEngine/storyEngineV3.test.ts` contains a separate 28-test manual harness that is not discovered, and its synchronous helper does not await async callbacks such as Test 17. | `vitest.config.ts:4-9`; `src/services/storyEngine/storyEngineV3.test.ts:20-30,350-351`; direct Vitest invocation reports “No test files found”; no Testing Library/Playwright/Cypress test suite exists. |
| P1-RES-001 | User-controlled imports and restores have no file-count, compressed-size, expanded-size, page-count, or JSON-depth/size budgets. ZIP/DOCX/EPUB are expanded with `loadAsync` and PDF/backup files are read wholly into memory. Crafted or merely very large long-form inputs can freeze/crash the browser and jeopardize unsaved work. | `src/utils/file/parsers.ts:34-79,83-88,127-140,255-261`; `src/hooks/fileHandler/fileBackupRestore.ts:30`; no enforceable maximums were found. |
| P1-CRED-001 | **RESOLVED — WP-FIN-02 PASS.** DeepSeek owner secret stays server-side; BYOK is memory/request-only and legacy durable copies are sanitized. | Gate 3 WP-FIN-02 evidence above. |

#### P2 — scheduled hardening/debt

| ID | Finding and impact | Evidence |
| --- | --- | --- |
| P2-QUAL-001 | Repository lint baseline fails: 10 errors and 27 warnings, including React effect/ref/immutability findings. | `npm run lint`: 37 findings across `AutoBackupPanel`, `AutomationModal`, `EditorModal`, `Header`, `IntroPage`, `WorkspacePage`, loading/log modals, and other files. |
| P2-PERF-001 | Production build emits an 874.98 kB minified chunk, above Vite's 500 kB warning threshold. | `npm run build`; `dist/assets/index-*.js` build report. |
| P2-TEST-001 | Passing tests write environment errors to stderr because `quotaManager` touches `localStorage` at module initialization in Node. This hides real signal and proves incomplete test isolation. | `npm test`: repeated `ReferenceError: localStorage is not defined` from `src/utils/quotaManager.ts:78,117` in otherwise passing suites. |
| P2-DEP-001 | **RESOLVED INCIDENTALLY BY WP-FIN-01.** Upgrading the PDF runtime removed the obsolete optional `canvas`/`@mapbox/node-pre-gyp`/`tar` lock paths; full and runtime npm audits now report zero vulnerabilities. | Gate 3 verification record; `npm audit --json`; `npm audit --omit=dev --json`. |
| P2-SAFE-001 | Translation content-safety probing explicitly fails open on provider error or quota exhaustion, returning `isSafe: true` for unknown outcomes. This is an undocumented product-policy choice and weakens isolation/routing diagnostics. | `src/services/workflows/translate/contentSafety.ts:85-95`. |
| P2-LOG-001 | **CREDENTIAL SUB-SCOPE IMPLEMENTED.** Global persisted logs and Story Engine diagnostics share provider-credential redaction. Broader non-credential content/log policy remains scheduled. | `src/utils/secretRedaction.ts`; `src/utils/logStore.ts`; `src/services/storyEngine/diagnostics.ts`; WP-FIN-02 tests. |
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

Gate 1 and Gate 2 are complete as governance milestones, and WP-FIN-01 through WP-FIN-03 are complete on the Gate 3 branch. Product release, push, merge, and pull request remain unauthorized. WP-FIN-04 is the next ordered package but has not started and requires CEO authorization. Re-run whole-app final acceptance only after all P0/P1 packages close and P2 release criteria are explicitly dispositioned.
