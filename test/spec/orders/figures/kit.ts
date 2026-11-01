// B1-09p rule-test kit. Real rows only: orders, the commission snapshot, ledger vouchers posted
// through the real ledger, beneficiary_credits, appeals and config_items. The figures are read by
// the real readers of settlement, ledger, risk, commission and content; nothing here stands in for
// a figures port, and no value comes from the code under test (every amount is written by hand in
// the tests). The production entries are tested in production-*.int.test.ts and admin.int.test.ts.
// Integration tests pass createTestDatabase in: this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createLedger,
  readOrderFiguresLedger,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { createOrderLinkReader } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  createOrderQueries,
  type AgentCapableOrderQueries,
  type OrderSubject,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createOrderAppealReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createOrderFiguresReader,
  type OrderFiguresDependencies,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import { AT, seed, type Person } from '../../settlement/pending-earnings/fixtures.ts';

/** Before the default expected month's deadline (2028-01-03 +08:00). */
export const NOW = '2027-12-15T04:00:00.000Z';
export const PAID = '2027-10-10T02:00:00.000Z';
export const RECEIVED = '2027-11-05T02:00:00.000Z';
export const CREDITED_AT = '2027-12-02T02:00:00.000Z';
/** settle_period of a default WAITING order; the default offset 1 makes it EXPECTED. */
export const PERIOD = '2027-11';
export const EXPECTED = '2027-12';
/** The days of PAID's month, for agent searches. */
export const PAID_MONTH = { date_from: '2027-10-01', date_to: '2027-10-31' };

export type Role = Person['role'];
export type OrderPatch = Partial<Insertable<DB['orders']>>;

const CREDIT_TYPES: Readonly<Record<Role, { type: string; sub: string | null }>> = {
  self: { type: 'REBATE_CREDIT', sub: null },
  share: { type: 'SHARE_CREDIT', sub: null },
  direct: { type: 'REFERRAL_CREDIT', sub: 'DIRECT' },
  indirect: { type: 'REFERRAL_CREDIT', sub: 'INDIRECT' },
};

export function waiting(patch: OrderPatch = {}): OrderPatch {
  return {
    rebate_status: 'WAITING',
    platform_status: 'RECEIVED',
    received_at: RECEIVED,
    settle_period: PERIOD,
    ...patch,
  };
}

/** N = 1000, reserve 15 %: booked base 850. */
export function credited(patch: OrderPatch = {}): OrderPatch {
  return {
    rebate_status: 'CREDITED',
    platform_status: 'SETTLED',
    received_at: RECEIVED,
    settle_period: PERIOD,
    settle_commission_fen: 1000n,
    booked_base_fen: 850n,
    booked_n_fen: 1000n,
    credited_at: CREDITED_AT,
    ...patch,
  };
}

interface TestDatabaseLike {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** One test database per file, opened and dropped around its tests. */
export function useDatabase(create: () => Promise<TestDatabaseLike>) {
  let database: TestDatabaseLike | undefined;
  let handle: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await create();
    handle = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, 180_000);
  afterAll(async () => {
    try {
      if (handle !== undefined) await destroyDb(handle);
    } finally {
      await database?.drop();
    }
  }, 60_000);
  return {
    get db(): Kysely<DB> {
      if (handle === undefined) throw new Error('figures database is not open');
      return handle;
    },
  };
}

/** Built inside the tests, so the skeleton's NotImplemented reddens the test body itself. */
async function productionFigures(db: Kysely<DB>, clock: FixedClock) {
  // Through commission's public entry, as the settlement rule tests load it.
  const commission = (await import(
    new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
  )) as {
    readCommissionSnapshot: OrderFiguresDependencies['readSnapshot'];
    readTljDeductFen: OrderFiguresDependencies['readTljDeductFen'];
  };
  return createOrderFiguresReader({
    db,
    clock,
    config: {
      get: async (appId, key) =>
        (await createContentReader({ db, clock }).configValue(appId, key))?.value,
    },
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
    ledger: readOrderFiguresLedger,
    appeals: createOrderAppealReader(db),
  });
}

export interface SeededOrder {
  readonly orderId: string;
  readonly orderKey: string;
  readonly platform: string;
  readonly subOrderId: string;
}

export interface OrderInput {
  readonly patch?: OrderPatch;
  readonly people?: readonly Person[];
  readonly reserveBp?: number;
  readonly tljDeductFen?: bigint;
}

