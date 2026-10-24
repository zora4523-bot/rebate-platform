// Unit tests of readCommissionAttribution (B2-04q r3): no database; a fake Kysely driver answers
// each statement by its SQL text and records it.
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
import { readCommissionAttribution } from './read-attribution.ts';

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
const ORDER = '019a0000-0000-7000-8000-000000000001';
const SELF = '019a0000-0000-7000-8000-0000000000a1';
const DIRECT = '019a0000-0000-7000-8000-0000000000a2';
const RULE = '019a0000-0000-7000-8000-0000000000e1';

const SPLIT = {
  rule_version_id: RULE,
  reserve_bp: 1500,
  beneficiaries: [
    {
      user_id: SELF,
      role: 'self',
      ratio_bp: 5000,
      level: 'L1',
      initial_status: 'active',
      forfeit_reason: null,
    },
    {
      user_id: DIRECT,
      role: 'direct',
      ratio_bp: 1000,
      level: 'L2',
      initial_status: 'active',
      forfeit_reason: null,
    },
  ],
};

function answer(split: unknown): Answer {
  return (q) => {
    if (/from "app"."commission_splits"/.test(q.sql)) {
      return { rows: split === undefined ? [] : [split] };
    }
    if (/from "app"."commission_split_beneficiary_events"/.test(q.sql)) {
      return { rows: [{ event_seq: 7n, user_id: DIRECT, role: 'direct', reason: 'banned' }] };
    }
    return undefined;
  };
}

it('[AC-B2-04q] readCommissionAttribution: reserve ratio, beneficiaries and forfeited events from commission_splits and the event table only — no amount version is read, so a bumped orders.commission_version cannot make it fail', async () => {
  const { db, queries } = fakeDb(answer(SPLIT));
  const result = await db
    .transaction()
    .execute((trx) => readCommissionAttribution(trx, { appId: APP, orderId: ORDER }));
  expect(result).toEqual({
    appId: APP,
    orderId: ORDER,
    ruleVersionId: RULE,
    reserveBp: 1500,
    beneficiaries: [
      {
        userId: SELF,
        role: 'self',
        ratioBp: 5000,
        level: 'L1',
        initialStatus: 'active',
        forfeitReason: null,
      },
      {
        userId: DIRECT,
        role: 'direct',
        ratioBp: 1000,
        level: 'L2',
        initialStatus: 'active',
        forfeitReason: null,
      },
    ],
    forfeitedEvents: [{ eventSeq: 7n, userId: DIRECT, role: 'direct', reason: 'banned' }],
  });
  const reads = queries.map((q) => q.sql).filter((s) => s.startsWith('select'));
  expect(reads).toHaveLength(2);
  for (const s of reads) {
    expect(s).not.toMatch(/commission_split_(totals|amounts)|"orders"|now\(\)|for (update|share)/i);
  }
  for (const q of queries) expect(q.parameters).toEqual(expect.arrayContaining([APP, ORDER]));
});

it('[AC-B2-04q] readCommissionAttribution: no commission_splits row throws (never an empty attribution)', async () => {
  const { db } = fakeDb(answer(undefined));
  await expect(
    db
      .transaction()
      .execute((trx) => readCommissionAttribution(trx, { appId: APP, orderId: ORDER })),
  ).rejects.toThrow('no commission snapshot');
});

it('[AC-B2-04q] readCommissionAttribution: malformed stored beneficiaries throw instead of being skipped', async () => {
  const { db } = fakeDb(answer({ ...SPLIT, beneficiaries: [{ user_id: SELF, role: 'self' }] }));
  await expect(
    db
      .transaction()
      .execute((trx) => readCommissionAttribution(trx, { appId: APP, orderId: ORDER })),
  ).rejects.toThrow(TypeError);
});

it('[AC-B2-04q] readCommissionAttribution: empty appId or orderId throws before any query', async () => {
  const { db, queries } = fakeDb(answer(SPLIT));
  await expect(
    db
      .transaction()
      .execute((trx) => readCommissionAttribution(trx, { appId: '', orderId: ORDER })),
  ).rejects.toThrow(TypeError);
  expect(queries.filter((q) => q.sql.startsWith('select'))).toHaveLength(0);
});
