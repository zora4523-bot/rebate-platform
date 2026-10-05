import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// One build per entry (规划/03 §8.2): `vite build --mode <entry>` builds
// src/entries/<entry>/index.html into dist/web/<entry>/ (dist/tsc holds the `tsc -b` output).
const ENTRIES = ['app', 'landing', 'conformance'];

// Deployment target: the same variable and values as apps/api (local / test / staging / prod).
// The conformance page never ships to production, so its build fails closed unless APP_ENV
// names a non-production environment.
const CONFORMANCE_APP_ENVS = ['local', 'test', 'staging'];

const pkgDir = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ command, mode }) => {
  if (!ENTRIES.includes(mode)) {
    throw new Error(`apps/h5: unknown mode "${mode}"; use --mode ${ENTRIES.join(' | ')}`);
  }
  if (mode === 'conformance' && command === 'build') {
    const appEnv = process.env['APP_ENV'];
    if (appEnv === undefined || !CONFORMANCE_APP_ENVS.includes(appEnv)) {
      throw new Error(
        `apps/h5: the conformance entry is never built for production; ` +
          `set APP_ENV to ${CONFORMANCE_APP_ENVS.join(' | ')} (got ${appEnv ?? 'nothing'})`,
      );
    }
  }
  if (command === 'build') {
    // Vite's documented way to choose the build's NODE_ENV (see the note in the returned config).
    process.env['NODE_ENV'] = 'production';
  }
  return {
    root: pkgDir(`./src/entries/${mode}/`),
    envDir: pkgDir('./'),
    publicDir: pkgDir('./public/'),
    // Workspace packages resolve to their TypeScript sources through `couli-src` (as in
    // vitest.shared.ts), so build and dev server never need a prior `tsc -b`.
    resolve: { conditions: ['couli-src', ...defaultClientConditions] },
    plugins: [react(), tailwindcss()],
    // A build is always a production build, also when the caller runs with another NODE_ENV
    // (Vitest and CI set "test"). Vite reads NODE_ENV after this config function returns, so the
    // assignment above makes isProduction true: production React branches and `jsx` (not
    // `jsxDEV`) together. The JSX flag is also pinned so the two can never diverge.
    ...(command === 'build' ? { oxc: { jsx: { development: false } } } : {}),
    build: {
      outDir: pkgDir(`./dist/web/${mode}/`),
      emptyOutDir: true,
    },
  };
});