interface BookInput {
  readonly amount: bigint;
  readonly userId?: string;
  readonly role?: Role;
  readonly at?: string;
}

interface ClawbackInput extends BookInput {
  readonly sub?: 'FULL' | 'PART_REFUND' | 'RIGHTS' | 'PUNISH';
}

interface ObligationInput {
  readonly kind: 'first_credit' | 'reassign_credit' | 'deferred';
  readonly userId?: string;
  readonly role?: Role;
}

interface AppealInput {
  readonly status?: 'processing' | 'upheld' | 'revoked';
  readonly targetType?: 'order' | 'account';
  readonly targetId?: string;
}

export interface FixtureOptions {
  readonly now?: string;
  /** An existing app and user (the production entries' fixtures); a new one otherwise. */
  readonly subject?: OrderSubject;
  /** config_items of the app, over the default credit.enabled.* = true. */
  readonly config?: Readonly<Record<string, unknown>>;
}

let sequence = 0;

function minutesAfter(instant: string, minutes: number): Date {
  const clock = new FixedClock(instant);
  clock.advanceMs(minutes * 60_000);
  return clock.now();
}

/** A new app (or the given one) with its user, a published rule version and config_items. */
export async function fixture(db: Kysely<DB>, options: FixtureOptions = {}) {
  const handle = db.withSchema('app');
  const subject: OrderSubject = options.subject ?? {
    app_id: `figures-${randomUUID()}`,
    user_id: randomUUID(),
  };
  const appId = subject.app_id;
  const now = options.now ?? NOW;
  const clock = new FixedClock(now);
  const ledgerClock = new FixedClock(now);
  const ledger = createLedger({ clock: ledgerClock });
  const accounts = new Map<string, string>();
  const ruleVersionId = randomUUID();
  await handle
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: AT,
      indirect_enabled: true,
      created_at: AT,
    })
    .execute();
  const config = {
    'credit.enabled.jd': true,
    'credit.enabled.taobao': true,
    'credit.enabled.pdd': true,
    ...options.config,
  };
  for (const [key, value] of Object.entries(config)) {
    await handle
      .insertInto('config_items')
      .values({
        app_id: appId,
        key,
        value: JSON.stringify(value),
        version: 1,
        updated_by: 'fixture',
      })
      .onConflict((oc) =>
        oc.columns(['app_id', 'key']).doUpdateSet({ value: JSON.stringify(value) }),
      )
      .execute();
  }

  /** A users row of the app (kept when the id already exists). */
  async function user(userId: string = randomUUID()): Promise<string> {
    await handle
      .insertInto('users')
      .values({
        id: userId,
        app_id: appId,
        nickname: 'synthetic',
        avatar: '',
        invite_code: userId,
        attr_code: userId,
        level: 'member',
        register_method: 'synthetic',
        created_at: AT,
        updated_at: AT,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return userId;
  }
  await user(subject.user_id);

  function identity(patch: OrderPatch) {
    sequence += 1;
    const platform = patch.platform ?? 'jd';
    const subOrderId = patch.sub_order_id ?? `sub-${randomUUID()}`;
    return {
      platform,
      subOrderId,
      row: {
        platform,
        sub_order_id: subOrderId,
        parent_order_id: `parent-${randomUUID()}`,
        title: 'Synthetic item',
        buy_type: 'self',
        paid_at: minutesAfter(PAID, sequence),
      },
    };
  }

  function seeded(orderId: string, platform: string, subOrderId: string): SeededOrder {
    return { orderId, orderKey: `${platform}:${subOrderId}`, platform, subOrderId };
  }

  /** An attributed order of the subject with its commission snapshot (N = 1000, self 50 %). */
  async function order(input: OrderInput = {}): Promise<SeededOrder> {
    const patch = input.patch ?? {};
    const { platform, subOrderId, row } = identity(patch);
    const orderId = await seed(
      db,
      { appId, userId: subject.user_id, ruleVersionId },
      {
        order: { ...row, ...patch },
        people: input.people ?? [{ userId: subject.user_id, role: 'self', ratioBp: 5000 }],
        ...(input.reserveBp === undefined ? {} : { reserveBp: input.reserveBp }),
        ...(input.tljDeductFen === undefined ? {} : { tljDeductFen: input.tljDeductFen }),
      },
    );
    return seeded(orderId, platform, subOrderId);
  }

  /** An order that has no commission snapshot yet (commission_version 0, no commission_splits). */
  async function bareOrder(patch: OrderPatch = {}): Promise<SeededOrder> {
    const { platform, subOrderId, row } = identity(patch);
    const values = {
      order_id: randomUUID(),
      app_id: appId,
      raw_item_id: 'synthetic-item',
      user_id: subject.user_id,
      platform_status: 'PAID',
      rebate_status: 'ESTIMATED',
      attr_at: AT,
      est_commission_fen: 1000n,
      ...row,
      ...patch,
    } satisfies Insertable<DB['orders']>;
    await handle
      .insertInto('order_keys')
      .values({
        app_id: values.app_id,
        order_id: values.order_id,
        platform,
        sub_order_id: subOrderId,
        attr_at: values.attr_at,
      })
      .execute();
    await handle.insertInto('orders').values(values).execute();
    return seeded(values.order_id, platform, subOrderId);
  }

  /** One voucher on its own transaction; its entries are booked at `at`. */
  async function post(voucher: PostingVoucher, at: string): Promise<string> {
    ledgerClock.set(at);
    return db.transaction().execute(async (trx) => {
      const userId = voucher.beneficiaryUserId;
      if (userId !== null) await ledger.lockBalances(trx, { appId, userIds: [userId] });
      return (await ledger.post(trx, voucher)).voucherId;
    });
  }

  async function accountOf(userId: string): Promise<string> {
    const known = accounts.get(userId);
    if (known !== undefined) return known;
    const opened = await db
      .transaction()
      .execute((trx) => ledger.openUserAccount(trx, { appId, userId }));
    accounts.set(userId, opened.account_id);
    return opened.account_id;
  }

  /**
   * A beneficiary voucher between UNION_RECEIVABLE:{platform} and the user's balance. `amount` is
   * from the user's side: positive adds to the balance (a credit entry, negative amount_fen).
   */
  async function userVoucher(
    o: SeededOrder,
    input: { userId: string; role: Role; amount: bigint; at: string; suffix: string },
    kind: string,
    bizType: string,
    type: { type: string; sub: string | null },
  ): Promise<string> {
    const accountId = await accountOf(input.userId);
    return post(
      {
        appId,
        uniqKey: `${o.orderKey}:${input.userId}:${input.role}:${input.suffix}`,
        bizType,
        bizId: o.orderKey,
        operator: 'system',
        memo: null,
        orderKey: o.orderKey,
        beneficiaryUserId: input.userId,
        role: input.role,
        voucherKind: kind,
        entries: [
          {
            account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${o.platform}` },
            sub_account: 'available',
            amount_fen: input.amount,
            ledger_type: type.type,
            sub_type: type.sub,
            income_type: null,
          },
          {
            account: { ownerType: 'user', accountId },
            sub_account: 'available',
            amount_fen: -input.amount,
            ledger_type: type.type,
            sub_type: type.sub,
            income_type: null,
          },
        ],
      },
      input.at,
    );
  }

  /** The R5 credit of one share. */
  function credit(o: SeededOrder, input: BookInput): Promise<string> {
    const role = input.role ?? 'self';
    return userVoucher(
      o,
      {
        userId: input.userId ?? subject.user_id,
        role,
        amount: input.amount,
        at: input.at ?? CREDITED_AT,
        suffix: 'CREDIT',
      },
      'CREDIT',
      'ORDER_CREDIT',
      CREDIT_TYPES[role],
    );
  }

  /** A SETTLE_ADJUST of `amount`, signed from the user's side. */
  function adjust(o: SeededOrder, input: BookInput): Promise<string> {
    return userVoucher(
      o,
      {
        userId: input.userId ?? subject.user_id,
        role: input.role ?? 'self',
        amount: input.amount,
        at: input.at ?? CREDITED_AT,
        suffix: `ADJ:${randomUUID()}`,
      },
      'SETTLE_ADJUST',
      'ORDER_SETTLE_ADJUST',
      { type: 'SETTLE_ADJUST', sub: 'SETTLE_DIFF' },
    );
  }

  /** A CLAWBACK of `amount` (positive) from the user's balance. */
  function clawback(o: SeededOrder, input: ClawbackInput): Promise<string> {
    return userVoucher(
      o,
      {
        userId: input.userId ?? subject.user_id,
        role: input.role ?? 'self',
        amount: -input.amount,
        at: input.at ?? CREDITED_AT,
        suffix: `CLAWBACK:${randomUUID()}`,
      },
      'CLAWBACK',
      'ORDER_CLAWBACK',
      { type: 'CLAWBACK', sub: input.sub ?? 'PART_REFUND' },
    );
  }

  /** The platform's side of a clawback: an order voucher that belongs to no beneficiary. */
  function platformClawback(o: SeededOrder, amount: bigint): Promise<string> {
    return post(
      {
        appId,
        uniqKey: `${o.orderKey}:PLATFORM:CLAWBACK:${randomUUID()}`,
        bizType: 'ORDER_CLAWBACK',
        bizId: o.orderKey,
        operator: 'system',
        memo: null,
        orderKey: o.orderKey,
        beneficiaryUserId: null,
        role: null,
        voucherKind: 'CLAWBACK',
        entries: [
          {
            account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
            sub_account: 'available',
            amount_fen: amount,
            ledger_type: 'CLAWBACK',
            sub_type: 'PART_REFUND',
            income_type: null,
          },
          {
            account: { ownerType: 'platform', subject: `UNION_RECEIVABLE:${o.platform}` },
            sub_account: 'available',
            amount_fen: -amount,
            ledger_type: 'CLAWBACK',
            sub_type: 'PART_REFUND',
            income_type: null,
          },
        ],
      },
      CREDITED_AT,
    );
  }

  /** An open beneficiary_credits row (R5 first_credit, R14 reassign_credit, R10 deferred). */
  async function obligation(o: SeededOrder, input: ObligationInput): Promise<string> {
    const id = randomUUID();
    const deferred = input.kind === 'deferred';
    await handle
      .insertInto('beneficiary_credits')
      .values({
        beneficiary_credit_id: id,
        app_id: appId,
        order_id: o.orderId,
        user_id: input.userId ?? subject.user_id,
        role: input.role ?? 'self',
        kind: input.kind,
        opened_by: { first_credit: 'R5', reassign_credit: 'R14', deferred: 'R10' }[input.kind],
        opened_ref: `opened-${id}`,
        origin_ledger_type: deferred ? 'SETTLE_ADJUST' : null,
        origin_sub_type: deferred ? 'SETTLE_DIFF' : null,
        split_ref: 'commission_version:1',
        status: 'open',
        closed_by: null,
        closed_ref: null,
        voucher_id: null,
        opened_at: CREDITED_AT,
        closed_at: null,
      })
      .execute();
    return id;
  }

  /** The R5a execution of an obligation: the row moves to done with its voucher. */
  async function closeObligation(id: string, voucherId: string): Promise<void> {
    await handle
      .updateTable('beneficiary_credits')
      .set({
        status: 'done',
        closed_by: 'R5a',
        closed_ref: `closed-${id}`,
        closed_at: CREDITED_AT,
        voucher_id: voucherId,
      })
      .where('app_id', '=', appId)
      .where('beneficiary_credit_id', '=', id)
      .execute();
  }

  /** An appeals row of the subject; an account appeal names the user, an order appeal the order. */
  async function appeal(o: SeededOrder, input: AppealInput = {}): Promise<void> {
    const status = input.status ?? 'processing';
    const targetType = input.targetType ?? 'order';
    const open = status === 'processing';
    await handle
      .insertInto('appeals')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: subject.user_id,
        target_type: targetType,
        target_id: input.targetId ?? (targetType === 'order' ? o.orderId : subject.user_id),
        prev_risk_state: targetType === 'account' ? 'banned' : null,
        status,
        content: 'synthetic appeal',
        deadline_at: '2028-02-01T00:00:00.000Z',
        handler_id: open ? null : 'synthetic-handler',
        closed_at: open ? null : CREDITED_AT,
      })
      .execute();
  }

  /** The shared order queries with the real figures readers, as app.module assembles them. */
  async function queries(): Promise<AgentCapableOrderQueries> {
    return createOrderQueries({
      db,
      clock,
      config: createContentReader({ db, clock }),
      links: createOrderLinkReader(db),
      figures: await productionFigures(db, clock),
    });
  }

  async function detail(o: SeededOrder) {
    return (await queries()).get(subject, o.orderId);
  }

  async function row(o: SeededOrder, scope: 'self' | 'share' = 'self') {
    const page = await (await queries()).list(subject, { scope });
    return page.items.find((item) => item.order_id === o.orderId);
  }

  return {
    db,
    subject,
    clock,
    user,
    order,
    bareOrder,
    credit,
    adjust,
    clawback,
    platformClawback,
    obligation,
    closeObligation,
    appeal,
    queries,
    detail,
    row,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
