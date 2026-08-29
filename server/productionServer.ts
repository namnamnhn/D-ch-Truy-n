import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROVIDER_GATEWAY_PATH } from '../shared/providerContract';
import {
  AuthSessionAuthority,
  createAuthRequestHandler,
  isAuthPath,
} from './authSession';
import {
  createProviderRequestHandler,
  type ProviderGatewayDependencies,
} from './providerGateway';

const DEFAULT_PORT = 8080;
const DEFAULT_BUILD_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url));
const SERVER_ARTIFACT_NAME = path.basename(fileURLToPath(import.meta.url));
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface ProductionServerOptions {
  buildDirectory?: string;
  env?: NodeJS.ProcessEnv;
  providerDependencies?: Omit<ProviderGatewayDependencies, 'env'>;
  authAuthority?: AuthSessionAuthority;
}

const safePort = (value: string | undefined): number => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const sendText = (response: import('node:http').ServerResponse, status: number, body: string): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
};

async function serveStatic(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  buildDirectory: string,
): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }

  const relativePath = pathname.replace(/^\/+/, '');
  // The Node runtime is packaged next to public files, but must not be served
  // as a browser asset.
  if (relativePath === SERVER_ARTIFACT_NAME) {
    sendText(response, 404, 'Not Found');
    return;
  }
  const requestedPath = path.resolve(buildDirectory, relativePath || 'index.html');
  const rootPrefix = `${path.resolve(buildDirectory)}${path.sep}`;
  if (requestedPath !== path.resolve(buildDirectory) && !requestedPath.startsWith(rootPrefix)) {
    sendText(response, 404, 'Not Found');
    return;
  }

  let filePath = requestedPath;
  try {
    if (!(await stat(filePath)).isFile()) throw new Error('Not a file');
  } catch {
    if (path.extname(relativePath)) {
      sendText(response, 404, 'Not Found');
      return;
    }
    filePath = path.join(buildDirectory, 'index.html');
    try {
      if (!(await stat(filePath)).isFile()) throw new Error('Missing build');
    } catch {
      sendText(response, 503, 'Built application is unavailable. Run npm run build before npm start.');
      return;
    }
  }

  response.statusCode = 200;
  response.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable');
  if (request.method === 'HEAD') return void response.end();
  createReadStream(filePath)
    .on('error', () => { if (!response.headersSent) sendText(response, 500, 'Internal Server Error'); else response.destroy(); })
    .pipe(response);
}

export function createProductionServer(options: ProductionServerOptions = {}): Server {
  const buildDirectory = path.resolve(options.buildDirectory || DEFAULT_BUILD_DIRECTORY);
  const env = options.env || process.env;
  const authAuthority = options.authAuthority || new AuthSessionAuthority({ env });
  const handleAuthRequest = createAuthRequestHandler(authAuthority);
  const handleProviderRequest = createProviderRequestHandler({
    env,
    ...options.providerDependencies,
    authorizeRequest: authAuthority.authorizeRequest,
  });

  return createServer((request, response) => {
    const pathname = (request.url || '').split('?')[0];
    if (pathname === PROVIDER_GATEWAY_PATH) response.setHeader('X-Application-Server', 'node-production');
    const operation = isAuthPath(pathname)
      ? handleAuthRequest(request, response)
      : pathname === PROVIDER_GATEWAY_PATH
        ? handleProviderRequest(request, response)
        : serveStatic(request, response, buildDirectory);
    void operation.catch(() => {
      if (!response.headersSent) sendText(response, 500, 'Internal Server Error');
      else response.destroy();
    });
  });
}

export function startProductionServer(options: ProductionServerOptions = {}): Server {
  const env = options.env || { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' };
  const port = safePort(env.PORT);
  const server = createProductionServer({ ...options, env });
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`NODE_PRODUCTION_SERVER listening on http://0.0.0.0:${boundPort}`);
  });
  return server;
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) startProductionServer();
