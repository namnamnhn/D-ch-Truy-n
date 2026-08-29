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
