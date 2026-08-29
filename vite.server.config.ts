import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'server/productionServer.ts',
    // AI Studio deploys the dist directory as one full-stack runtime package.
    // Keep the client build produced by the first Vite pass intact.
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node20',
    rollupOptions: {
      output: {
        entryFileNames: 'server.mjs',
      },
    },
  },
});
