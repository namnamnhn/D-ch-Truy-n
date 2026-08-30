import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const root = process.cwd();
await Promise.all([access(path.join(root, 'dist', 'server.cjs')), access(path.join(root, 'dist', 'index.html'))]);
const assets = await readdir(path.join(root, 'dist', 'assets'));
const asset = assets.find(file => /\.(?:js|mjs|css)$/.test(file));
if (!asset) throw new Error('No browser asset was emitted.');
const port = await new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
});
const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd start'] : ['start'], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test', PORT: String(port), APP_DEPLOYMENT_MODE: 'private-aistudio' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(output)), 15_000); child.stdout.on('data', () => { if (output.includes('AI_STUDIO_RUNTIME_READY')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => reject(new Error(`Server exited ${code}: ${output}`))); });
  const origin = `http://127.0.0.1:${port}`;
  const app = await fetch(`${origin}/`); if (!app.ok || !(await app.text()).includes('<div id="root"')) throw new Error('React application was not served.');
  if (!(await fetch(`${origin}/assets/${asset}`)).ok || (await fetch(`${origin}/server.cjs`)).status !== 404) throw new Error('Static boundary failed.');
  const provider = await fetch(`${origin}/api/provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'smoke' } }) });
  const body = await provider.json();
  if (provider.status !== 503 || body.error?.code !== 'SERVER_CONFIGURATION_MISSING' || provider.headers.get('x-application-server') !== 'node-production') throw new Error(`Provider boundary failed: ${provider.status} ${JSON.stringify(body)}`);
  const publicBlocked = await fetch(`${origin}/api/provider`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', action: 'generate', request: { model: 'gemini-3.5-flash', contents: 'smoke' } }) });
  if (publicBlocked.status !== 503) throw new Error('Missing credentials did not fail closed.');
  console.log('Production runtime smoke PASS: direct workspace, static files, and private-AI-Studio provider boundary verified.');
} finally {
  if (child.exitCode === null) { const killer = process.platform === 'win32' ? spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']) : (child.kill('SIGTERM'), null); if (killer) await once(killer, 'close'); }
}
