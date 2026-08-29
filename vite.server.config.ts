import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'server/productionServer.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      output: {
        entryFileNames: 'productionServer.js',
      },
    },
  },
});
