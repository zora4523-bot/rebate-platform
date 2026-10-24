// Unit tests of the R5a execution (B2-04q r2): no database; a fake Kysely driver answers each
// statement by its SQL text, the collaborators are mocks.
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
import { expect, it, vi } from 'vitest';
import type { OrderNets } from '../../../ledger/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import type { CreditSnapshot } from '../credit-order.ts';
import { attributionUnchanged, createBeneficiaryCredit } from './beneficiary-credit.ts';

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
const CREDIT_ID = '019a0000-0000-7000-8000-0000000000c1';
const SELF = '019a0000-0000-7000-8000-0000000000a1';
const DIRECT = '019a0000-0000-7000-8000-0000000000a2';
const ACCOUNT = '019a0000-0000-7000-8000-0000000000b2';
const VOUCHER = '019a0000-0000-7000-8000-0000000000d1';
const NOW = '2032-08-24T10:00:00+08:00';
const ATTR_AT = new Date('2032-06-20T10:00:00+08:00');

/**
 * A CREDITED order whose commission_version was bumped to 2 by order-sync after R5 (amount
 * re-statement only); the direct's first_credit obligation was opened on version 1.
 * booked_base 850 → direct 1000 bp owes 85; self 425 credited at R5; receivable 1000 − 85.
 */
function scenario() {
  const { db, queries } = fakeDb((q) => {
    const text = q.sql;
    if (/select "platform", "sub_order_id", "attr_at" from "app"."orders"/.test(text)) {
      return { rows: [{ platform: 'taobao', sub_order_id: 'sub-1', attr_at: ATTR_AT }] };
    }
    if (/select \* from "app"."orders"/.test(text)) {
      return {
        rows: [
          {
            app_id: APP,
            order_id: ORDER,
            rebate_status: 'CREDITED',
            rights_pending: false,
            hold: false,
            commission_version: 2,
            booked_base_fen: 850n,
            booked_n_fen: 1000n,
            row_version: 7,
          },
        ],
      };
    }
    if (/select \* from "app"."beneficiary_credits"/.test(text)) {
      return {
        rows: [
          {
            beneficiary_credit_id: CREDIT_ID,
            app_id: APP,
            order_id: ORDER,
            user_id: DIRECT,
            role: 'direct',
            kind: 'first_credit',
            opened_by: 'R5',
            opened_ref: 'batch-item-r5',
            origin_ledger_type: null,
            origin_sub_type: null,
            split_ref: 'commission_version:1',
            status: 'open',
            closed_by: null,
            closed_ref: null,
            voucher_id: null,
            row_version: 0,
          },
        ],
      };
    }
    if (/max\("seq"\)/.test(text)) return { rows: [{ seq: 1 }] };
    if (/select "user_id", "role" from "app"."beneficiary_credits"/.test(text)) {
      return { rows: [{ user_id: DIRECT, role: 'direct' }] };
    }
    if (/^update "app"."beneficiary_credits"/.test(text)) {
      return { rows: [], numAffectedRows: 1n };
    }
    return undefined;
  });
  const snapshot: CreditSnapshot = {
    reserveBp: 1500,
    beneficiaries: [
      { userId: SELF, role: 'self', ratioBp: 5000, initialStatus: 'active' },
      { userId: DIRECT, role: 'direct', ratioBp: 1000, initialStatus: 'active' },
    ],
    forfeitedEvents: [],
  };
  const nets: OrderNets = {
    beneficiaries: [{ beneficiary_user_id: SELF, role: 'self', net_fen: 425n }],
    platform_net_fen: 490n,
    union_receivable_net_fen: 915n,
  };
  const readSnapshot = vi.fn(async () => snapshot);
  const post = vi.fn(async () => ({ kind: 'posted' as const, voucherId: VOUCHER }));
  const service = createBeneficiaryCredit({
    clock: new FixedClock(NOW),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ledger: {
      openUserAccount: vi.fn(async () => ({}) as never),
      lockBalances: vi.fn(async () => [{ user_id: DIRECT, account_id: ACCOUNT }] as never),
      post,
    },
    gate: {
      lockUsers: vi.fn(async () => new Set([DIRECT])),
      readStates: vi.fn(
        async () =>
          new Map([
            [DIRECT, { risk_state: 'normal' as const, deletion_status: null, is_minor: false }],
          ]),
      ),
    },
    readSnapshot,
    readOrderNets: vi.fn(async () => nets),
    appendBeneficiaryEvent: vi.fn(async () => undefined),
  });
  const run = () =>
    db.transaction().execute((trx) =>
      service.execute(trx, {
        appId: APP,
        orderId: ORDER,
        beneficiaryCreditId: CREDIT_ID,
        expectedSettleSeq: 1,
        closedRef: 'batch-item-1',
      }),
    );
  return { queries, run, readSnapshot, post };
}

it('[AC-B2-04q] attributionUnchanged: an amount-version bump keeps the attribution; a version above the current one or a malformed ref does not', () => {
  expect(attributionUnchanged('commission_version:1', 1)).toBe(true);
  expect(attributionUnchanged('commission_version:1', 2)).toBe(true);
  expect(attributionUnchanged('commission_version:2', 2)).toBe(true);
  expect(attributionUnchanged('commission_version:9', 1)).toBe(false);
  expect(attributionUnchanged('commission_version:0', 1)).toBe(false);
  expect(attributionUnchanged('commission_version:01', 1)).toBe(false);
  expect(attributionUnchanged('commission_version:1x', 1)).toBe(false);
  expect(attributionUnchanged('split:1', 1)).toBe(false);
  expect(attributionUnchanged('', 1)).toBe(false);
});

it('[AC-B2-04q] commission_version bumped on a CREDITED order after R5: the obligation opened on version 1 still executes, amounts from the current version, history row after the close', async () => {
  const { queries, run, readSnapshot, post } = scenario();
  const result = await run();
  expect(result).toEqual({
    outcome: 'credited',
    beneficiaryCreditId: CREDIT_ID,
    userId: DIRECT,
    role: 'direct',
    amountFen: 85n,
    voucherId: VOUCHER,
  });
  // The snapshot is read at the current version (amounts current), not at the obligation's one.
  expect(readSnapshot).toHaveBeenCalledWith(expect.anything(), {
    appId: APP,
    orderId: ORDER,
    commissionVersion: 2,
  });
  expect(post).toHaveBeenCalledTimes(1);
  const voucher = (post.mock.calls[0] as unknown[] | undefined)?.[1];
  expect(voucher).toMatchObject({
    uniqKey: `taobao:sub-1:${DIRECT}:direct:CREDIT`,
    voucherKind: 'CREDIT',
    beneficiaryUserId: DIRECT,
  });

  const sqls = queries.map((q) => q.sql);
  const close = sqls.findIndex((s) => s.startsWith('update "app"."beneficiary_credits"'));
  const history = sqls.findIndex((s) => s.startsWith('insert into "app"."order_status_history"'));
  expect(close).toBeGreaterThan(0);
  expect(history).toBeGreaterThan(close);
  expect(queries[history]?.parameters).toEqual([
    APP,
    ORDER,
    'rebate',
    'CREDITED',
    'BENEFICIARY_RELEASE',
    'CREDITED',
    'system',
    new Date(NOW),
  ]);
  expect(queries[close]?.parameters).toEqual(
    expect.arrayContaining(['done', 'R5a', 'batch-item-1', new Date(NOW), VOUCHER, 1]),
  );
});
