import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionAuthority } from '../server/authSession';
import { createProductionServer } from '../server/productionServer';
import { createViteSecurityPlugins } from '../server/viteSecurityPlugins';
import type { AuthStatusResponse } from '../shared/authContract';
import { DECLARED_EDITION, evaluateEditionEntitlement, type EditionDeclaration } from '../shared/editionContract';
import type { ProviderErrorPayload } from '../shared/providerContract';

const ACCESS_CODE = 'correct-horse-test-code';
const ACCESS_HASH = createHash('sha256').update(ACCESS_CODE).digest('hex');
const SIGNING_SECRET = 'test-session-signing-secret-at-least-32-bytes';
const OWNER_KEY = 'AIza-auth-owner-sentinel-123456789012345';
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  APP_ACCESS_CODE_HASH: ACCESS_HASH,
  SESSION_SIGNING_SECRET: SIGNING_SECRET,
  SESSION_TTL_SECONDS: '3600',
  GEMINI_API_KEY: OWNER_KEY,
};
const GEMINI_PAYLOAD = {
  provider: 'gemini',
  action: 'generate',
  request: { model: 'gemini-3.5-flash', contents: 'Hello' },
};

const cookiePair = (response: Response): string => (response.headers.get('set-cookie') || '').split(';')[0];
const authJson = (response: Response) => response.json() as Promise<AuthStatusResponse>;

