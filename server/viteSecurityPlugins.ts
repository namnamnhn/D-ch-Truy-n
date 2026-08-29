import type { Plugin } from 'vite';
import { AuthSessionAuthority, authSessionPlugin } from './authSession';
import { providerGatewayPlugin } from './providerGateway';

/** Vite dev/preview uses the exact same session authority as the production server. */
export const createViteSecurityPlugins = (env: NodeJS.ProcessEnv = process.env): Plugin[] => {
  const authority = new AuthSessionAuthority({ env });
  return [
    authSessionPlugin(authority),
    providerGatewayPlugin({ env, authorizeRequest: authority.authorizeRequest }),
  ];
};
