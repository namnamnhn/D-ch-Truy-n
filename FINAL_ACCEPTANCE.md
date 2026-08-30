# Final Acceptance

> Historical record: the access-code/session implementation described below was retired in the private AI Studio deployment redesign. Current deployment guidance is [README.md](README.md) and [docs/provider-routing.md](docs/provider-routing.md): there are no `/api/auth/*` routes, `APP_ACCESS_CODE_HASH`, or `SESSION_SIGNING_SECRET` requirements. A future public deployment requires real authentication and abuse controls.

> Current multi-profile release status (2026-08-30): local code, regression, build, credential-boundary, PDF, and production-server gates pass. Real AI Studio deployment/profile/stream/Story Chapters 1–2 acceptance is still pending and is not claimed by the historical evidence below.

## Candidate

Whole Application Finalization Program — Gate 1 Product Definition Freeze and Gate 2 Whole-App Technical Audit.

Baseline: accepted `main` commit `ccb52a4`; audit branch `codex/finalization-gates-1-2`; audit date 2026-08-29.

## Gate Outcomes

| Gate | Outcome | Decision basis |
| --- | --- | --- |
| Gate 1 — Product Definition Freeze | PASS | Whole-app product boundary, supported journeys, safety contract, Story Engine invariants, and release-quality definition are frozen below. |
| Gate 2 — Whole-App Technical Audit | COMPLETE | Repository-wide static, automated, dependency, build, and real-browser audit completed; findings and ordered work packages are recorded. |
| Product release acceptance | BLOCKED | WP-FIN-01, WP-FIN-02, and WP-FIN-03 pass. P1-DATA-001, P1-QA-001, P1-RES-001, and later packages remain open. |

## Gate 3 P0 Closure Evidence (CEO Rework Recorded)

### WP-FIN-01 — PASS

- **P0-SEC-001: PASS.** PDF.js moved from 4.0.379 to current 6.2.108. `npm audit --json` and `npm audit --omit=dev --json` now report zero vulnerabilities, including no active PDF.js advisory.
- **P1-FUN-001: PASS.** The Vite production build ships a hashed same-origin worker and local CMap/ICC/standard-font/WASM directories. CSP remains restrictive (`worker-src 'self' blob:`, no `unsafe-eval`, no PDF CDN origin).
- PDF document initialization uses `stopAtErrors: true`, `enableXfa: false`, `enableScripting: false`, and the explicit compatibility defense `isEvalSupported: false`; the loading task is destroyed in a `finally` boundary.
- Six focused Vitest regressions pass, including an explicit scripting-disabled assertion. The PDF production artifact check confirms scripting is disabled, assets/workers are local, and CSP remains restrictive.

### WP-FIN-02 — PASS

- **P0-SEC-002: PASS.** Vite no longer substitutes `GEMINI_API_KEY`, and the browser no longer imports or instantiates `GoogleGenAI`. The real production Node entry and Vite development middleware require the same signed server session before `/api/provider` can execute owner credentials.
- **P1-CRED-001: PASS.** DeepSeek supports an owner-side `DEEPSEEK_API_KEY`, with session-only BYOK as a fallback. BYOK is never written to localStorage, IndexedDB sessions, automatic snapshots, or downloaded backups; legacy copies are migrated out while manuscript fields are preserved.
- **P2-LOG-001 credential scope: PASS.** Provider keys, bearer headers/tokens, and obvious secret forms are redacted before persisted global logs/diagnostics and from gateway errors, using one narrow common layer.
- Thirteen provider-engine/security regressions and three production-server regressions pass. The built-output smoke proves unauthenticated and post-logout callers cannot consume owner credentials while an authenticated session reaches the existing provider implementation. The sentinel browser-bundle scan passes across 20 artifacts.

### WP-FIN-03 — PASS

