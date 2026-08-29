import { once } from 'node:events';
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

  it('serves the built React app and exposes a fail-closed provider route on the same Node server', async () => {
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
    expect(providerResponse.status).toBe(503);
    expect(JSON.parse(providerBody).error.code).toBe('AUTHORIZATION_NOT_CONFIGURED');
    expect(`${appHtml}\n${providerBody}`).not.toContain(geminiSecret);
    expect(`${appHtml}\n${providerBody}`).not.toContain(deepSeekSecret);
  });

  it('rejects an unauthenticated request when a future authorization authority is connected', async () => {
    const baseUrl = await start({ authorizeProviderRequest: async () => false });
    const response = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(response.status).toBe(401);
    expect((await response.json() as ProviderErrorPayload).error.code).toBe('UNAUTHORIZED');
  });

  it('reports a missing server secret safely only after server-side authorization succeeds', async () => {
    const baseUrl = await start({ env: {}, authorizeProviderRequest: async () => true });
    const response = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    const body = await response.json() as ProviderErrorPayload;
    expect(response.status).toBe(503);
    expect(body.error.code).toBe('SERVER_CONFIGURATION_MISSING');
    expect(body.error.message).toContain('AI Studio Settings > Secrets');
  });
});
