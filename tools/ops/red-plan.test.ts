// The plan of the isolated red run (Codex review CR2-04).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { repoRoot } from '../lib/paths.ts';
import { loadRedProjects, planRed } from './red-plan.ts';

const projects = loadRedProjects();

/** The string array literals in a source text, in order. */
function arrays(source: string): string[][] {
  return [...source.matchAll(/\[([^\]]*)\]/g)].map((m) =>
    [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? ''),
  );
}

it('[CR2-04] the project table mirrors the include rules of the trusted Vitest configs', () => {
  const read = (path: string): string => readFileSync(join(repoRoot(), path), 'utf8');
  const shared = read('vitest.shared.ts');
  // unitConfig: default include src/**/*.test.ts, integration files and the caller's extra
  // exclusions excluded.
  expect(shared).toContain(
    "  include: string[] = ['src/**/*.test.ts'],\n  exclude: string[] = [],",
  );
  expect(shared).toContain("exclude: [...BASE_EXCLUDE, '**/*.int.test.ts', ...exclude],");
  const byName = new Map(projects.map((p) => [p.name, p]));
  // test/vitest.config.ts: include, then the extra exclusions (the browser and build smoke rule
  // tests).
  const unit = arrays(read('test/vitest.config.ts'));
  expect(unit[0]).toEqual(byName.get('spec-unit')?.include);
  expect(['**/*.int.test.ts', ...(unit[1] ?? [])]).toEqual(byName.get('spec-unit')?.exclude);
  expect(arrays(read('test/vitest.integration.config.ts'))[0]).toEqual(
    byName.get('spec-int')?.include,
  );
  expect(read('packages/testing/vitest.config.ts')).toContain('unitConfig()');
  expect(byName.get('testing-unit')?.include).toEqual(['src/**/*.test.ts']);
  expect(byName.get('spec-unit')?.exclude).toEqual([
    '**/*.int.test.ts',
    'spec/**/*.browser.test.{ts,tsx}',
    'spec/**/*.smoke.test.ts',
  ]);
  // Other packages do not exclude browser files: one put there runs in the unit tier and fails
  // there instead of being skipped in silence.
  expect(byName.get('testing-unit')?.exclude).toEqual(['**/*.int.test.ts']);
  expect(byName.get('spec-int')).toMatchObject({
    config: 'vitest.integration.config.ts',
    database: true,
    browser: false,
  });

  // F1-01j: the browser project. Its config takes spec/**/*.browser.test.{ts,tsx} through
  // browserConfig (no exclude beyond the shared one) and is what `test:browser` runs.
  const browserSource = read('test/vitest.browser.config.ts');
  expect(arrays(browserSource)[0]).toEqual(byName.get('spec-browser')?.include);
  expect(browserSource).toContain('browserConfig({');
  expect(shared).toMatch(/export function browserConfig\([\s\S]*?exclude: \[\.\.\.BASE_EXCLUDE\],/);
  expect(byName.get('spec-browser')).toEqual({
    name: 'spec-browser',
    dir: 'test',
    config: 'vitest.browser.config.ts',
    include: ['spec/**/*.browser.test.{ts,tsx}'],
    exclude: [],
    database: false,
    browser: true,
  });
  const pkg = JSON.parse(read('test/package.json')) as { scripts: Record<string, string> };
  expect(pkg.scripts['test:browser']).toBe('vitest run --config vitest.browser.config.ts');

  // F1-01k: the build smoke project. Node tests (smokeConfig) against the builds of the
  // globalSetup; `test:smoke` runs it.
  const smokeSource = read('test/vitest.build-smoke.config.ts');
  expect(arrays(smokeSource)[0]).toEqual(byName.get('build-smoke')?.include);
  expect(arrays(smokeSource)[1]).toEqual(['../tools/ops/build-smoke/global-setup.ts']);
  expect(smokeSource).toContain('smokeConfig({');
  expect(shared).toMatch(/export function smokeConfig\([\s\S]*?exclude: \[\.\.\.BASE_EXCLUDE\],/);
  expect(byName.get('build-smoke')).toEqual({
    name: 'build-smoke',
    dir: 'test',
    config: 'vitest.build-smoke.config.ts',
    include: ['spec/**/*.smoke.test.ts'],
    exclude: [],
    database: false,
    browser: true,
  });
  expect(pkg.scripts['test:smoke']).toBe('vitest run --config vitest.build-smoke.config.ts');
  // The projects that need Chromium, in the order verify-container.sh --browser runs them.
  expect(projects.filter((p) => p.browser).map((p) => p.name)).toEqual([
    'spec-browser',
    'build-smoke',
  ]);
  // `pnpm verify` runs both after the integration tests; verify:fast runs neither.
  const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  expect(root.scripts['verify']).toContain(
    'pnpm --filter @couli/spec-tests run test:browser && pnpm --filter @couli/spec-tests run test:smoke',
  );
  expect(root.scripts['verify:fast']).not.toMatch(/test:(?:browser|smoke)/);
});

it('[CR2-04] acceptance and packages/testing files get their own entry; a file without one fails', () => {
  const plan = planRed(
    [
      'test/spec/money/split.test.ts',
      'test/properties/money/sum.test.ts',
      'test/spec/db/ledger.int.test.ts',
      'test/acceptance/order.test.ts',
      'packages/testing/src/arb.test.ts',
      'test/replay/orders.test.ts',
      'db/invariants/ledger.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/money/split.test.ts', 'properties/money/sum.test.ts'],
    },
    {
      name: 'spec-int',
      dir: 'test',
      config: 'vitest.integration.config.ts',
      database: true,
      browser: false,
      files: ['spec/db/ledger.int.test.ts', 'acceptance/order.test.ts'],
    },
    {
      name: 'testing-unit',
      dir: 'packages/testing',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['src/arb.test.ts'],
    },
  ]);
  expect(plan.unrunnable).toEqual(['test/replay/orders.test.ts', 'db/invariants/ledger.test.ts']);
});

