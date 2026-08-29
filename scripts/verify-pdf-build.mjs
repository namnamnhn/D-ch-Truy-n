import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(existsSync(path.join(dist, 'index.html')), 'Run `npm run build` before PDF build verification.');

const assetFiles = readdirSync(path.join(dist, 'assets'));
const worker = assetFiles.find(file => /^pdf\.worker\.min-[\w-]+\.mjs$/.test(file));
assert(worker, 'Production build does not contain a bundled PDF.js worker.');

for (const directory of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
  const assetDirectory = path.join(dist, 'pdfjs-assets', directory);
  assert(existsSync(assetDirectory), `Missing local PDF.js asset directory: ${directory}`);
  assert(readdirSync(assetDirectory).length > 0, `Local PDF.js asset directory is empty: ${directory}`);
}

const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
const csp = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
assert(/worker-src\s+'self'\s+blob:/.test(csp), 'Production CSP does not permit the same-origin PDF worker.');
assert(!csp.includes('unsafe-eval'), 'Production CSP must not enable unsafe-eval.');

const browserArtifacts = [
  indexHtml,
  ...assetFiles
    .filter(file => /\.(?:js|mjs)$/.test(file))
    .map(file => readFileSync(path.join(dist, 'assets', file), 'utf8')),
].join('\n');
assert(!/cdn\.jsdelivr\.net\/npm\/pdfjs-dist|unpkg\.com\/pdfjs-dist/i.test(browserArtifacts), 'PDF runtime still references a public CDN.');
assert(browserArtifacts.includes(worker), 'Browser bundle does not reference the shipped PDF worker.');
assert(/enableScripting:(?:!1|false)/.test(browserArtifacts), 'Production PDF initialization does not explicitly disable scripting.');

console.log(`PDF build verification passed: ${worker}; scripting disabled; CSP and local assets are contained.`);
