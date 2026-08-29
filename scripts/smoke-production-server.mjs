import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const serverEntry = path.join(root, 'dist', 'server.mjs');
const browserEntry = path.join(root, 'dist', 'index.html');
const pdfAssets = path.join(root, 'dist', 'pdfjs-assets');
await Promise.all([access(serverEntry), access(browserEntry), access(pdfAssets)]);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.scripts?.start !== 'node dist/server.mjs') {
  throw new Error('The production start script does not execute the built Node server entry.');
}

const browserAssets = await readdir(path.join(root, 'dist', 'assets'));
const browserAsset = browserAssets.find(file => /\.(?:js|mjs|css)$/.test(file));
if (!browserAsset) throw new Error('The client build did not emit a browser asset.');

const allocatePort = async () => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a smoke-test port.');
  probe.close();
  await once(probe, 'close');
  return address.port;
};

const accessCode = 'production-smoke-access-code';
const accessHash = createHash('sha256').update(accessCode).digest('hex');
const signingSecret = 'production-smoke-signing-secret-at-least-32-bytes';

const jsonRequest = (url, init) => fetch(url, init).then(async response => ({
  response,
  text: await response.text(),
}));

const startServer = async (env) => {
  const port = await allocatePort();
  const windows = process.platform === 'win32';
  const child = spawn(
    windows ? 'cmd.exe' : 'npm',
    windows ? ['/d', '/s', '/c', 'npm.cmd start'] : ['start'],
    {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Production server startup timed out.\n${output}`)), 15_000);
    const check = () => {
      if (!output.includes('NODE_PRODUCTION_SERVER listening')) return;
      clearTimeout(deadline);
      resolve();
    };
    child.stdout.on('data', check);
    child.once('exit', code => {
      clearTimeout(deadline);
      reject(new Error(`Production server exited early with ${code}.\n${output}`));
    });
  });
  return { child, output: () => output, origin: `http://127.0.0.1:${port}` };
};

const stopServer = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    await once(killer, 'close');
    return;
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timeout;
  await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 5_000); })]);
  clearTimeout(timeout);
};

const assertJson = ({ response, text }, description) => {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`${description} returned non-JSON content: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
};

const unconfigured = await startServer({
  APP_ACCESS_CODE_HASH: '',
  SESSION_SIGNING_SECRET: '',
});
try {
  const status = await jsonRequest(`${unconfigured.origin}/api/auth/status`);
  const statusBody = assertJson(status, 'Unconfigured /api/auth/status');
  if (status.response.status !== 503 || statusBody.status !== 'AUTH_NOT_CONFIGURED') {
    throw new Error(`Unconfigured auth did not fail safely: ${status.response.status} ${status.text}`);
  }
} finally {
  await stopServer(unconfigured.child);
}

const configured = await startServer({
  APP_ACCESS_CODE_HASH: accessHash,
  SESSION_SIGNING_SECRET: signingSecret,
});
try {
  const appResponse = await fetch(`${configured.origin}/`);
  const appHtml = await appResponse.text();
  if (!appResponse.ok || !appHtml.includes('<div id="root"')) {
    throw new Error('Built React application was not served by npm start.');
  }
  const assetResponse = await fetch(`${configured.origin}/assets/${browserAsset}`);
  if (!assetResponse.ok) throw new Error('Built browser asset was not served by npm start.');
  if ((await fetch(`${configured.origin}/server.mjs`)).status !== 404) {
    throw new Error('The packaged Node runtime was exposed as a public static route.');
  }

  const initialStatus = await jsonRequest(`${configured.origin}/api/auth/status`);
  const initialStatusBody = assertJson(initialStatus, 'Initial /api/auth/status');
  if (initialStatus.response.status !== 200 || initialStatusBody.status !== 'AUTH_REQUIRED') {
    throw new Error(`Initial auth status failed: ${initialStatus.response.status} ${initialStatus.text}`);
  }

  const login = await jsonRequest(`${configured.origin}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: accessCode }),
  });
  if (login.response.status !== 200 || !assertJson(login, 'Production login').authenticated) throw new Error(`Production login failed: ${login.text}`);
  const cookie = (login.response.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('app_session=')) throw new Error('Production login did not issue a session cookie.');

  const status = await jsonRequest(`${configured.origin}/api/auth/status`, { headers: { Cookie: cookie } });
  if (status.response.status !== 200 || !assertJson(status, 'Authenticated /api/auth/status').authenticated) throw new Error('Authenticated status failed.');

  const provider = await jsonRequest(`${configured.origin}/api/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'production smoke' } }),
  });
  if (provider.response.headers.get('x-application-server') !== 'node-production') throw new Error('/api/provider was not served by the production Node server.');
  const providerBody = assertJson(provider, 'Authenticated /api/provider');
  if (provider.response.status !== 503 || providerBody.error?.code !== 'SERVER_CONFIGURATION_MISSING') {
    throw new Error(`Authenticated provider boundary failed: ${provider.response.status} ${provider.text}`);
  }

  const logout = await jsonRequest(`${configured.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const clearedCookie = (logout.response.headers.get('set-cookie') || '').split(';')[0];
  if (clearedCookie !== 'app_session=') throw new Error('Logout did not clear the production session cookie.');
  const rejectedAfterLogout = await jsonRequest(`${configured.origin}/api/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: clearedCookie },
    body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'denied after logout' } }),
  });
  if (rejectedAfterLogout.response.status !== 401 || assertJson(rejectedAfterLogout, 'Post-logout /api/provider').error?.code !== 'UNAUTHORIZED') {
    throw new Error('Provider remained accessible after logout.');
  }

  const browserObservable = [appHtml, initialStatus.text, login.text, status.text, provider.text, logout.text, rejectedAfterLogout.text].join('\n');
  for (const secret of [accessCode, accessHash, signingSecret]) {
    if (browserObservable.includes(secret)) throw new Error('A server authentication/provider secret appeared in browser-observable output.');
  }
  if (configured.output().includes('vite preview')) throw new Error('Production smoke unexpectedly depended on Vite preview.');
  console.log('Production runtime smoke PASS: built dist/server.mjs via npm start; auth JSON, static files, provider boundary, and logout verified.');
} finally {
  await stopServer(configured.child);
}
