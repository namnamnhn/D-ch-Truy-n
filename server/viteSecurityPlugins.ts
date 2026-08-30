import type { Plugin } from 'vite';
import { providerGatewayPlugin } from './providerGateway';

/** Provider calls are enabled only by the explicit private AI Studio deployment policy. */
export const createViteSecurityPlugins = (env: NodeJS.ProcessEnv = process.env): Plugin[] => {
  return [
    providerGatewayPlugin({ env }),
  ];
};
