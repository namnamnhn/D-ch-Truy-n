import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build as buildServer } from 'esbuild';
import { build } from 'vite';

const sentinelGemini = 'AIza_CLIENT_BUNDLE_SENTINEL_123456789012345';
const sentinelDeepSeek = 'sk-client-bundle-sentinel-123456789012345';
process.env.GEMINI_API_KEY = sentinelGemini;
process.env.DEEPSEEK_API_KEY = sentinelDeepSeek;

await build({ logLevel: 'warn' });
await buildServer({
  entryPoints: [path.resolve('server/productionEntry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: path.resolve('dist/server.cjs'),
  logLevel: 'warning',
});

const dist = path.resolve('dist');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (target !== path.join(dist, 'server.cjs') && /\.(?:js|mjs|cjs|html|css|json|map)$/i.test(entry.name)) files.push(target);
  }
}
await walk(dist);

if (!files.length || !(await readdir(dist)).includes('server.cjs')) {
  throw new Error('Credential verification did not retain the packaged Node server artifact.');
}

for (const file of files) {
  const content = await readFile(file, 'utf8');
  if ([sentinelGemini, sentinelDeepSeek].some(secret => content.includes(secret))) {
    throw new Error(`Credential sentinel leaked into browser artifact: ${path.relative(dist, file)}`);
  }
  if (content.includes('api.deepseek.com/chat/completions')) {
    throw new Error(`Direct DeepSeek provider URL leaked into browser artifact: ${path.relative(dist, file)}`);
  }
  if (content.includes('PASSWORD_HASH')) {
    throw new Error(`Legacy client PASSWORD_HASH authority remains in browser artifact: ${path.relative(dist, file)}`);
  }
}

if (files.some(file => /vendor-genai/i.test(path.basename(file)))) {
  throw new Error('The privileged Gemini SDK was emitted as a browser vendor chunk.');
}

console.log(`Credential build scan PASS: ${files.length} browser artifacts, 0 sentinel/provider-boundary leaks.`);
