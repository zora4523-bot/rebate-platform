// dependency-cruiser rules (规划/02 §4.1, §12.7; 规划/11 §2.3, §4.1; ADR-0001 §2).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
// Run from the repo root: `pnpm depcruise`.

// An npm package either resolves to `.../node_modules/<name>/...` or, when it is not installed
// for the importing workspace package, stays unresolved as the bare specifier `<name>[/sub]`.
const npm = (name) => `(^|/node_modules/)${name}(/|$)`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular dependencies are not allowed anywhere.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'funds-packages-stay-pure',
      comment:
        'packages/money and packages/domain are pure: no app code, no database, no framework, ' +
        'no logger (规划/02 §4.1, §4.2).',
      severity: 'error',
      from: { path: '^packages/(money|domain)/' },
      to: {
        path: [
          '^apps/',
          '^packages/db/',
          npm('pg'),
          npm('kysely'),
          npm('pino'),
          '(^|/node_modules/)@nestjs/',
        ],
      },
    },
    {
      name: 'no-import-from-research',
      comment: 'docs/research/** is untrusted material and must never be imported (规划/02 §12.7).',
      severity: 'error',
      from: {},
      to: { path: '^docs/research/' },
    },
    {
      name: 'testcontainers-only-in-int-tests',
      comment:
        'Only *.int.test.ts files may import testcontainers or @couli/db/testing; unit tests and ' +
        'sources run inside the Codex sandbox without Docker or a database (规划/11 §2.3, §4.1). ' +
        'Exempt: the test-database implementation itself, the db scripts that need a one-shot ' +
        'database (snapshot / check), and integration Vitest configs.',
      severity: 'error',
      from: {
        pathNot: [
          '\\.int\\.test\\.ts$',
          '^packages/db/src/testing/',
          '^packages/db/scripts/',
          '(^|/)vitest\\.integration\\.config\\.ts$',
        ],
      },
      to: { path: [npm('testcontainers'), '^packages/db/src/testing/'] },
    },
    {
      name: 'modules-only-via-index',
      comment:
        'An API module may use another module only through its index.ts (规划/02 §4.1: single ' +
        'writer per table, no reaching into another module).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'pg-boss-only-behind-job-queue',
      comment:
        'Business code depends on the JobQueue interface; only the platform module and ' +
        'packages/db may import pg-boss (ADR-0001 §2).',
      severity: 'error',
      from: { pathNot: ['^apps/api/src/modules/platform/', '^packages/db/'] },
      to: { path: npm('pg-boss') },
    },
  ],
  options: {
    // Follow nothing inside node_modules, but keep the edges that point there (rules need them).
    doNotFollow: { path: ['node_modules'] },
    // Build output and scratch dirs of this repo only. The pattern is anchored so that it never
    // matches a path inside node_modules (many packages resolve to `<pkg>/dist/...`): excluded
    // modules disappear from the graph and the npm rules above would silently stop firing.
    exclude: {
      path: [
        '^(apps|packages)/[^/]+/(dist|coverage|\\.turbo|\\.tmp)/',
        '^(tools|test)/(dist|coverage|\\.turbo|\\.tmp)/',
        '^(dist|coverage|\\.turbo|\\.tmp)/',
      ],
    },
    // Type-only imports count as dependencies too.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      // `couli-src` makes workspace packages resolve to their TypeScript sources (conventions C4).
      conditionNames: ['couli-src', 'import', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.d.ts'],
    },
  },
};
