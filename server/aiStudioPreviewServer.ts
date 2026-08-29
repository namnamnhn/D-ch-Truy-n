import { createServer, type Server } from 'node:http';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { AUTH_LOGIN_PATH, AUTH_STATUS_PATH } from '../shared/authContract';
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

const DEFAULT_PREVIEW_PORT = 3000;

export interface AiStudioPreviewServerOptions {
  env?: NodeJS.ProcessEnv;
  providerDependencies?: Omit<ProviderGatewayDependencies, 'env'>;
  authAuthority?: AuthSessionAuthority;
}

export interface AiStudioPreviewServer {
  httpServer: Server;
  viteServer: ViteDevServer;
}

const previewPort = (value: string | undefined): number => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PREVIEW_PORT;
};

const sendInternalError = (response: import('node:http').ServerResponse): void => {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.statusCode = 500;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end('Internal Server Error');
};

/**
 * Google AI Studio Preview runs a Node entrypoint and expects that process to
 * own both the same-origin API routes and Vite's frontend middleware. Keep the
 * API routes in front of Vite so its SPA fallback cannot turn them into HTML.
 */
export async function createAiStudioPreviewServer(
  options: AiStudioPreviewServerOptions = {},
): Promise<AiStudioPreviewServer> {
  const env = options.env || process.env;
  const authAuthority = options.authAuthority || new AuthSessionAuthority({ env });
  const handleAuthRequest = createAuthRequestHandler(authAuthority);
  const handleProviderRequest = createProviderRequestHandler({
    env,
    ...options.providerDependencies,
    authorizeRequest: authAuthority.authorizeRequest,
  });
  const viteServer = await createViteServer({
    appType: 'spa',
    server: { middlewareMode: true },
  });
  let observedAuthStatus = false;
  let observedAuthLogin = false;

  const httpServer = createServer((request, response) => {
    const pathname = (request.url || '').split('?')[0];
    if (isAuthPath(pathname) || pathname === PROVIDER_GATEWAY_PATH) {
      response.setHeader('X-Application-Server', 'node-preview');
    }
    if (pathname === AUTH_STATUS_PATH && !observedAuthStatus && env.NODE_ENV !== 'test') {
      observedAuthStatus = true;
      response.once('finish', () => {
        const contentType = response.getHeader('content-type') || 'unset';
        console.log(`AI_STUDIO_AUTH_STATUS_REACHED status=${response.statusCode} content-type=${contentType}`);
      });
    }
    if (pathname === AUTH_LOGIN_PATH && !observedAuthLogin && env.NODE_ENV !== 'test') {
      observedAuthLogin = true;
      response.once('finish', () => {
        const contentType = response.getHeader('content-type') || 'unset';
        console.log(`AI_STUDIO_AUTH_LOGIN_REACHED status=${response.statusCode} content-type=${contentType}`);
      });
    }
    const operation = isAuthPath(pathname)
      ? handleAuthRequest(request, response)
      : pathname === PROVIDER_GATEWAY_PATH
        ? handleProviderRequest(request, response)
        : new Promise<void>((resolve, reject) => {
            viteServer.middlewares(request, response, error => {
              if (error) return reject(error);
              if (!response.headersSent) {
                response.statusCode = 404;
                response.end('Not Found');
              }
              resolve();
            });
          });

    void operation.catch(() => sendInternalError(response));
  });

  return { httpServer, viteServer };
}

export async function startAiStudioPreviewServer(
  options: AiStudioPreviewServerOptions = {},
): Promise<AiStudioPreviewServer> {
  const env = options.env || process.env;
  const preview = await createAiStudioPreviewServer({ ...options, env });
  const port = previewPort(env.PORT);
  preview.httpServer.listen(port, '0.0.0.0', () => {
    console.log(`AI_STUDIO_PREVIEW_SERVER listening on http://0.0.0.0:${port}`);
  });
  return preview;
}
