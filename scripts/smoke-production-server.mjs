import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const serverEntry = path.join(root, 'dist-server', 'productionServer.js');
const browserEntry = path.join(root, 'dist', 'index.html');
const smokeHost = path.join(root, 'scripts', 'production-smoke-host.mjs');
await Promise.all([access(serverEntry), access(browserEntry), access(smokeHost)]);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.scripts?.start !== 'node dist-server/productionServer.js') {
  throw new Error('The production start script does not execute the built Node server entry.');
}

const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const probeAddress = probe.address();
if (!probeAddress || typeof probeAddress === 'string') throw new Error('Could not allocate a smoke-test port.');
const port = probeAddress.port;
probe.close();
await once(probe, 'close');

const accessCode = 'production-smoke-access-code';
const accessHash = createHash('sha256').update(accessCode).digest('hex');
const signingSecret = 'production-smoke-signing-secret-at-least-32-bytes';
const geminiSecret = 'AIza_PRODUCTION_SMOKE_SENTINEL_123456789012345';
const deepSeekSecret = 'sk-production-smoke-sentinel-1234567890';
const child = spawn(process.execPath, [smokeHost], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    APP_ACCESS_CODE_HASH: accessHash,
    SESSION_SIGNING_SECRET: signingSecret,
    GEMINI_API_KEY: geminiSecret,
    DEEPSEEK_API_KEY: deepSeekSecret,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

const waitForStartup = new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error(`Production server startup timed out.\n${output}`)), 15_000);
  const check = () => {
    if (!output.includes('NODE_PRODUCTION_AUTH_SMOKE')) return;
    clearTimeout(deadline);
    resolve();
  };
  child.stdout.on('data', check);
  child.once('exit', code => {
    clearTimeout(deadline);
    reject(new Error(`Production server exited early with ${code}.\n${output}`));
  });
});

const jsonRequest = (url, init) => fetch(url, init).then(async response => ({
  response,
  text: await response.text(),
}));

try {
  await waitForStartup;
  const origin = `http://127.0.0.1:${port}`;
  const appResponse = await fetch(`${origin}/`);
  const appHtml = await appResponse.text();
  if (!appResponse.ok || !appHtml.includes('<div id="root"')) {
    throw new Error('Built React application was not served by the built production Node entry.');
  }

  const unauthenticated = await jsonRequest(`${origin}/api/provider`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'denied' } }),
  });
  if (unauthenticated.response.status !== 401) throw new Error('Unauthenticated provider request was not rejected.');

  const login = await jsonRequest(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: accessCode }),
  });
  if (login.response.status !== 200 || !JSON.parse(login.text).authenticated) throw new Error(`Production login failed: ${login.text}`);
  const cookie = (login.response.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('app_session=')) throw new Error('Production login did not issue a session cookie.');

  const status = await jsonRequest(`${origin}/api/auth/status`, { headers: { Cookie: cookie } });
  if (status.response.status !== 200 || !JSON.parse(status.text).authenticated) throw new Error('Authenticated status failed.');

  const provider = await jsonRequest(`${origin}/api/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'production smoke' } }),
  });
  if (provider.response.headers.get('x-application-server') !== 'node-production') throw new Error('/api/provider was not served by the production Node server.');
  if (provider.response.status !== 200 || JSON.parse(provider.text).text !== 'authenticated production mock') {
    throw new Error(`Authenticated provider mock failed: ${provider.response.status} ${provider.text}`);
  }

  const logout = await jsonRequest(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const clearedCookie = (logout.response.headers.get('set-cookie') || '').split(';')[0];
  if (clearedCookie !== 'app_session=') throw new Error('Logout did not clear the production session cookie.');
  const rejectedAfterLogout = await jsonRequest(`${origin}/api/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: clearedCookie },
    body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'denied after logout' } }),
  });
  if (rejectedAfterLogout.response.status !== 401) throw new Error('Provider remained accessible after logout.');

  const browserObservable = [appHtml, unauthenticated.text, login.text, status.text, provider.text, logout.text, rejectedAfterLogout.text].join('\n');
  for (const secret of [accessCode, accessHash, signingSecret, geminiSecret, deepSeekSecret]) {
    if (browserObservable.includes(secret)) throw new Error('A server authentication/provider secret appeared in browser-observable output.');
  }
  if (output.includes('vite preview')) throw new Error('Production smoke unexpectedly depended on Vite preview.');
  console.log(`Production auth smoke PASS: login/status/provider/logout/reject-after-logout on built Node output PORT=${port}.`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 5_000); })]);
    clearTimeout(timeout);
  }
}
