import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { providerGatewayPlugin } from '../server/providerGateway';
import { callProviderGateway } from '../src/services/api/providerGatewayClient';

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void | Promise<void>;

describe('provider gateway Vite integration', () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (!httpServer?.listening) return;
    httpServer.close();
    await once(httpServer, 'close');
    httpServer = undefined;
  });

  it('serves profile metadata before the Vite SPA fallback', async () => {
    const middlewares: Middleware[] = [];
    const plugin = providerGatewayPlugin({
      env: { NODE_ENV: 'test', APP_DEPLOYMENT_MODE: 'private-aistudio' },
    });
    const configureServer = plugin.configureServer as unknown as (server: {
      middlewares: { use: (middleware: Middleware) => void };
    }) => void;
    configureServer({ middlewares: { use: middleware => middlewares.push(middleware) } });

    expect(middlewares).toHaveLength(1);
    httpServer = createServer((request, response) => {
      void middlewares[0](request, response, () => {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>SPA fallback</title>');
      });
    });
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address.');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/provider/profiles`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ profiles: [] });
  });

  it('normalizes an AI Studio HTML cold-start response instead of leaking JSON parse errors', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<!doctype html><title>Starting Server...</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    try {
      await expect(callProviderGateway({
        provider: 'gemini',
        action: 'health',
        request: { model: 'gemini-3.5-flash', contents: 'ping' },
      })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 503, retryable: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
