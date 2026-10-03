import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../../lib/paths.ts';
import { cleanupFixtures, makeTree } from './fixture-kit.ts';
import { loadProtected } from './protected.ts';
import * as fx from './test-guard.fixtures.ts';
import {
  addOnlyViolations,
  isFundsTestFile,
  scanFile,
  scanTree,
  testTitles,
} from './test-guard.ts';

afterAll(cleanupFixtures);

function rules(file: string, text: string): string[] {
  return scanFile(file, text).map((f) => f.rule);
}

describe('test files', () => {
  const unit = 'packages/money/src/round.test.ts';
  const integration = 'packages/db/src/ledger.int.test.ts';

  it.each([
    ['skipped test', fx.SKIPPED_TEST],
    ['focused suite', fx.FOCUSED_TEST],
    ['chained skip', fx.CHAINED_SKIP],
    ['conditional skip', fx.CONDITIONAL_SKIP],
    ['todo', fx.TODO_TEST],
    ['x-prefixed test', fx.X_PREFIXED_TEST],
    ['skip through the test context', fx.CONTEXT_SKIP],
  ])('flags a %s', (_name, text) => {
    expect(rules(unit, text)).toEqual(['no-skip-only']);
    expect(rules(integration, text)).toEqual(['no-skip-only']);
  });

  it('flags retry options but accepts an explicit zero', () => {
    expect(rules(unit, fx.RETRY_OPTION)).toEqual(['no-retry']);
    expect(rules(unit, fx.RETRY_SHORTHAND)).toEqual(['no-retry']);
    expect(rules(unit, fx.RETRY_ZERO)).toEqual([]);
  });

  it('keeps refusing any retry key in funds and attribution test files', () => {
    for (const file of [
      unit,
      'packages/domain/src/settle.test.ts',
      'apps/api/src/modules/ledger/post.test.ts',
      'apps/api/src/modules/withdrawals/request.test.ts',
      'test/spec/money/round.test.ts',
      'test/properties/money/split.prop.test.ts',
      'test/spec/payout/timeout.test.ts',
      'test/acceptance/search.test.ts',
      'test/replay/orders.test.ts',
    ]) {
      expect(isFundsTestFile(file)).toBe(true);
      expect(scanFile(file, fx.RETRY_FIELD).filter((f) => f.rule === 'no-retry')).toHaveLength(5);
    }
  });

  describe('other test files: only Vitest retry options', () => {
    const files = [
      'apps/api/src/modules/platform/http/http.test.ts',
      'test/spec/platform/http/policy.test.ts',
      'tools/agent/dispatch.test.ts',
    ];

    it('accepts retry as an ordinary field name', () => {
      for (const file of files) {
        expect(isFundsTestFile(file)).toBe(false);
        expect(rules(file, fx.RETRY_FIELD)).toEqual([]);
      }
    });

    it('flags the retry option of it, test, describe and suite, with their modifiers', () => {
      const [file = ''] = files;
      expect(rules(file, fx.RETRY_OPTION)).toEqual(['no-retry']);
      expect(rules(file, fx.RETRY_SHORTHAND)).toEqual(['no-retry']);
      expect(rules(file, fx.RETRY_ZERO)).toEqual([]);
      expect(scanFile(file, fx.RETRY_OPTION_MULTILINE).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '5:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_OPTION_CHAINS).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '1:no-retry',
        '2:no-retry',
        '3:no-retry',
        '4:no-retry',
        '6:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_NESTED).map((f) => f.line)).toEqual([2]);
    });

    it('flags the retry option of extended and imported test functions', () => {
      const [file = ''] = files;
      expect(scanFile(file, fx.RETRY_EXTENDED_TEST).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '2:no-retry',
      ]);
      expect(scanFile(file, fx.RETRY_IMPORTED_TEST).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '2:no-retry',
      ]);
    });

    it('reads options kept in a local object and refuses options it cannot read', () => {
      const [file = ''] = files;
      expect(rules(file, fx.OPTIONS_VARIABLE_LOCAL)).toEqual([]);
      expect(scanFile(file, fx.OPTIONS_VARIABLE_RETRY).map((f) => `${f.line}:${f.rule}`)).toEqual([
        '1:no-retry',
      ]);
      expect(
        scanFile(file, fx.OPTIONS_VARIABLE_IMPORTED).map((f) => `${f.line}:${f.rule}`),
      ).toEqual(['2:no-retry']);
      expect(rules(file, fx.OPTIONS_SPREAD)).toEqual(['no-retry']);
    });
  });

  it('keeps the superuser URL out of test files, except to assert it is absent', () => {
    expect(rules(unit, fx.ADMIN_URL_READ)).toEqual(['admin-url-only-in-global-setup']);
    expect(rules(integration, fx.ADMIN_URL_READ)).toEqual(['admin-url-only-in-global-setup']);
    expect(rules(integration, fx.ADMIN_URL_ABSENT)).toEqual([]);
    expect(rules(integration, fx.ADMIN_URL_ABSENT_AND_READ)).toEqual([
      'admin-url-only-in-global-setup',
    ]);
  });

  it.each([
    ['pg', fx.IMPORT_PG],
    ['a pg subpath', fx.IMPORT_PG_SUBPATH],
    ['pg-boss through dynamic import', fx.IMPORT_PG_BOSS],
    ['testcontainers', fx.IMPORT_TESTCONTAINERS],
    ['a testcontainers module', fx.IMPORT_TESTCONTAINERS_MODULE],
    ['@couli/db/testing', fx.IMPORT_DB_TESTING],
    ['pg through require', fx.REQUIRE_PG],
  ])('forbids %s in unit tests only', (_name, text) => {
    expect(rules(unit, text)).toEqual(['unit-no-db']);
    expect(rules(integration, text)).toEqual([]);
  });

  it('does not confuse similarly named modules', () => {
    expect(rules(unit, fx.IMPORT_HARMLESS)).toEqual([]);
  });

  it('forbids listening on a port in unit tests only', () => {
    expect(rules(unit, fx.LISTEN)).toEqual(['unit-no-listen']);
    expect(rules(integration, fx.LISTEN)).toEqual([]);
  });

  it('reports file and line', () => {
    expect(scanFile(unit, `\n\n${fx.SKIPPED_TEST}`)).toEqual([
      {
        file: unit,
        line: 3,
        rule: 'no-skip-only',
        message: 'tests must not be skipped, focused or left as todo',
      },
    ]);
  });

  it('ignores files that are not tests', () => {
    expect(
      rules('packages/money/src/round.ts', fx.SKIPPED_TEST + fx.IMPORT_PG + fx.LISTEN),
    ).toEqual([]);
  });
});

