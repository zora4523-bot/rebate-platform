import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// TODO(规划/11 §2.3): the Refine admin shell and its routes are built by F1-06e — blocked on F1-06e
export default defineConfig({
  // Workspace packages resolve to their TypeScript sources through `couli-src` (as in
  // vitest.shared.ts), so build and dev server never need a prior `tsc -b`.
  resolve: { conditions: ['couli-src', ...defaultClientConditions] },
  plugins: [react(), tailwindcss()],
  build: {
    // dist/tsc holds the `tsc -b` output; Vite empties only its own directory.
    outDir: 'dist/web',
    rolldownOptions: { input: 'index.html' },
  },
});
