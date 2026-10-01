// Proves that every rule in .dependency-cruiser.cjs can fail: builds a small fixture tree with one
// offending import per rule (plus allowed counterparts) and runs the real config against it.
// Guards against a silent weakening such as an `exclude` pattern that also drops node_modules
// paths, which would stop the npm rules from firing without any error.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');
const FIXTURE = join(REPO, '.tmp', `ci-depcruise-rules-${process.pid}`);

// Fixture sources are assembled by these helpers so that this test file itself contains no
// literal import of pg, pg-boss or testcontainers (the test guard scans unit tests for them).
const imp = (...specifiers: string[]): string =>
  specifiers.map((specifier) => `import '${specifier}';\n`).join('');
const reexport = (specifier: string): string => `export * from '${specifier}';\n`;

// path -> source. Relative imports carry the .ts extension, as everywhere in this repo.
const FILES: Record<string, string> = {
  'docs/research/note.ts': 'export const note = 1;\n',
  // funds packages
  'packages/money/src/pure.ts': 'export const pure = 1;\n',
  'packages/money/src/bad-pg.ts': imp('pg'),
  'packages/money/src/bad-kysely.ts': imp('kysely'),
  'packages/money/src/bad-nest.ts': imp('@nestjs/common'),
  'packages/domain/src/ok-money.ts': imp('../../money/src/pure.ts'),
  'packages/domain/src/bad-app.ts': imp('../../../apps/api/src/modules/a/index.ts'),
  'packages/domain/src/bad-db.ts': imp('../../db/src/index.ts'),
  'packages/domain/src/bad-pino.ts': imp('pino'),
  // db package: may use pg-boss and owns the test-database helpers
  'packages/db/src/index.ts': 'export const db = 1;\n',
  'packages/db/src/queue.ts': imp('pg-boss'),
  'packages/db/src/testing/index.ts': imp('testcontainers'),
  'packages/db/scripts/snapshot.ts': imp('../src/testing/index.ts'),
  // API modules
  'apps/api/src/modules/a/index.ts': reexport('./internal.ts'),
  'apps/api/src/modules/a/internal.ts': 'export const internal = 1;\n',
  'apps/api/src/modules/b/ok.ts': imp('../a/index.ts'),
  'apps/api/src/modules/b/bad.ts': imp('../a/internal.ts'),
  'apps/api/src/modules/b/queue.ts': imp('pg-boss'),
  'apps/api/src/modules/platform/queue.ts': imp('pg-boss'),
  // testcontainers and @couli/db/testing
  'packages/x/src/unit.test.ts': imp('testcontainers'),
  'packages/x/src/db.int.test.ts': imp('testcontainers', '../../db/src/testing/index.ts'),
  'packages/x/src/uses-testing.ts': imp('../../db/src/testing/index.ts'),
  // cycles and untrusted research material
  'packages/x/src/cycle-a.ts': imp('./cycle-b.ts'),
  'packages/x/src/cycle-b.ts': imp('./cycle-a.ts'),
  'packages/x/src/research.ts': imp('../../../docs/research/note.ts'),
  // npm packages that DO resolve (node_modules symlinked below): the rules must match the
  // resolved `.../node_modules/<name>/...` form as well as the bare specifier
  'packages/y/src/resolved.test.ts': imp('testcontainers', 'pg-boss'),
};

const EXPECTED = [
  'funds-packages-stay-pure packages/domain/src/bad-app.ts',
  'funds-packages-stay-pure packages/domain/src/bad-db.ts',
  'funds-packages-stay-pure packages/domain/src/bad-pino.ts',
  'funds-packages-stay-pure packages/money/src/bad-kysely.ts',
  'funds-packages-stay-pure packages/money/src/bad-nest.ts',
  'funds-packages-stay-pure packages/money/src/bad-pg.ts',
  'modules-only-via-index apps/api/src/modules/b/bad.ts',
  'no-circular packages/x/src/cycle-*.ts',
  'no-import-from-research packages/x/src/research.ts',
  'pg-boss-only-behind-job-queue apps/api/src/modules/b/queue.ts',
  'pg-boss-only-behind-job-queue packages/y/src/resolved.test.ts',
  'testcontainers-only-in-int-tests packages/x/src/unit.test.ts',
  'testcontainers-only-in-int-tests packages/x/src/uses-testing.ts',
  'testcontainers-only-in-int-tests packages/y/src/resolved.test.ts',
];

type Violation = { from: string; to: string; rule: { name: string } };

let violations: Violation[] = [];
let stderr = '';
let exitStatusAsInRootScript: number | null = null;

function depcruise(extraArgs: string[]) {
  return spawnSync(
    join(REPO, 'node_modules/.bin/depcruise'),
    ['--config', join(REPO, '.dependency-cruiser.cjs'), ...extraArgs, 'apps', 'packages'],
    { cwd: FIXTURE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

beforeAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  for (const [path, source] of Object.entries(FILES)) {
    mkdirSync(dirname(join(FIXTURE, path)), { recursive: true });
    writeFileSync(join(FIXTURE, path), source);
  }
  cpSync(join(REPO, 'tsconfig.base.json'), join(FIXTURE, 'tsconfig.base.json'));
  // Real installed packages: pg, kysely, pg-boss and testcontainers are dependencies of @couli/db.
  for (const pkg of ['money', 'y']) {
    symlinkSync(
      join(REPO, 'packages/db/node_modules'),
      join(FIXTURE, 'packages', pkg, 'node_modules'),
    );
  }
  const json = depcruise(['--output-type', 'json']);
  stderr = json.stderr;
  const report = JSON.parse(json.stdout) as { summary: { violations: Violation[] } };
  violations = report.summary.violations;
  // Same invocation as the root `depcruise` script (default reporter): this one sets the exit code.
  exitStatusAsInRootScript = depcruise([]).status;
}, 180_000);

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
});

it('reports exactly the offending files, one rule each, and exits non-zero', () => {
  // A cycle is reported once, from whichever member comes first: fold both names into one.
  const actual = [
    ...new Set(
      violations.map((v) => `${v.rule.name} ${v.from.replace(/cycle-[ab]\.ts$/, 'cycle-*.ts')}`),
    ),
  ].sort();
  expect(stderr).toBe('');
  expect(actual).toEqual(EXPECTED);
  expect(exitStatusAsInRootScript).toBeGreaterThan(0);
});

it('matches npm packages in their resolved node_modules form too', () => {
  const resolved = violations
    .filter((v) => v.from === 'packages/money/src/bad-pg.ts' || v.from.startsWith('packages/y/'))
    .map((v) => v.to);
  expect(resolved.length).toBe(3);
  expect(resolved.every((to) => to.includes('/node_modules/'))).toBe(true);
});