- **P1-AUTH-001: PASS.** Stateless `/api/auth/login`, `/api/auth/status`, and `/api/auth/logout` endpoints enforce an HMAC-signed HttpOnly session. Tampered/expired cookies, wrong codes, missing server secrets, and expired entitlements fail closed.
- `APP_ACCESS_CODE_HASH` and `SESSION_SIGNING_SECRET` are server-only. The legacy client `PASSWORD_HASH` is removed. Login has bounded in-memory brute-force protection; no database, cloud account, third-party auth package, browser token, or reversible client encryption was added.
- Full expiry and Lite day 1–3 behavior come from one shared public declaration, but the server is authoritative at login/status/provider boundaries. Client flags remain presentation/feature controls only.
- IntroPage checks server status, renders a real password input when required, logs in through the server, handles safe differentiated errors, and enters only after authenticated status. Session polling, provider-401 handling, and logout return the UI to access control.
- Sixteen focused auth/dev-parity regressions, including the eight-hour maximum session TTL contract, and the built production auth smoke pass.
- A production-browser check confirmed the password prompt, safe wrong-code feedback, authenticated entry, `HttpOnly`/`SameSite=Strict` cookie behavior, absence of auth material from localStorage, and logout cookie removal. Production `Secure` is covered separately by the server regression because the local browser check used HTTP.

WP-FIN-04 through WP-FIN-08 remain open, so whole-product release acceptance remains **BLOCKED**.

## Frozen Product Acceptance Definition

The accepted product is a single-user, browser-first Vietnamese workspace for long-form fiction translation, editing, repair, publishing, and original-story generation.

### Accepted user journeys

1. Start the correct Full/Lite edition and satisfy its declared entitlement/expiry rules.
2. Import TXT, SRT, VTT, ZIP, EPUB, DOC/DOCX, PDF, paste content, Story Engine setup, backup JSON, and support-info JSON without code execution, data corruption, or uncontrolled resource use.
3. Configure story metadata, languages, dictionary, context, prompts, model tier/provider, batch and ratio controls.
4. Translate through Gemini/Gemma or optional DeepSeek with bounded retries, honest quota/provider diagnostics, safety isolation, validation, repair, and recoverable cancellation.
5. Inspect and manually edit results without losing original or accepted work.
6. Use Knowledge, Prompt Fix, Sino-Vietnamese, automation, and rescue workflows with consistent state and model policy.
7. Create long-form fiction through Story Engine V3 while preserving every accepted hidden-truth, projection, pacing, validation, repair, routing, continuity, and atomic-save invariant.
8. Persist work locally, recover after reload/crash, export/download backups, restore compatible data transactionally, and retain a rollback path.
9. Export completed work as the supported TXT/ZIP/DOCX/EPUB artifacts with stable chapter ordering, content, metadata, and formatting.

### Mandatory release properties

- No provider-owned/shared API secret is embedded in or recoverable from a distributed browser bundle.
- User credentials and manuscript data have an explicit storage/privacy contract and are excluded from unsafe logs and snapshots.
- Untrusted files cannot execute application-origin code and are parsed under enforceable resource budgets.
- Supported production workflows work under the shipped CSP and build artifact, not only in source/unit tests.
- Destructive imports/restores validate and stage before replacing current durable state.
- All blocking/quality decisions are fail-closed where the frozen contract says they are authoritative.
- Tests include all repository test assets, await async work, cover UI/browser boundaries, and run without hidden environment errors.
- TypeScript, lint, tests, dependency policy, build, and representative browser journeys pass from the authoritative lockfile.
- Release/deployment/recovery documentation is complete enough for an operator who did not author the code.

### Explicit non-goals for this release

- Multi-user collaboration, cloud account sync, or server-side manuscript storage, unless introduced specifically to secure provider credentials/entitlements.
- A guarantee that an external model is always available or that every generated passage is subjectively publishable.
- Silent compatibility with unknown future backup schemas, models, or file formats.

## Whole-App Acceptance Matrix

