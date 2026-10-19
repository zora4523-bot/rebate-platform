import { expect, it } from 'vitest';
import {
  assertSingleStatement,
  orderInvariantFiles,
  readInvariantRows,
} from './daily-check-rows.ts';
import { LedgerError } from './errors.ts';

const sentinel = {
  invariant: '02',
  checked_rows: 4n,
  scope: 'none',
  app_id: null,
  account_id: null,
  detail: null,
};

it('[AC-B2-02j-UNIT#1] 文件按名称码位升序，不受传入顺序影响；重名拒绝', () => {
  const files = [
    { name: '10_b.sql', sql: 'SELECT 1' },
    { name: '07_a.sql', sql: 'SELECT 1' },
    { name: '01_c.sql', sql: 'SELECT 1' },
  ];
  expect(orderInvariantFiles(files).map((f) => f.name)).toEqual([
    '01_c.sql',
    '07_a.sql',
    '10_b.sql',
  ]);
  expect(files[0]?.name).toBe('10_b.sql');
  expect(() =>
    orderInvariantFiles([
      { name: 'x.sql', sql: 'SELECT 1' },
      { name: 'x.sql', sql: 'SELECT 2' },
    ]),
  ).toThrow(LedgerError);
});

it('[AC-B2-02j-UNIT#2] 单语句守卫：注释与字符串里的分号不算，语句列表拒绝', () => {
  expect(() => {
    assertSingleStatement({
      name: 'ok.sql',
      sql: '-- a; b\nSELECT \';\' AS x /* c; */ , "q;" FROM t;\n-- trailing; comment',
    });
  }).not.toThrow();
  expect(() => {
    assertSingleStatement({ name: 'bad.sql', sql: 'SELECT 1; COMMIT; UPDATE t SET x = 1' });
  }).toThrow(LedgerError);
  expect(() => {
    assertSingleStatement({ name: 'empty.sql', sql: '-- nothing\n' });
  }).toThrow(LedgerError);
});

it('[AC-B2-02j-UNIT#3] 干净哨兵行不报差异；checked_rows 取 bigint 原值', () => {
  expect(readInvariantRows('02.sql', [sentinel])).toEqual({
    invariant: '02',
    checkedRows: 4n,
    differences: [],
  });
  expect(readInvariantRows('02.sql', [{ ...sentinel, checked_rows: '0' }]).checkedRows).toBe(0n);
});

it('[AC-B2-02j-UNIT#4] 差异行保留 scope / app_id / account_id / detail', () => {
  const detail = { voucher_id: 'v', actual_sum_fen: '1' };
  const outcome = readInvariantRows('07.sql', [
    {
      invariant: '07',
      checked_rows: 2n,
      scope: 'account',
      app_id: 'a',
      account_id: 'acc',
      detail,
    },
    { invariant: '07', checked_rows: 2n, scope: 'global', app_id: 'b', account_id: null, detail },
  ]);
  expect(outcome.differences).toEqual([
    { invariant: '07', scope: 'account', app_id: 'a', account_id: 'acc', detail },
    { invariant: '07', scope: 'global', app_id: 'b', account_id: null, detail },
  ]);
});

it('[AC-B2-02j-UNIT#5] 违反输出约定的结果判失败，不当作零差异', () => {
  const bad: unknown[] = [
    [],
    undefined,
    [{ ...sentinel, checked_rows: 1 }],
    [{ ...sentinel, checked_rows: -1n }],
    [{ ...sentinel, scope: 'other' }],
    [{ ...sentinel, invariant: '' }],
    [sentinel, { ...sentinel, checked_rows: 5n }],
    [sentinel, { ...sentinel, invariant: '03' }],
    [{ ...sentinel, scope: 'account', app_id: 'a', account_id: null, detail: {} }],
    [{ ...sentinel, scope: 'global', app_id: null, detail: {} }],
  ];
  for (const rows of bad) {
    expect(() => readInvariantRows('x.sql', rows)).toThrow(
      expect.objectContaining({ code: 'DAILY_CHECK_FAILED' }),
    );
  }
});
