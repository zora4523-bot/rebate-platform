import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// One build per entry (规划/03 §8.2): `vite build --mode <entry>` builds
// src/entries/<entry>/index.html into dist/web/<entry>/ (dist/tsc holds the `tsc -b` output).
// TODO(规划/11 §2.3): the entry directories src/entries/{app,landing,conformance} are created by F1-01c — blocked on F1-01c
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
  return {
    root: pkgDir(`./src/entries/${mode}/`),
    envDir: pkgDir('./'),
    publicDir: pkgDir('./public/'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: pkgDir(`./dist/web/${mode}/`),
      emptyOutDir: true,
    },
  };
});