it('[F1-01j] spec browser rule tests (.ts, .tsx) go to spec-browser only; elsewhere the unit tier takes them', () => {
  const plan = planRed(
    [
      'test/spec/frontend/browser-env/environment.browser.test.ts',
      'test/spec/frontend/browser-env/card.browser.test.tsx',
      'test/spec/frontend/browser-env/tokens.test.ts',
      'test/properties/ui/layout.browser.test.ts',
      'packages/testing/src/dom.browser.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'spec-browser',
      dir: 'test',
      config: 'vitest.browser.config.ts',
      database: false,
      browser: true,
      files: [
        'spec/frontend/browser-env/environment.browser.test.ts',
        'spec/frontend/browser-env/card.browser.test.tsx',
      ],
    },
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/frontend/browser-env/tokens.test.ts', 'properties/ui/layout.browser.test.ts'],
    },
    {
      name: 'testing-unit',
      dir: 'packages/testing',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['src/dom.browser.test.ts'],
    },
  ]);
  // Outside test/spec/ a browser file is not skipped: the unit tier runs it (and it fails there).
  expect(plan.unrunnable).toEqual([]);
});

it('[F1-01k] spec build smoke rule tests go to build-smoke only; elsewhere the unit tier takes them', () => {
  const plan = planRed(
    [
      'test/spec/frontend/build-smoke/entries.smoke.test.ts',
      'test/spec/frontend/build-smoke/sizes.test.ts',
      'test/properties/ui/budget.smoke.test.ts',
    ],
    projects,
  );
  expect(plan.groups).toEqual([
    {
      name: 'build-smoke',
      dir: 'test',
      config: 'vitest.build-smoke.config.ts',
      database: false,
      browser: true,
      files: ['spec/frontend/build-smoke/entries.smoke.test.ts'],
    },
    {
      name: 'spec-unit',
      dir: 'test',
      config: 'vitest.config.ts',
      database: false,
      browser: false,
      files: ['spec/frontend/build-smoke/sizes.test.ts', 'properties/ui/budget.smoke.test.ts'],
    },
  ]);
  expect(plan.unrunnable).toEqual([]);
});
