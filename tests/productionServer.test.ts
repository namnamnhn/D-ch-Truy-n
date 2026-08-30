import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionServer } from '../server/productionServer';

describe('production Node server', () => {
  let directory: string; let server: Server | undefined;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'provider-production-server-')); await writeFile(path.join(directory, 'index.html'), '<div id="root">app</div>'); });
  afterEach(async () => { if (server?.listening) { server.close(); await once(server, 'close'); } await rm(directory, { recursive: true, force: true }); });
  it('opens the app directly and fails closed outside private AI Studio mode', async () => {
    server = createProductionServer({ buildDirectory: directory, env: { GEMINI_API_KEY: 'AIza-server-secret' } }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address.'); const origin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${origin}/workspace`)).status).toBe(200);
    const response = await fetch(`${origin}/api/provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'x' } }) });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('DEPLOYMENT_ACCESS_NOT_CONFIGURED');
  });
});
