import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function buildInfoPlugin(): Plugin {
  return {
    name: 'weemap-build-info',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify({
          builtAt: Date.now(),
          commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        }),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfoPlugin()],
  build: { sourcemap: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
