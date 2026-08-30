<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/a3e31270-53c0-42bb-8f66-662c14a7e013

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `GEMINI_API_KEY` in the server environment (Google AI Studio: **Settings → Secrets**). Optional owner-managed DeepSeek uses `DEEPSEEK_API_KEY` there as well. Never expose either value through a Vite `VITE_*` variable.
3. Run the app:
   `npm run dev`

Gemini and DeepSeek browser calls use the same-origin `/api/provider` Node gateway. DeepSeek BYOK, when used, exists only in the active browser session/request and is not included in localStorage, IndexedDB, or backups.

## Private AI Studio deployment

Owner Gemini credentials are enabled only when `APP_DEPLOYMENT_MODE=private-aistudio`. An unset or public deployment fails closed and must not contain owner credentials. This private mode relies on the AI Studio private-sharing boundary plus same-origin POST checks; a future public deployment requires real user authentication, authorization, abuse controls, and rate limits before credentials can be used.

Add legitimate, owned-project Gemini profiles in **Settings → Secrets** as `GEMINI_PROFILE_1_API_KEY`, `GEMINI_PROFILE_2_API_KEY`, and so on. Optional `GEMINI_PROFILE_<N>_LABEL`, `_QUOTA_GROUP`, and `_DISABLED` metadata control the safe profile display and routing. Keys never enter browser DTOs, storage, manuscript exports, backups, or logs. Profiles represent legitimately owned projects; they are not a mechanism to bypass Google limits. Profiles sharing a quota group share model quota health.

The Profiles UI may persist only safe browser metadata (friendly label, profile enabled state, and disabled model IDs) so it survives a server cold start. Credential-looking labels are rejected. API keys can be created, changed, or removed only in the Google-owned AI Studio Secrets UI.

The central Gemini registry was reviewed on 2026-08-30 and currently permits the official application IDs in `shared/geminiModelRegistry.ts`. Story compiler, writer, semantic validation, and repair enforce a no-Lite quality floor and fail closed if no qualifying candidate is available. Faster roles have their own policy; translation continues to use its own policy through the same server gateway.
