import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAiStudioPreviewServer,
  type AiStudioPreviewServer,
} from '../server/aiStudioPreviewServer';
import type { AuthStatusResponse } from '../shared/authContract';
import type { ProviderErrorPayload } from '../shared/providerContract';

const ACCESS_CODE = 'ai-studio-preview-test-code';
const PREVIEW_ENV = {
  NODE_ENV: 'test',
  APP_ACCESS_CODE_HASH: createHash('sha256').update(ACCESS_CODE).digest('hex'),
  SESSION_SIGNING_SECRET: 'ai-studio-preview-signing-secret-32-bytes',
};
const GEMINI_PAYLOAD = {
  provider: 'gemini',
  action: 'generate',
  request: { model: 'gemini-3.5-flash', contents: 'Hello' },
};

describe('Google AI Studio Preview server adapter', () => {
  let preview: AiStudioPreviewServer | undefined;

  afterEach(async () => {
    if (preview?.httpServer.listening) {
      preview.httpServer.close();
      await once(preview.httpServer, 'close');
    }
    await preview?.viteServer.close();
    preview = undefined;
  });

  it('keeps an unconfigured auth status observable as JSON during Preview startup', async () => {
    preview = await createAiStudioPreviewServer({
      env: { NODE_ENV: 'test', APP_ACCESS_CODE_HASH: '', SESSION_SIGNING_SECRET: '' },
    });
    preview.httpServer.listen(0, '127.0.0.1');
    await once(preview.httpServer, 'listening');
    const address = preview.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/status`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json() as AuthStatusResponse).toMatchObject({
      authenticated: false,
      status: 'AUTH_NOT_CONFIGURED',
    });
  });

  it('serves all same-origin Gate 3 endpoints ahead of the Vite SPA fallback', async () => {
    preview = await createAiStudioPreviewServer({ env: PREVIEW_ENV });
    preview.httpServer.listen(0, '127.0.0.1');
    await once(preview.httpServer, 'listening');
    const address = preview.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
    const origin = `http://127.0.0.1:${address.port}`;

    const initialStatus = await fetch(`${origin}/api/auth/status`);
    expect(initialStatus.headers.get('content-type')).toContain('application/json');
    expect(await initialStatus.json() as AuthStatusResponse).toMatchObject({
      authenticated: false,
      status: 'AUTH_REQUIRED',
    });

    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    expect(await login.json() as AuthStatusResponse).toMatchObject({
      authenticated: true,
      status: 'AUTHENTICATED',
    });
    expect(cookie).toContain('app_session=');

    const authenticatedStatus = await fetch(`${origin}/api/auth/status`, {
      headers: { Cookie: cookie },
    });
    expect(await authenticatedStatus.json() as AuthStatusResponse).toMatchObject({
      authenticated: true,
      status: 'AUTHENTICATED',
    });

    const provider = await fetch(`${origin}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(provider.headers.get('content-type')).toContain('application/json');
    expect(provider.status).toBe(503);
    expect((await provider.json() as ProviderErrorPayload).error.code).toBe('SERVER_CONFIGURATION_MISSING');

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    });
    expect(await logout.json() as AuthStatusResponse).toMatchObject({
      authenticated: false,
      status: 'AUTH_REQUIRED',
    });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const rejectedAfterLogout = await fetch(`${origin}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(rejectedAfterLogout.status).toBe(401);
    expect((await rejectedAfterLogout.json() as ProviderErrorPayload).error.code).toBe('UNAUTHORIZED');
  });
});
