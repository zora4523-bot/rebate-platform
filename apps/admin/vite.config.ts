import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { devProxy } from './src/dev-proxy.ts';

// Admin console: index.html loads src/main.tsx (the Refine shell, F1-06e).
export default defineConfig({
  // Workspace packages resolve to their TypeScript sources through `couli-src` (as in
  // vitest.shared.ts), so build and dev server never need a prior `tsc -b`.
  resolve: { conditions: ['couli-src', ...defaultClientConditions] },
  plugins: [react(), tailwindcss()],
  // COULI_ADMIN_API_TARGET (e.g. http://127.0.0.1:3001): the dev server forwards /admin/v1 to that
  // local API and the entry signs in for real instead of showing the preview accounts.
  define: {
    'import.meta.env.VITE_ADMIN_LIVE': JSON.stringify(
      devProxy(process.env.COULI_ADMIN_API_TARGET) !== undefined,
    ),
  },
  server: { proxy: devProxy(process.env.COULI_ADMIN_API_TARGET) },
  build: {
    // dist/tsc holds the `tsc -b` output; Vite empties only its own directory.
    outDir: 'dist/web',
    rolldownOptions: { input: 'index.html' },
  },
});