describe('vitest configs and package scripts', () => {
  it('accepts the strict settings', () => {
    expect(rules('vitest.shared.ts', fx.CONFIG_STRICT)).toEqual([]);
    expect(rules('tools/vitest.config.ts', fx.CONFIG_STRICT)).toEqual([]);
  });

  it('flags retry, passWithNoTests and allowOnly', () => {
    expect(rules('test/vitest.longrun.config.ts', fx.CONFIG_RETRY)).toEqual(['no-retry']);
    expect(rules('packages/db/vitest.integration.config.ts', fx.CONFIG_PASS_EMPTY)).toEqual([
      'no-pass-with-no-tests',
    ]);
    expect(rules('vitest.shared.ts', fx.CONFIG_ALLOW_ONLY)).toEqual(['no-skip-only']);
  });

  it('flags weakening flags in package scripts and reports the line', () => {
    const text = JSON.stringify(
      {
        name: 'x',
        scripts: {
          build: 'tsc -b',
          test: 'vitest run --passWithNoTests',
          'test:int': 'vitest run --retry=2',
        },
      },
      null,
      2,
    );
    const findings = scanFile('packages/x/package.json', text);
    expect(findings.map((f) => `${f.line}:${f.rule}`)).toEqual([
      '5:no-pass-with-no-tests',
      '6:no-pass-with-no-tests',
    ]);
    expect(rules('package.json', JSON.stringify({ scripts: { test: 'vitest run' } }))).toEqual([]);
    expect(rules('package.json', '{ nope')).toEqual(['package-json']);
  });
});

