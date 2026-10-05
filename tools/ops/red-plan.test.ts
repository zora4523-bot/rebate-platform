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
  // unitConfig: default include src/**/*.test.ts, integration files excluded.
  expect(shared).toContain("export function unitConfig(include: string[] = ['src/**/*.test.ts'])");
  expect(shared).toMatch(/exclude: \[\.\.\.BASE_EXCLUDE, '\*\*\/\*\.int\.test\.ts'\]/);
  const byName = new Map(projects.map((p) => [p.name, p]));
  expect(arrays(read('test/vitest.config.ts'))[0]).toEqual(byName.get('spec-unit')?.include);
  expect(arrays(read('test/vitest.integration.config.ts'))[0]).toEqual(
    byName.get('spec-int')?.include,
  );
  expect(read('packages/testing/vitest.config.ts')).toContain('unitConfig()');
  expect(byName.get('testing-unit')?.include).toEqual(['src/**/*.test.ts']);
  for (const name of ['spec-unit', 'testing-unit']) {
    expect(byName.get(name)?.exclude).toEqual(['**/*.int.test.ts']);
  }
  expect(byName.get('spec-int')).toMatchObject({
    config: 'vitest.integration.config.ts',
    database: true,
  });
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
      files: ['spec/money/split.test.ts', 'properties/money/sum.test.ts'],
    },
    {
      name: 'spec-int',
      dir: 'test',
      config: 'vitest.integration.config.ts',
      database: true,
      files: ['spec/db/ledger.int.test.ts', 'acceptance/order.test.ts'],
    },
    {
      name: 'testing-unit',
      dir: 'packages/testing',
      config: 'vitest.config.ts',
      database: false,
      files: ['src/arb.test.ts'],
    },
  ]);
  expect(plan.unrunnable).toEqual(['test/replay/orders.test.ts', 'db/invariants/ledger.test.ts']);
});
