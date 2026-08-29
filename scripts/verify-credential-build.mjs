import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const sentinelGemini = 'AIza_CLIENT_BUNDLE_SENTINEL_123456789012345';
const sentinelDeepSeek = 'sk-client-bundle-sentinel-123456789012345';
const sentinelAccessHash = 'a'.repeat(64);
const sentinelSigningSecret = 'SESSION_SIGNING_SENTINEL_12345678901234567890';
process.env.GEMINI_API_KEY = sentinelGemini;
process.env.DEEPSEEK_API_KEY = sentinelDeepSeek;
process.env.APP_ACCESS_CODE_HASH = sentinelAccessHash;
process.env.SESSION_SIGNING_SECRET = sentinelSigningSecret;

await build({ logLevel: 'warn' });

const dist = path.resolve('dist');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (/\.(?:js|mjs|cjs|html|css|json|map)$/i.test(entry.name)) files.push(target);
  }
}
await walk(dist);

for (const file of files) {
  const content = await readFile(file, 'utf8');
  if ([sentinelGemini, sentinelDeepSeek, sentinelAccessHash, sentinelSigningSecret].some(secret => content.includes(secret))) {
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
