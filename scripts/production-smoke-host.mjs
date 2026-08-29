import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = pathToFileURL(path.resolve('dist-server/productionServer.js')).href;
const { createProductionServer } = await import(entry);
const server = createProductionServer({
  env: process.env,
  providerDependencies: {
    createGeminiClient: () => ({
      models: {
        generateContent: async () => ({ text: 'authenticated production mock' }),
        generateContentStream: async () => (async function* () {})(),
      },
    }),
  },
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => console.log(`NODE_PRODUCTION_AUTH_SMOKE PORT=${port}`));
const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