| Area | Acceptance condition | Current status | Evidence |
| --- | --- | --- | --- |
| Product definition | Whole-app scope and release properties are explicit and frozen | PASS | This document and `PROJECT_CONTROL.md` |
| Main baseline | Audit starts from accepted clean `main` | PASS | `ccb52a4`; branch created directly from `main` |
| Startup/navigation | Production preview loads and primary pages render | PASS WITH NOTES | Playwright smoke; storage persistence denied warning and favicon 404 |
| Access/edition | Runtime enforces declared access-code/edition contract | PASS | Signed HttpOnly server session; server-authoritative Full/Lite expiry; login/status/logout tests and production smoke |
| Gemini credential boundary | Full edition works without exposing a shared build secret and without an unauthenticated owner-key proxy | PASS | Server-only secret, authenticated production/dev gateway, sentinel bundle scan |
| DeepSeek credential boundary | User key is not copied into unsafe durable stores/snapshots | PASS | Server-secret preference, memory-only BYOK, recursive legacy migration and storage defenses |
| Model inventory | Configured Gemini/Gemma IDs match current provider catalog | PASS | Official Google model documentation checked 2026-08-29 |
| TXT import | Production build imports ordinary text | PASS | Playwright smoke imported one TXT file |
| PDF import security | Untrusted PDF parser has no known code-execution exposure | PASS | `pdfjs-dist@6.2.108`, eval/XFA/scripting disabled, audits clean |
| PDF import runtime | Shipped CSP permits the shipped PDF worker path | PASS | Same-origin worker/assets and successful production-preview import |
| ZIP/EPUB/DOCX/PDF/backup budgets | Every input boundary enforces size/count/depth/expansion limits | FAIL (P1) | Whole-file/unbounded parsing paths |
| Backup/restore | Versioned schema is validated and atomically committed with rollback | FAIL (P1) | Session cleared before nested restore validation |
| Translation core regressions | Default automated translation/text regressions pass | PASS | Included in the 380/380-test Gate 3 run |
| Live provider journeys | Real production credentials/models complete representative calls | NOT VERIFIED | No live audit credential; authenticated production provider mock passes |
| Story Engine accepted invariants | Previously accepted V3 invariants remain passing in discovered suite | PASS | CEO rework/continuity/Task suites pass in default Vitest run |
| Repository test discovery | Every test asset is discovered and async failures are awaited | FAIL (P1) | 28-test manual harness excluded; sync helper accepts async callbacks |
| UI/browser regression gate | Representative user journeys run automatically in a real browser | FAIL (P1) | No repository Playwright/Cypress/Testing Library suite |
| TypeScript | `tsc --noEmit` passes | PASS | Exit 0 |
| ESLint | Repository lint passes with zero errors | FAIL (P2) | 9 errors, 27 warnings; one baseline error removed, no new debt |
| Production build | Build completes within accepted performance budget | PARTIAL (P2) | Exit 0; explicit Node server artifact emitted; 881.87 kB chunk warning |
| Dependency security | No release-blocking runtime advisory; lock/install policy clean | PASS | Both full and runtime npm audits report zero vulnerabilities after WP-FIN-01 |
| Test runtime hygiene | Passing tests produce no hidden environment errors | FAIL (P2) | `localStorage is not defined` emitted to stderr |
| Logging/privacy | All persisted/exported logs redact credentials and sensitive content | PARTIAL (P2) | Provider credentials now share common global/Story redaction; broader non-credential log-content policy remains open |
| Documentation/reproducibility | Product, security, deployment, recovery, checks, and authoritative lockfile documented | FAIL (P2) | Starter README; npm and bun lockfiles both tracked |
| Gate 2 non-implementation rule | Findings are not fixed before register and work packages are complete | PASS | Gate branch changes only finalization control documents after temporary smoke artifacts are removed |
| Local-only handoff | Commit exists; no push, merge, or PR | PASS | Gate 3 rework code, tests, and control documents are committed locally on `codex/finalization-p0-closure`; no remote action is performed |

## Findings Summary

### P0

- **P0-SEC-001: CLOSED by WP-FIN-01.**
- **P0-SEC-002: CLOSED by WP-FIN-02/WP-FIN-03.**

### P1

- **P1-FUN-001: CLOSED by WP-FIN-01.**
- **P1-AUTH-001: CLOSED by WP-FIN-03.**
- **P1-DATA-001:** backup restore is unvalidated and non-transactional.
- **P1-QA-001:** repository tests are incompletely discovered and have no UI/browser gate.
- **P1-RES-001:** import/restore resource consumption is unbounded.
- **P1-CRED-001: CLOSED by WP-FIN-02.**

### P2

- Lint debt; large production chunk; test stderr pollution; fail-open translation safety probe; broader non-credential log-content policy; incomplete documentation/lockfile authority; legacy Story Engine adapters/fixture debt. The optional vulnerable lock paths were removed incidentally by WP-FIN-01.

Full evidence and impact are in `PROJECT_CONTROL.md`.

## Proposed Work Packages

