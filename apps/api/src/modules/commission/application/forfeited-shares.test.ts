// Unit tests of listBannedForfeitedShares (B1-03z): no database; a fake Kysely driver answers each
// statement by its SQL text and records it.
import type { DB } from '@couli/db';
import {
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
import { findBannedRunStart, listBannedForfeitedShares } from './forfeited-shares.ts';

type Answer = (query: CompiledQuery) => QueryResult<unknown> | undefined;

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly answer: Answer,
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return (this.answer(query) ?? { rows: [] }) as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

function fakeDb(answer: Answer): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection = new FakeConnection(answer, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const O1 = '019a0000-0000-7000-8000-000000000001';
const O2 = '019a0000-0000-7000-8000-000000000002';
const SINCE = new Date('2026-09-10T00:00:00.000Z');
const UNTIL = new Date('2026-09-25T01:00:00.000Z');
const T1 = new Date('2026-09-12T00:00:00.000Z');
const T2 = new Date('2026-09-15T00:00:00.000Z');

const KEYS = [
  { order_id: O1, platform: 'taobao', sub_order_id: '5550001' },
  { order_id: O2, platform: 'pdd', sub_order_id: '7770002' },
];

function answers(events: unknown[], amounts: unknown[], keys: unknown[] = KEYS): Answer {
  return (query) => {
    if (query.sql.includes('"commission_split_beneficiary_events"')) return { rows: events };
    if (query.sql.includes('"commission_split_amounts"')) return { rows: amounts };
    if (query.sql.includes('"order_keys"')) return { rows: keys };
    return undefined;
  };
}

const input = { appId: APP, userId: USER, since: SINCE, until: UNTIL };

it('[B1-03z] 只查 reason=banned 的 forfeited 事件、窗口两端含；份额值取该份额最大 commission_version 的快照；按没收时刻、订单、角色排序', async () => {
  const { db, queries } = fakeDb(
    answers(
      [
        { order_id: O2, role: 'direct', forfeited_at: T2 },
        { order_id: O1, role: 'self', forfeited_at: T1 },
        { order_id: O1, role: 'direct', forfeited_at: T1 },
      ],
      [
        { order_id: O1, role: 'self', commission_version: 1, amount_fen: 425n },
        { order_id: O1, role: 'self', commission_version: 3, amount_fen: 400n },
        { order_id: O1, role: 'self', commission_version: 2, amount_fen: 410n },
        { order_id: O1, role: 'direct', commission_version: 1, amount_fen: 85n },
        { order_id: O2, role: 'direct', commission_version: 1, amount_fen: 70n },
      ],
    ),
  );
  const shares = await listBannedForfeitedShares(db, input);
  expect(shares).toStrictEqual([
    { orderId: O1, orderKey: 'taobao:5550001', role: 'direct', amountFen: 85n, forfeitedAt: T1 },
    { orderId: O1, orderKey: 'taobao:5550001', role: 'self', amountFen: 400n, forfeitedAt: T1 },
    { orderId: O2, orderKey: 'pdd:7770002', role: 'direct', amountFen: 70n, forfeitedAt: T2 },
  ]);
  expect(queries).toHaveLength(3);
  const events = queries[0]!;
  expect(events.sql).toContain('"app"."commission_split_beneficiary_events"');
  expect(events.sql).toContain('"created_at" >= $');
  expect(events.sql).toContain('"created_at" <= $');
  expect(events.sql).toContain('max("created_at")');
  expect(events.parameters).toEqual([APP, USER, 'forfeited', 'banned', SINCE, UNTIL]);
  expect(queries.every((q) => /^select /i.test(q.sql))).toBe(true);
});

it('[B1-03z] 没有符合条件的事件 → 空数组，不再查快照', async () => {
  const { db, queries } = fakeDb(answers([], []));
  expect(await listBannedForfeitedShares(db, input)).toEqual([]);
  expect(queries).toHaveLength(1);
});

it('[B1-03z] 被没收的份额找不到快照金额 → 抛错（不按 0 登记）', async () => {
  const { db } = fakeDb(answers([{ order_id: O1, role: 'self', forfeited_at: T1 }], []));
  await expect(listBannedForfeitedShares(db, input)).rejects.toThrow(
    'forfeited share without a split snapshot amount',
  );
});

it('[B1-03z] 份额找不到订单键 → 抛错', async () => {
  const { db } = fakeDb(
    answers(
      [{ order_id: O1, role: 'self', forfeited_at: T1 }],
      [{ order_id: O1, role: 'self', commission_version: 1, amount_fen: 425n }],
      [],
    ),
  );
  await expect(listBannedForfeitedShares(db, input)).rejects.toThrow('without an order key');
});

const CREATED = new Date('2026-11-30T00:00:00.000Z');

function events(rows: Array<[string, string | null, string]>): Answer {
  // The fake answers in the query's order (created_at desc, event_seq desc).
  return () => ({
    rows: rows.map(([status, reason, at]) => ({ status, reason, created_at: new Date(at) })),
  });
}

it('[B1-03z 存量申诉] 同一批次连续三份 banned 没收（不同时刻）→ 起点是三份里最早那份', async () => {
  const { db, queries } = fakeDb(
    events([
      ['forfeited', 'banned', '2026-11-24T01:00:00.300Z'],
      ['forfeited', 'banned', '2026-11-24T01:00:00.200Z'],
      ['forfeited', 'banned', '2026-11-24T01:00:00.100Z'],
      ['active', null, '2026-10-01T00:00:00.000Z'],
      ['forfeited', 'banned', '2026-09-24T01:00:00.000Z'],
    ]),
  );
  const start = await findBannedRunStart(db, {
    appId: APP,
    userId: USER,
    until: CREATED,
    notBefore: null,
  });
  expect(start).toEqual(new Date('2026-11-24T01:00:00.100Z'));
  expect(queries).toHaveLength(1);
  expect(queries[0]?.sql).toContain('order by "created_at" desc, "event_seq" desc');
  expect(queries[0]?.sql).not.toContain('"created_at" > $');
});

it('[B1-03z 存量申诉] held 事件、deleted / minor 没收打断连续段；段之后的 active 事件跳过', async () => {
  for (const breaker of [
    ['held', null],
    ['forfeited', 'deleted'],
    ['forfeited', 'minor'],
  ] as const) {
    const { db } = fakeDb(
      events([
        ['active', null, '2026-11-26T00:00:00.000Z'],
        ['forfeited', 'banned', '2026-11-24T01:00:00.300Z'],
        ['forfeited', 'banned', '2026-11-24T01:00:00.200Z'],
        [breaker[0], breaker[1], '2026-11-24T01:00:00.150Z'],
        ['forfeited', 'banned', '2026-11-24T01:00:00.100Z'],
      ]),
    );
    expect(
      await findBannedRunStart(db, { appId: APP, userId: USER, until: CREATED, notBefore: null }),
    ).toEqual(new Date('2026-11-24T01:00:00.200Z'));
  }
});

it('[B1-03z 存量申诉] 没有 banned 没收 → null；notBefore 作为排他下界进入查询', async () => {
  const notBefore = new Date('2026-10-01T00:00:00.000Z');
  const { db, queries } = fakeDb(events([['active', null, '2026-11-01T00:00:00.000Z']]));
  expect(
    await findBannedRunStart(db, { appId: APP, userId: USER, until: CREATED, notBefore }),
  ).toBeNull();
  expect(queries[0]?.sql).toContain('"created_at" > $');
  expect(queries[0]?.parameters).toEqual([APP, USER, CREATED, notBefore]);
});
