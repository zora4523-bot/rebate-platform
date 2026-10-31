import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  renderDeletionProgressMessage,
  writeDeletionProgressMessage,
  type DeletionProgressInput,
} from './deletion-progress-message.ts';

const SUBJECT = {
  app_id: 'couli',
  user_id: '019a3c00-0000-7000-8000-000000000001',
  deletion_request_id: '019a3c00-0000-7000-8000-0000000000aa',
} as const;

const clock = () => new FixedClock('2026-10-16T02:00:00.000Z');

/** A Kysely over a driver that records each statement and answers `rows(sql)`. */
function recordingDb(rows: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      return Promise.resolve({ rows: rows(query.sql) as R[] });
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const base = new DummyDriver();
  const driver: Driver = {
    init: () => base.init(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => base.destroy(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

it('[AC-B1-15i#61] 冷静期截止按 +08:00 格式化：同年 MM-DD HH:mm，跨年带年份', () => {
  const render = (now: string, deadline: string) =>
    renderDeletionProgressMessage(
      { ...SUBJECT, variant: 'requested', cancel_deadline: new Date(deadline) },
      null,
      new FixedClock(now),
    ).body;
  expect(render('2026-10-16T02:00:00.000Z', '2026-10-23T02:00:00.000Z')).toBe(
    '注销申请已提交，10-23 10:00 前可在「设置 → 账号与安全」撤回。',
  );
  expect(render('2026-12-28T03:00:00.000Z', '2027-01-04T03:00:00.000Z')).toBe(
    '注销申请已提交，2027-01-04 11:00 前可在「设置 → 账号与安全」撤回。',
  );
});

it('[AC-B1-15i#62] 覆盖正文里的 $ 按字面保留，{amount} 每处都填', () => {
  const message = renderDeletionProgressMessage(
    { ...SUBJECT, variant: 'cancelled_negative', amount_fen: 120n },
    { title_override: null, body_override: "$& $' {amount}/{amount}" },
    clock(),
  );
  expect(message).toMatchObject({ title: '注销进度', body: "$& $' ¥1.2/¥1.2" });
});

it('[AC-B1-15i#63] 待扣回金额不是正数、截止时间无效 → 拒绝渲染', () => {
  for (const amount_fen of [0n, -1n]) {
    expect(() =>
      renderDeletionProgressMessage(
        { ...SUBJECT, variant: 'cancelled_negative', amount_fen },
        null,
        clock(),
      ),
    ).toThrow('invalid amount');
  }
  expect(() =>
    renderDeletionProgressMessage(
      { ...SUBJECT, variant: 'requested', cancel_deadline: new Date(Number.NaN) },
      null,
      clock(),
    ),
  ).toThrow('invalid cancel_deadline');
});

it('[AC-B1-15i#64] 去重键已在日志里 → 答 false，不读模板、不写站内信', async () => {
  const { db, statements } = recordingDb(() => []);
  const input: DeletionProgressInput = { ...SUBJECT, variant: 'cancelled' };
  const written = await db
    .transaction()
    .execute((trx) => writeDeletionProgressMessage(trx, input, { clock: clock() }));
  expect(written).toBe(false);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatch(/insert into "app"\."notify_logs"/);
  expect(statements[0]).toMatch(/on conflict \("app_id", "dedupe_key"\) do nothing/);
});

it('[AC-B1-15i#65] 首次写：日志、模板、站内信三步都在调用方事务上，按此顺序', async () => {
  const { db, statements } = recordingDb((sql) =>
    sql.includes('"notify_logs"') ? [{ id: 'x' }] : [],
  );
  const written = await db
    .transaction()
    .execute((trx) =>
      writeDeletionProgressMessage(
        trx,
        { ...SUBJECT, variant: 'cancelled_negative', amount_fen: 1234n },
        { clock: clock() },
      ),
    );
  expect(written).toBe(true);
  expect(statements).toHaveLength(3);
  expect(statements[0]).toMatch(/insert into "app"\."notify_logs"/);
  expect(statements[1]).toMatch(/from "app"\."notify_templates"/);
  expect(statements[2]).toMatch(/insert into "app"\."inbox_messages"/);
});