describe('WP-FIN-03 stateless server access authority', () => {
  let buildDirectory: string;
  let server: Server | undefined;

  beforeEach(async () => {
    buildDirectory = await mkdtemp(path.join(tmpdir(), 'auth-production-server-'));
    await writeFile(path.join(buildDirectory, 'index.html'), '<div id="root">built-react-app</div>', 'utf8');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address.');
    return `http://127.0.0.1:${address.port}`;
  };

  const login = (baseUrl: string, code = ACCESS_CODE) => fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });

  it('requires a code and correct code creates a signed HttpOnly session that reaches the provider', async () => {
    let providerKey = '';
    let providerCalls = 0;
    const baseUrl = await start({
      env: BASE_ENV,
      providerDependencies: {
        createGeminiClient: key => {
          providerKey = key;
          return { models: {
            generateContent: async () => { providerCalls += 1; return { text: 'authorized result' }; },
            generateContentStream: async () => (async function* () {})(),
          } };
        },
      },
    });

    const initial = await fetch(`${baseUrl}/api/auth/status`);
    expect(initial.status).toBe(200);
    expect(await authJson(initial)).toMatchObject({ authenticated: false, status: 'AUTH_REQUIRED', requiresCode: true });

    const loginResponse = await login(baseUrl);
    const loginBody = await authJson(loginResponse.clone());
    const setCookie = loginResponse.headers.get('set-cookie') || '';
    expect(loginResponse.status).toBe(200);
    expect(loginBody).toMatchObject({ authenticated: true, status: 'AUTHENTICATED' });
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Secure');
    expect(JSON.stringify(loginBody) + setCookie).not.toContain(ACCESS_CODE);
    expect(JSON.stringify(loginBody) + setCookie).not.toContain(ACCESS_HASH);
    expect(JSON.stringify(loginBody) + setCookie).not.toContain(SIGNING_SECRET);

    const providerResponse = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair(loginResponse) },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(providerResponse.status).toBe(200);
    expect(await providerResponse.json()).toMatchObject({ text: 'authorized result' });
    expect(providerKey).toBe(OWNER_KEY);
    expect(providerCalls).toBe(1);
  });

  it('rejects wrong code and bounds brute-force attempts', async () => {
    const authority = new AuthSessionAuthority({ env: BASE_ENV, maxLoginAttempts: 2, blockMs: 60_000 });
    const baseUrl = await start({ env: BASE_ENV, authAuthority: authority });
    expect((await authJson(await login(baseUrl, 'wrong-one'))).status).toBe('INVALID_CODE');
    expect((await authJson(await login(baseUrl, 'wrong-two'))).status).toBe('INVALID_CODE');
    const blocked = await login(baseUrl, ACCESS_CODE);
    expect(blocked.status).toBe(429);
    expect((await authJson(blocked)).status).toBe('RATE_LIMITED');
  });

  it.each([
    ['APP_ACCESS_CODE_HASH', { ...BASE_ENV, APP_ACCESS_CODE_HASH: undefined }],
    ['SESSION_SIGNING_SECRET', { ...BASE_ENV, SESSION_SIGNING_SECRET: undefined }],
  ])('fails closed when %s is missing', async (_name, env) => {
    const baseUrl = await start({ env });
    const status = await fetch(`${baseUrl}/api/auth/status`);
    expect(status.status).toBe(503);
    expect((await authJson(status)).status).toBe('AUTH_NOT_CONFIGURED');
  });

  it('rejects forged/tampered cookies before executing an owner provider key', async () => {
    let providerCalls = 0;
    const baseUrl = await start({
      env: BASE_ENV,
      providerDependencies: {
        createGeminiClient: () => ({ models: {
          generateContent: async () => { providerCalls += 1; return {}; },
          generateContentStream: async () => (async function* () {})(),
        } }),
      },
    });
    const loginResponse = await login(baseUrl);
    const validCookie = cookiePair(loginResponse);
    const tamperedCookie = `${validCookie.slice(0, -1)}${validCookie.endsWith('a') ? 'b' : 'a'}`;
    const response = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: tamperedCookie },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(response.status).toBe(401);
    expect((await response.json() as ProviderErrorPayload).error.code).toBe('UNAUTHORIZED');
    expect(providerCalls).toBe(0);
  });

  it('rejects expired sessions and server-expired entitlement', async () => {
    let now = Date.now();
    const expiringEdition: EditionDeclaration = { ...DECLARED_EDITION, fullExpiryAt: now + 90_000 };
    const authority = new AuthSessionAuthority({
      env: { ...BASE_ENV, SESSION_TTL_SECONDS: '60' },
      edition: expiringEdition,
      now: () => now,
    });
    const baseUrl = await start({ env: BASE_ENV, authAuthority: authority });
    const loginResponse = await login(baseUrl);
    const cookie = cookiePair(loginResponse);

    now += 61_000;
    const expiredSession = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
    expect((await authJson(expiredSession)).status).toBe('SESSION_EXPIRED');

    now += 30_000;
    const expiredEntitlement = await fetch(`${baseUrl}/api/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(GEMINI_PAYLOAD),
    });
    expect(expiredEntitlement.status).toBe(401);
    expect(authority.inspect({ headers: { cookie }, socket: { remoteAddress: 'test' } } as never).response.status).toBe('ENTITLEMENT_EXPIRED');
  });

  it('logout clears the HttpOnly cookie and the cleared browser session is rejected', async () => {
    const baseUrl = await start({ env: BASE_ENV });
    const loginResponse = await login(baseUrl);
    expect(cookiePair(loginResponse)).toContain('app_session=');
    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookiePair(loginResponse) },
    });
    const cleared = logoutResponse.headers.get('set-cookie') || '';
    expect(cleared).toContain('app_session=;');
    expect(cleared).toContain('Max-Age=0');
    const status = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: 'app_session=' } });
    expect((await authJson(status)).authenticated).toBe(false);
  });

  it('server Full and Lite entitlement behavior matches the declared product contract', () => {
    const full = { ...DECLARED_EDITION, edition: 'full' as const, fullExpiryAt: 2_000 };
    expect(evaluateEditionEntitlement(full, 1_999)).toMatchObject({ edition: 'full', valid: true, policy: 'full-expiry' });
    expect(evaluateEditionEntitlement(full, 2_001)).toMatchObject({ edition: 'full', valid: false });

    const lite = { ...DECLARED_EDITION, edition: 'lite' as const, fullExpiryAt: null };
    const dayTwoInSaigon = Date.parse('2026-08-02T12:00:00+07:00');
    const dayFourInSaigon = Date.parse('2026-08-04T12:00:00+07:00');
    expect(evaluateEditionEntitlement(lite, dayTwoInSaigon)).toMatchObject({ edition: 'lite', valid: true, policy: 'lite-monthly-window' });
    expect(evaluateEditionEntitlement(lite, dayFourInSaigon)).toMatchObject({ edition: 'lite', valid: false });
  });
});

describe('WP-FIN-03 Vite development parity', () => {
  it('uses one session authority with no universal dev authorization bypass', async () => {
    const handlers: Array<(request: any, response: any, next: () => void) => void> = [];
    const plugins = createViteSecurityPlugins({
      NODE_ENV: 'development',
      APP_ACCESS_CODE_HASH: ACCESS_HASH,
      SESSION_SIGNING_SECRET: SIGNING_SECRET,
    });
    for (const plugin of plugins) {
      const hook = plugin.configureServer;
      if (typeof hook === 'function') hook({ middlewares: { use: (handler: any) => handlers.push(handler) } } as never);
    }
    const devServer = createServer((request, response) => {
      let index = 0;
      const next = () => {
        const handler = handlers[index++];
        if (handler) void handler(request, response, next);
        else { response.statusCode = 404; response.end(); }
      };
      next();
    });
    devServer.listen(0, '127.0.0.1');
    await once(devServer, 'listening');
    const address = devServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected dev address.');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const denied = await fetch(`${baseUrl}/api/provider`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(GEMINI_PAYLOAD),
      });
      expect(denied.status).toBe(401);

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ACCESS_CODE }),
      });
      expect(loginResponse.status).toBe(200);
      const allowedToGateway = await fetch(`${baseUrl}/api/provider`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookiePair(loginResponse) },
        body: JSON.stringify(GEMINI_PAYLOAD),
      });
      expect(allowedToGateway.status).toBe(503);
      expect((await allowedToGateway.json() as ProviderErrorPayload).error.code).toBe('SERVER_CONFIGURATION_MISSING');
    } finally {
      devServer.close();
      await once(devServer, 'close');
    }
  });
});