describe('rule tests under test/spec and test/properties', () => {
  it('forbids describe blocks', () => {
    expect(rules('test/spec/money/round.test.ts', fx.DESCRIBE_BLOCK)).toEqual([
      'rule-tests-top-level-it',
    ]);
    expect(rules('test/properties/split.test.ts', fx.DESCRIBE_EACH)).toEqual([
      'rule-tests-top-level-it',
    ]);
    expect(rules('test/spec/money/round.test.ts', fx.TOP_LEVEL_IT)).toEqual([]);
    expect(rules('packages/money/src/round.test.ts', fx.DESCRIBE_BLOCK)).toEqual([]);
  });

  it('forbids mocking the money package and the ledger', () => {
    expect(rules('test/spec/a.test.ts', fx.MOCK_MONEY)).toEqual(['rule-tests-no-funds-mock']);
    expect(rules('test/spec/a.test.ts', fx.MOCK_MONEY_RELATIVE)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
    expect(rules('test/properties/a.test.ts', fx.MOCK_LEDGER)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
    expect(rules('test/spec/a.test.ts', fx.MOCK_OTHER)).toEqual([]);
    expect(rules('test/spec/reference/split.ref.ts', fx.MOCK_MONEY)).toEqual([
      'rule-tests-no-funds-mock',
    ]);
  });
});

describe('acceptance tests', () => {
  const file = 'test/acceptance/search.test.ts';

  it('requires an AC id in every title', () => {
    expect(rules(file, fx.AC_TITLED + fx.AC_TITLED_SUFFIX + fx.AC_EACH_TITLED)).toEqual([]);
    expect(rules(file, fx.AC_UNTITLED)).toEqual(['acceptance-title']);
    expect(rules(file, fx.AC_EACH_UNTITLED)).toEqual(['acceptance-title']);
    expect(rules(file, fx.AC_DYNAMIC_TITLE)).toEqual(['acceptance-title']);
    expect(rules('test/spec/search.test.ts', fx.AC_UNTITLED)).toEqual([]);
  });

  it('extracts titles with their lines', () => {
    expect(testTitles(`${fx.AC_TITLED}\n${fx.AC_EACH_TITLED}${fx.AC_DYNAMIC_TITLE}`)).toEqual([
      { line: 1, title: '[AC-S1-03] 搜索返回商品卡片' },
      { line: 3, title: '[AC-S1-04] page %i' },
      { line: 4, title: null },
    ]);
  });
});

describe('scanTree', () => {
  it('reads only the relevant files of a tree', () => {
    const root = makeTree({
      'packages/a/src/a.test.ts': fx.SKIPPED_TEST,
      'packages/a/src/a.ts': fx.SKIPPED_TEST,
      'packages/a/package.json': JSON.stringify({
        scripts: { test: 'vitest run --passWithNoTests' },
      }),
      'vitest.shared.ts': fx.CONFIG_RETRY,
      'test/spec/b.test.ts': fx.DESCRIBE_BLOCK,
      'docs/readme.md': fx.SKIPPED_TEST,
    });
    const files = [
      'docs/readme.md',
      'packages/a/package.json',
      'packages/a/src/a.test.ts',
      'packages/a/src/a.ts',
      'test/spec/b.test.ts',
      'vitest.shared.ts',
    ];
    expect(scanTree(root, files).map((f) => `${f.file}:${f.rule}`)).toEqual([
      'packages/a/package.json:no-pass-with-no-tests',
      'packages/a/src/a.test.ts:no-skip-only',
      'test/spec/b.test.ts:rule-tests-top-level-it',
      'vitest.shared.ts:no-retry',
    ]);
  });
});

describe('addOnlyViolations', () => {
  it('reports modified, deleted and renamed test assets but not new ones', () => {
    const cfg = loadProtected(repoRoot());
    const hits = addOnlyViolations(
      [
        { path: 'test/spec/money/new.test.ts', status: '?' },
        { path: 'test/spec/money/round.test.ts', status: 'M' },
        { path: 'test/replay/case-1.json', status: 'D' },
        { path: 'tools/guard/run.ts', status: 'M' },
      ],
      cfg,
    );
    expect(hits.map((h) => h.path)).toEqual([
      'test/replay/case-1.json',
      'test/spec/money/round.test.ts',
    ]);
  });
});