| Order | Work package | Exit condition |
| --- | --- | --- |
| 1 | WP-FIN-01 — PDF Security and Runtime Containment | Safe PDF.js, CSP-aligned local assets, eval defense, malicious/normal/large PDF browser tests pass |
| 2 | WP-FIN-02 — Credential and Provider Boundary | No shared key in bundle; safe storage/logging; real production server; authenticated provider health passes after WP-FIN-03 supplies the server-side authority |
| 3 | WP-FIN-03 — Access and Edition Enforcement | Edition/expiry/entitlement behavior is explicit, enforceable where claimed, and browser-tested |
| 4 | WP-FIN-04 — Transactional Restore and Compatibility | Version/schema/budget validation, staging, atomic replace, rollback, legacy and malformed tests pass |
| 5 | WP-FIN-05 — Test Gate Reconstruction | All tests discovered/awaited; clean stderr; UI/E2E suite and coverage thresholds enforced |
| 6 | WP-FIN-06 — Input Resource Governance | All supported import surfaces have budgets, cancellation, graceful failure, and adversarial tests |
| 7 | WP-FIN-07 — Quality, Dependency, and Performance Closure | Lint/dependency policy/build budget/console/log/safety-policy debt closed or CEO-dispositioned |
| 8 | WP-FIN-08 — Release Documentation and Legacy Retirement | Operator docs, package-manager authority, release checklist, legacy adapters and fixture debt closed |

Work packages are intentionally ordered by exploitability and trust boundary before reliability, quality, and documentation.

## Verification Record

Gate 3 CEO-rework verification:

| Command/check | Result |
| --- | --- |
| `npm test -- --reporter=verbose` | PASS — 22 files, 380/380 tests |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS — React output plus explicit Node production bundle; existing large-chunk warning; largest application chunk 881.87 kB |
| `npm run lint` | Known debt improved — 9 errors, 27 warnings (baseline 10/27) |
| `npm audit --json` / `npm audit --omit=dev --json` | PASS — 0 vulnerabilities in each |
| `npm run test:pdf-build` | PASS — PDF scripting disabled; local worker/assets and restrictive CSP verified |
| `npm run test:credential-build` | PASS — 20 artifacts; zero provider/auth sentinel leaks; no legacy client `PASSWORD_HASH` |
| `npm run test:production-server` | PASS — built Node login/status/provider/logout/post-logout-denial chain; no Vite preview or credential disclosure |
| Production browser access/logout check | PASS — password prompt, wrong-code handling, cookie-backed entry, no auth localStorage, logout/cookie removal |

Gate 2 historical baseline:

| Command/check | Result |
| --- | --- |
| `npm test -- --reporter=verbose` | PASS — 18 files, 342 tests |
| Direct `vitest` of `src/services/storyEngine/storyEngineV3.test.ts` | FAIL TO DISCOVER — excluded by config |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS with 874.98 kB chunk warning |
| `npm run lint` | FAIL — 10 errors, 27 warnings |
| `npm audit --json` / `npm audit --omit=dev --json` | FAIL — 1 critical, 2 high records; direct PDF.js high advisory is runtime-relevant |
| Production Preview + Playwright startup/navigation | PASS WITH NOTES |
| Production Preview + Playwright TXT import | PASS |
| Production Preview + Playwright PDF import | FAIL — CSP blocks worker |
| Live Gemini/DeepSeek calls | NOT RUN — no credentials; not safe to accept current architecture |

## Preserved Story Engine Invariant Audit

- [x] Fail-closed semantic QA.
- [x] No QUALITY-to-FAST silent fallback.
- [x] Maximum two AutoRepair passes.
- [x] Hidden-truth and chapter-scoped language protection.
- [x] Validator/Writer/AutoRepair context separation.
- [x] Atomic accepted batch/state integration.
- [x] Exact chapter contract and cross-arc isolation.
- [x] Pacing soft-minimum/hard-maximum/never-pad contract.
- [x] No novel-specific production hard-code detected.

These accepted subsystem results do not override whole-app P0/P1 findings.

## Release Decision

**BLOCKED.**

Gate 1 and Gate 2 are complete, and WP-FIN-01/WP-FIN-02/WP-FIN-03 are **PASS**. The product is not ready for final acceptance or release: P1-DATA-001, P1-QA-001, and P1-RES-001 remain open. After all remaining P1 items close, rerun the entire acceptance matrix, including real AI Studio provider health, all supported import/export families, persistence/restore recovery, and production-browser E2E.

No push, merge, or pull request is authorized or performed by this program.
