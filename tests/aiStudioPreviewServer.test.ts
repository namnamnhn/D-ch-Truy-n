import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiStudioPreviewServer, type AiStudioPreviewServer } from '../server/aiStudioPreviewServer';
import { isSameOriginBrowserRequest } from '../server/geminiScheduler';

describe('Google AI Studio Preview server adapter', () => {
  let preview: AiStudioPreviewServer | undefined;
  afterEach(async () => { if (preview?.httpServer.listening) { preview.httpServer.close(); await once(preview.httpServer, 'close'); } await preview?.viteServer.close(); preview = undefined; });
  it('serves provider metadata and rejects public/cross-site provider calls', async () => {
    preview = await createAiStudioPreviewServer({ env: { NODE_ENV: 'test', APP_DEPLOYMENT_MODE: 'private-aistudio' } });
    preview.httpServer.listen(0, '127.0.0.1'); await once(preview.httpServer, 'listening');
    const address = preview.httpServer.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
    const origin = `http://127.0.0.1:${address.port}`;
    const profiles = await fetch(`${origin}/api/provider/profiles`);
    expect(profiles.status).toBe(200); expect(profiles.headers.get('x-application-server')).toBe('node-preview');
    const crossSite = await fetch(`${origin}/api/provider`, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'x' } }) });
    expect(crossSite.status).toBe(401);
  });

  it('accepts AI Studio proxy same-origin despite public Origin/internal Host mismatch and rejects cross-site', () => {
    expect(isSameOriginBrowserRequest({ headers: { host: 'internal:3000', origin: 'https://public-preview.example', 'sec-fetch-site': 'same-origin' } })).toBe(true);
    expect(isSameOriginBrowserRequest({ headers: { host: 'internal:3000', origin: 'https://public-preview.example', 'sec-fetch-site': 'cross-site' } })).toBe(false);
  });
});
