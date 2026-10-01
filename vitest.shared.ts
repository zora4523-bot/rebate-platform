// Shared Vitest configuration for every workspace package (conventions C5).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import { defaultServerConditions } from 'vite';
import { configDefaults, type ViteUserConfig } from 'vitest/config';

// Workspace packages expose their TypeScript sources through the custom export condition
// `couli-src`, so tests never need a prior build. Vite's own server conditions are kept.
const CONDITIONS: string[] = ['couli-src', ...defaultServerConditions];

const BASE_EXCLUDE: string[] = [...configDefaults.exclude, '**/dist/**', '**/.tmp/**'];

// Same strictness for every tier: an empty run, `.only`, retries and assertion-free tests fail.
const STRICT = {
  passWithNoTests: false,
  allowOnly: false,
  retry: 0,
  expect: { requireAssertions: true },
} as const;

function resolveBlock(): Pick<ViteUserConfig, 'resolve' | 'ssr'> {
  return {
    resolve: { conditions: [...CONDITIONS] },
    ssr: { resolve: { conditions: [...CONDITIONS] } },
  };
}

/** Unit tests: no database, no ports, no network. Integration files are excluded. */
export function unitConfig(include: string[] = ['src/**/*.test.ts']): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include,
      exclude: [...BASE_EXCLUDE, '**/*.int.test.ts'],
    },
  };
}

/** Integration tests (`*.int.test.ts`): need PostgreSQL; run only by `test:int`. */
export function integrationConfig(opts: {
  include?: string[];
  globalSetup: string[];
}): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include: opts.include ?? ['src/**/*.int.test.ts'],
      exclude: [...BASE_EXCLUDE],
      globalSetup: opts.globalSetup,
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  };
}

/** Long-run property tier; per-test timeout is 10 minutes (规划/11 §4.2). */
export function longrunConfig(include: string[]): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include,
      exclude: [...BASE_EXCLUDE],
      testTimeout: 600_000,
    },
  };
}
