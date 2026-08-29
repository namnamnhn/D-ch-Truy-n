import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionServer } from '../server/productionServer';
import type { ProviderErrorPayload } from '../shared/providerContract';

const GEMINI_PAYLOAD = {
  provider: 'gemini',
  action: 'generate',
  request: { model: 'gemini-3.5-flash', contents: 'Hello' },
};
const ACCESS_CODE = 'production-server-test-code';
const AUTH_ENV = {
  NODE_ENV: 'test',
  APP_ACCESS_CODE_HASH: createHash('sha256').update(ACCESS_CODE).digest('hex'),
  SESSION_SIGNING_SECRET: 'production-server-test-signing-secret-32-bytes',
};

describe('WP-FIN-02 production Node server', () => {
  let buildDirectory: string;
  let server: Server | undefined;

  beforeEach(async () => {
    buildDirectory = await mkdtemp(path.join(tmpdir(), 'provider-production-server-'));
    await writeFile(
      path.join(buildDirectory, 'index.html'),
      '<!doctype html><html><body><div id="root">built-react-app</div></body></html>',
      'utf8',
    );
  });

  afterEach(async () => {
    if (server?.listening) {
      server.close();
      await once(server, 'close');
    }
    await rm(buildDirectory, { recursive: true, force: true });
  });

  const start = async (options: Parameters<typeof createProductionServer>[0] = {}) => {
    server = createProductionServer({ buildDirectory, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address.');
    return `http://127.0.0.1:${address.port}`;
  };

  it('serves the built React app and keeps provider execution fail-closed without server auth configuration', async () => {
    const geminiSecret = 'AIza-production-owner-sentinel-123456789012345';
    const deepSeekSecret = 'sk-production-owner-sentinel-1234567890';
    const baseUrl = await start({ env: { GEMINI_API_KEY: geminiSecret, DEEPSEEK_API_KEY: deepSeekSecret } });

    const appResponse = await fetch(`${baseUrl}/workspace`);
    const appHtml = await appResponse.text();
    const providerResponse = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    const providerBody = await providerResponse.text();

    expect(appResponse.status).toBe(200);
    expect(appHtml).toContain('built-react-app');
    expect(providerResponse.headers.get('x-application-server')).toBe('node-production');
    expect(providerResponse.status).toBe(401);
    expect(JSON.parse(providerBody).error.code).toBe('UNAUTHORIZED');
    expect(`${appHtml}\n${providerBody}`).not.toContain(geminiSecret);
    expect(`${appHtml}\n${providerBody}`).not.toContain(deepSeekSecret);
  });

  it('rejects an unauthenticated request before provider execution', async () => {
    const baseUrl = await start({ env: AUTH_ENV });
    const response = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(response.status).toBe(401);
    expect((await response.json() as ProviderErrorPayload).error.code).toBe('UNAUTHORIZED');
  });

  it('marks auth JSON as application-owned and never serves the packaged server artifact', async () => {
    const baseUrl = await start({ env: AUTH_ENV });

    const statusResponse = await fetch(`${baseUrl}/api/auth/status`);
    const serverArtifactResponse = await fetch(`${baseUrl}/server.cjs`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.headers.get('content-type')).toContain('application/json');
    expect(statusResponse.headers.get('x-application-server')).toBe('node-production');
    expect(await statusResponse.json()).toMatchObject({
      authenticated: false,
      status: 'AUTH_REQUIRED',
    });
    expect(serverArtifactResponse.status).toBe(404);
  });

  it('reports a missing server secret safely only after server-side authorization succeeds', async () => {
    const baseUrl = await start({ env: AUTH_ENV });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ACCESS_CODE }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    const body = await response.json() as ProviderErrorPayload;
    expect(response.status).toBe(503);
    expect(body.error.code).toBe('SERVER_CONFIGURATION_MISSING');
    expect(body.error.message).toContain('AI Studio Settings > Secrets');
  });
});
