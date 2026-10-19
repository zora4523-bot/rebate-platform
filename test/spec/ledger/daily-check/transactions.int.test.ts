import { createTestDatabase } from '@couli/db/testing';
import { sql, type KyselyPlugin } from 'kysely';
import { expect, it } from 'vitest';
import { APP, DAY, TIMEOUT, account, balance, immutableState, inDatabase, setup } from './kit.ts';

// Test SQL probes actual PostgreSQL transaction state, not mocked query results.
function probe(code: string) {
  return {
    name: `${code}_probe.sql`,
    sql: `SELECT '${code}'::text AS invariant, 7::bigint AS checked_rows,
      'global'::text AS scope, '${APP}'::text AS app_id, NULL::uuid AS account_id,
      jsonb_build_object('probe', '${code}',
        'date', current_setting('couli.check_date'),
        'read_only', current_setting('transaction_read_only'),
        'transaction', txid_current()::text) AS detail`,
  };
}

// A domain error may preserve the PG error anywhere in its cause chain.
function sqlState(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  while (typeof error === 'object' && error !== null && !visited.has(error)) {
    visited.add(error);
    if ('code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
      return error.code;
    }
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

it(
  '[AC-B2-02j#11] 文件按名称逐个执行，每个在独立只读事务中取得指定 check_date',
  async () => {
    const files = [probe('30'), probe('10'), probe('20')];
    const { runner } = setup({
      async load() {
        return files;
      },
    });
    await inDatabase(createTestDatabase, async (db) => {
      const completed: string[] = [];
      const observer: KyselyPlugin = {
        transformQuery(args) {
          return args.node;
        },
        async transformResult(args) {
          for (const row of args.result.rows) {
            const detail = (row as { detail?: { probe?: string } }).detail;
            if (detail?.probe) completed.push(detail.probe);
          }
          return args.result;
        },
      };
      const result = await runner.runDailyCheck(db.withPlugin(observer), { accountingDate: DAY });
      // Observe database results, independent of raw SQL node layout or query-builder syntax.
      // The single connection executes each probe before the next transaction can acquire it.
      expect(completed).toEqual(['10', '20', '30']);
      expect(result.checks.map((c) => c.file)).toEqual([
        '10_probe.sql',
        '20_probe.sql',
        '30_probe.sql',
      ]);
      expect(result.checks.map((c) => c.checkedRows)).toEqual([7n, 7n, 7n]);
      expect(result.globalDifferences).toHaveLength(3);
      const details = result.globalDifferences.map((d) => d.detail as Record<string, unknown>);
      expect(details).toEqual([
        { probe: '10', date: DAY, read_only: 'on', transaction: expect.any(String) },
        { probe: '20', date: DAY, read_only: 'on', transaction: expect.any(String) },
        { probe: '30', date: DAY, read_only: 'on', transaction: expect.any(String) },
      ]);
      expect(new Set(details.map((d) => d['transaction'])).size).toBe(3);
      const session = await sql<{ date: string | null; read_only: string }>`SELECT
      nullif(current_setting('couli.check_date', true), '') AS date,
      current_setting('transaction_read_only') AS read_only`.execute(db);
      expect(session.rows).toEqual([{ date: null, read_only: 'off' }]);
      const next = await runner.runDailyCheck(db, { accountingDate: '2032-06-14' });
      expect(next.globalDifferences.map((d) => d.detail)).toEqual([
        expect.objectContaining({ date: '2032-06-14', read_only: 'on' }),
        expect.objectContaining({ date: '2032-06-14', read_only: 'on' }),
        expect.objectContaining({ date: '2032-06-14', read_only: 'on' }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#12] 不变量误带 UPDATE 被 PG 只读事务拒绝，不能悄悄改余额或返回校验成功',
  async () => {
    const { runner } = setup({
      async load() {
        return [
          {
            name: '01_write-attempt.sql',
            sql: `
        WITH changed AS (
          UPDATE app.account_balances SET available_fen = 999 WHERE app_id = '${APP}' RETURNING account_id
        )
        SELECT '01'::text AS invariant, count(*)::bigint AS checked_rows,
          'none'::text AS scope, NULL::text AS app_id, NULL::uuid AS account_id, NULL::jsonb AS detail
        FROM changed`,
          },
        ];
      },
    });
    await inDatabase(createTestDatabase, async (db) => {
      await balance(db, await account(db, { app_id: APP }), 0n);
      const before = await immutableState(db);
      const outcome = await runner.runDailyCheck(db, { accountingDate: DAY }).then(
        () => ({ succeeded: true, error: undefined }),
        (error: unknown) => ({ succeeded: false, error }),
      );
      expect(outcome.succeeded).toBe(false);
      expect(sqlState(outcome.error)).toBe('25006');
      expect(await immutableState(db)).toEqual(before);
      // The failed transaction must be rolled back and released, not poison the only connection.
      expect((await sql<{ value: number }>`SELECT 1 AS value`.execute(db)).rows).toEqual([
        { value: 1 },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#13] SQL 执行失败不能伪装零差异，回滚后 check_date 不泄漏',
  async () => {
    const { runner } = setup({
      async load() {
        return [{ name: '01_broken.sql', sql: 'SELECT 1 / 0' }];
      },
    });
    await inDatabase(createTestDatabase, async (db) => {
      const outcome = await runner.runDailyCheck(db, { accountingDate: DAY }).then(
        () => ({ succeeded: true, error: undefined }),
        (error: unknown) => ({ succeeded: false, error }),
      );
      expect(outcome.succeeded).toBe(false);
      expect(sqlState(outcome.error)).toBe('22012');
      const session = await sql<{ date: string | null; read_only: string }>`SELECT
      nullif(current_setting('couli.check_date', true), '') AS date,
      current_setting('transaction_read_only') AS read_only`.execute(db);
      expect(session.rows).toEqual([{ date: null, read_only: 'off' }]);
    });
  },
  TIMEOUT,
);
