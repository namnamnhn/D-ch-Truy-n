import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
const serverEntry = path.join(root, 'dist-server', 'productionServer.js');
const browserEntry = path.join(root, 'dist', 'index.html');
await Promise.all([access(serverEntry), access(browserEntry)]);

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

const geminiSecret = 'AIza_PRODUCTION_SMOKE_SENTINEL_123456789012345';
const deepSeekSecret = 'sk-production-smoke-sentinel-1234567890';
const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
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
    if (!output.includes('NODE_PRODUCTION_SERVER')) return;
    clearTimeout(deadline);
    resolve();
  };
  child.stdout.on('data', check);
  child.once('exit', code => {
    clearTimeout(deadline);
    reject(new Error(`Production server exited early with ${code}.\n${output}`));
  });
});

try {
  await waitForStartup;
  const appResponse = await fetch(`http://127.0.0.1:${port}/`);
  const appHtml = await appResponse.text();
  const providerResponse = await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'gemini',
      action: 'generate',
      request: { model: 'gemini-3.5-flash', contents: 'production smoke' },
    }),
  });
  const providerBody = await providerResponse.text();

  if (!appResponse.ok || !appHtml.includes('<div id="root"')) {
    throw new Error('Built React application was not served by the production Node entry.');
  }
  if (providerResponse.headers.get('x-application-server') !== 'node-production') {
    throw new Error('/api/provider was not served by the production Node server.');
  }
  if (providerResponse.status !== 503 || JSON.parse(providerBody)?.error?.code !== 'AUTHORIZATION_NOT_CONFIGURED') {
    throw new Error(`Provider route did not honestly fail closed pending WP-FIN-03: ${providerResponse.status} ${providerBody}`);
  }
  const observableBrowserOutput = `${appHtml}\n${providerBody}`;
  if (observableBrowserOutput.includes(geminiSecret) || observableBrowserOutput.includes(deepSeekSecret)) {
    throw new Error('A server credential appeared in browser-observable production output.');
  }
  if (output.includes('vite preview')) throw new Error('Production smoke unexpectedly depended on Vite preview.');

  console.log(`Production server smoke PASS: built React app and fail-closed /api/provider served by Node on PORT=${port}.`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    let timeout;
    await Promise.race([
      exited,
      new Promise(resolve => { timeout = setTimeout(resolve, 5_000); }),
    ]);
    clearTimeout(timeout);
  }
}
