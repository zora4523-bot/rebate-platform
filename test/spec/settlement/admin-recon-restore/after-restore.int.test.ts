// B2-09g restore rule tests, after the restore (claude-independent, SPEC_REF 81273415): 08
// BR-FUND-22 ③「补发后该受益人不再按被剥夺处理，之后的调整按重拆份额算应得」, BR-CALC-09 (forfeited 恒为 0，
// 申诉恢复除外; 例「申诉恢复后」), BR-CALC-13 and 编排裁定 D10-469 ③ — the active event of a restore ends the
// forfeiture of that (user, role) on that order, whether the restore paid anything or not:
// commission's public reads no longer list it, and the next adjustment takes the role by its
// re-split share. Another role, another member, another order and forfeitures for deleted / minor
// stay listed; a forfeited event after the active one lists the share again (event_seq decides,
// not created_at). Expected amounts are written by hand from the 05 examples.
// Real pieces: the restore through the admin entry (kit.ts), commission's public reads and event
// writer, the clawback service (no service of the settlement path R10 exists yet, so「结算佣金改为
// 800」of the example runs as a partial rights clawback R9 with the same N_new), the beneficiary
// gate over identity's and risk's ports, ledger, PostgreSQL as couli_app.
// Synthetic: kit.ts's seeds and one order_rights row. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { createRootLogger, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createClawbackOrder,
  type ClawbackOrder,
} from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import {
  createBeneficiaryGate,
  type BeneficiaryEventInput,
  type CreditSnapshot,
  type CreditSnapshotSelection,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  FORFEITED_AT,
  available,
  fixture,
  memberOf,
  netOf,
  netsOf,
  restoreVouchers,
  restored,
  seedCase,
  seedOrder,
  seedRestoreDiff,
  shareEvents,
  suite,
  voucherLines,
  withRestoreAdmin,
  type Case,
  type DiffRow,
  type OrderSpec,
  type RestoreFixture,
  type Role,
  type SeededOrder,
} from './kit.ts';

// Loaded at run time like the other settlement rule tests do: identity/index.ts re-exports Nest
// modules the `test` project cannot compile. The type queries are erased.
const { createRealnameStatusBatchReader, createUserDeletionStatusReader, lockUsersForUpdate } =
  (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as typeof import('../../../../apps/api/src/modules/identity/ports/realname-status-batch.ts') &
    typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts') &
    typeof import('../../../../apps/api/src/modules/identity/ports/lock-users.ts');

interface ForfeitedEvent {
  readonly eventSeq: bigint;
  readonly userId: string;
  readonly role: Role;
  readonly reason: string | null;
}

type Snapshot = Omit<CreditSnapshot, 'forfeitedEvents'> & {
  readonly forfeitedEvents: readonly ForfeitedEvent[];
};

// Through commission's public entry.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<Snapshot | null>;
  readCommissionAttribution(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ): Promise<{ readonly forfeitedEvents: readonly ForfeitedEvent[] }>;
  appendBeneficiaryEvent(
    trx: Transaction<DB>,
    input: BeneficiaryEventInput,
    dependencies: { readonly clock: Clock },
  ): Promise<void>;
};

const s = suite();

/** 05 例: reserve 0, N = B = 1000, the buyer alone with 5000 bp, forfeited at the credit. */
const SOLE: OrderSpec = {
  settleFen: 1000n,
  reserveBp: 0,
  people: [{ role: 'self', ratioBp: 5000, forfeited: true }],
};

/** SOLE with `creditedFen` already booked to the buyer (5 fen went to FORFEIT). */
function soleCredited(creditedFen: bigint): OrderSpec {
  return {
    ...SOLE,
    people: [{ role: 'self', ratioBp: 5000, forfeited: true, creditedFen, forfeitFen: 5n }],
  };
}

/** Restores each difference through the admin entry; each answers the given restored_fen. */
async function restoreEach(
  f: RestoreFixture,
  rows: readonly (readonly [DiffRow, number])[],
): Promise<void> {
  await withRestoreAdmin(f, async (h) => {
    for (const [diff, fen] of rows) {
      expect((await restored(await h.restore(diff.id))).restored_fen).toBe(fen);
    }
  });
}

/** The order's forfeited events as both public reads answer them (settlement uses both). */
function forfeitedOf(f: RestoreFixture, orderId: string): Promise<readonly ForfeitedEvent[]> {
  return f.db.transaction().execute(async (trx) => {
    const selection = { appId: f.appId, orderId };
    const snapshot = await commission.readCommissionSnapshot(trx, {
      ...selection,
      commissionVersion: 1,
    });
    const attribution = await commission.readCommissionAttribution(trx, selection);
    expect(snapshot, orderId).not.toBeNull();
    expect(attribution.forfeitedEvents, orderId).toEqual(snapshot?.forfeitedEvents);
    return attribution.forfeitedEvents;
  });
}

/** One seeded forfeited event of the share, stamped `at`. */
async function forfeit(
  f: RestoreFixture,
  order: SeededOrder,
  userId: string,
  role: Role,
  reason: 'banned' | 'deleted' | 'minor',
  at: Date = FORFEITED_AT,
): Promise<void> {
  await f.db
    .insertInto('commission_split_beneficiary_events')
    .values({
      app_id: f.appId,
      order_id: order.orderId,
      user_id: userId,
      role,
      status: 'forfeited',
      reason,
      created_at: at,
    })
    .execute();
}

/** The clawback service on the fixture's database, with the real gate and commission reads. */
function clawbackOf(f: RestoreFixture): ClawbackOrder {
  // R8 and R9 both publish order.clawed_back (D10-474 ③); any other event is still refused.
  const clawedBack: unknown[] = [];
  return createClawbackOrder({
    clock: f.clock,
    logger: createRootLogger(
      { entry: 'test', appEnv: 'test', level: 'silent' },
      { write: () => undefined },
    ),
    ledger: f.ledger,
    gate: createBeneficiaryGate({
      clock: f.clock,
      lockUsers: (trx, input) => lockUsersForUpdate(trx, input),
      deletionStatus: createUserDeletionStatusReader({ db: f.db }),
      realnameStatus: createRealnameStatusBatchReader({ db: f.db }),
      riskState: createRiskStateBatchReader({ db: f.db }),
      minors: { read: () => Promise.resolve(new Set<string>()) },
    }),
    readSnapshot: (trx, input) => commission.readCommissionSnapshot(trx, input),
    appendBeneficiaryEvent: (trx, input) =>
      commission.appendBeneficiaryEvent(trx, input, { clock: f.clock }),
    pending: {
      open: () => Promise.reject(new Error('a clawback with a new commission does not wait')),
    },
    config: { get: () => Promise.resolve(undefined) },
    events: {
      publish: (_trx, event) => {
        if (event.name !== 'order.clawed_back') {
          return Promise.reject(
            new Error(`a clawback publishes only order.clawed_back, got ${event.name}`),
          );
        }
        clawedBack.push(event);
        return Promise.resolve({ eventId: randomUUID(), duplicate: false });
      },
    },
  });
}

/** A partial rights clawback bringing the union's new commission (BR-FUND-08 ①, R9). */
async function partialRights(f: RestoreFixture, order: SeededOrder, newCommissionFen: bigint) {
  const orderRightsId = randomUUID();
  await f.db
    .insertInto('order_rights')
    .values({
      id: orderRightsId,
      app_id: f.appId,
      order_id: order.orderId,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: f.clock.now(),
      platform_rights_no: `rights-${orderRightsId}`,
    })
    .execute();
  const clawback = clawbackOf(f);
  const result = await f.db.transaction().execute((trx) =>
    clawback.apply(trx, {
      appId: f.appId,
      orderId: order.orderId,
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId },
      newCommissionFen,
      rightsDeductFen: null,
    }),
  );
  return { result, eventId: `R${orderRightsId}` };
}

async function clawbackKeys(f: RestoreFixture, orderKey: string): Promise<string[]> {
  const rows = await f.db
    .selectFrom('ledger_vouchers')
    .select('uniq_key')
    .where('app_id', '=', f.appId)
    .where('order_key', '=', orderKey)
    .where('voucher_kind', '=', 'CLAWBACK')
    .execute();
  return rows.map((row) => row.uniq_key).sort();
}

/**
 * The order's CLAWBACK vouchers are exactly these: a debit of each member's available and, when
 * `platformFen` is positive, a debit of COMMISSION_REVENUE, each against UNION_RECEIVABLE.
 */
async function expectClawbacks(
  f: RestoreFixture,
  order: SeededOrder,
  eventId: string,
  members: readonly (readonly [string, Role, bigint])[],
  platformFen: bigint,
): Promise<void> {
  const credit = (fen: bigint) =>
    `UNION_RECEIVABLE:${order.platform}|platform|available|${String(-fen)}|CLAWBACK|RIGHTS`;
  const expected = new Map<string, string[]>();
  for (const [userId, role, fen] of members) {
    expected.set(`${order.orderKey}:${userId}:${role}:CLAWBACK:${eventId}`, [
      `USER_BALANCE|${userId}|available|${String(fen)}|CLAWBACK|RIGHTS`,
      credit(fen),
    ]);
  }
  if (platformFen > 0n) {
    expected.set(`${order.orderKey}:PLATFORM:CLAWBACK:${eventId}`, [
      `COMMISSION_REVENUE|platform|available|${String(platformFen)}|CLAWBACK|RIGHTS`,
      credit(platformFen),
    ]);
  }
  expect(await clawbackKeys(f, order.orderKey)).toEqual([...expected.keys()].sort());
  for (const [key, lines] of expected) {
    expect(await voucherLines(f, key), key).toEqual([...lines].sort());
  }
}

function orderRow(f: RestoreFixture, orderId: string) {
  return f.db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

it('[AC-B2-09g#34] BR-FUND-22 ③ 与 BR-CALC-09 例（申诉恢复后）：预留 0、本人 5000、B=1000，U1 入账时封禁 500 归平台，申诉撤销补发 500；之后佣金改 800（真实扣回入口 R9）→ U1 按重拆份额 400 算应得，只扣 100，不是不扣也不是全扣；平台应得 400、冲回 100；UNION_RECEIVABLE 净额 800；booked 800 / 800，不生成补差候选、待补记义务或新的受益人事件', async () => {
  const f = await fixture(s);
  const c = await seedCase(f, SOLE);
  const { order, userId } = c;
  await restoreEach(f, [[c.diff, 500]]);

  expect(await available(f, userId)).toBe(500n);
  const before = await netsOf(f, order.orderKey);
  expect(netOf(before, userId, 'self')).toBe(500n);
  expect(before.platform_net_fen).toBe(500n);
  expect(before.union_receivable_net_fen).toBe(1000n);
  const events = await shareEvents(f, order.orderId);

  const { result, eventId } = await partialRights(f, order, 800n);

  expect(result).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: 800n,
    bookedNFen: 800n,
  });
  await expectClawbacks(f, order, eventId, [[userId, 'self', 100n]], 100n);
  expect(await available(f, userId)).toBe(400n);
  const after = await netsOf(f, order.orderKey);
  expect(netOf(after, userId, 'self')).toBe(400n);
  expect(after.platform_net_fen).toBe(400n);
  expect(after.union_receivable_net_fen).toBe(800n);
  expect(await orderRow(f, order.orderId)).toMatchObject({
    rebate_status: 'CREDITED',
    booked_base_fen: 800n,
    booked_n_fen: 800n,
  });
  const candidates = await f.db
    .selectFrom('settle_adjustments')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  expect(candidates).toEqual([]);
  const obligations = await f.db
    .selectFrom('beneficiary_credits')
    .selectAll()
    .where('app_id', '=', f.appId)
    .execute();
  expect(obligations).toEqual([]);
  expect(await shareEvents(f, order.orderId)).toEqual(events);
});

it('[AC-B2-09g#35] BR-CALC-13：恢复后 commission 两个公开读取（readCommissionSnapshot、readCommissionAttribution，两者一致）不再列出该受益人该角色；同单同一会员未列入差错单的角色、别的会员因封禁的没收、deleted / minor 原因的没收，以及该会员在别的订单上的没收都仍列出，eventSeq 与顺序不变', async () => {
  const f = await fixture(s);
  const userId = await memberOf(f);
  const order = await seedOrder(f, {
    people: [
      { role: 'self', ratioBp: 3000, forfeited: true },
      { role: 'indirect', ratioBp: 300 },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
      { role: 'indirect', ratioBp: 500, userId, forfeited: true },
      { role: 'direct', ratioBp: 500 },
    ],
  });
  const buyer = order.user('self');
  const left = order.people[1]!;
  const child = order.people[4]!;
  await forfeit(f, order, left.userId, left.role, 'deleted');
  await forfeit(f, order, child.userId, child.role, 'minor');
  const sibling = await seedOrder(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, userId, forfeited: true },
    ],
  });
  const diff = await seedRestoreDiff(f, order, { userId, roles: ['direct'] });

  const before = await forfeitedOf(f, order.orderId);
  expect(before.map((e) => `${e.userId}|${e.role}|${String(e.reason)}`).sort()).toEqual(
    [
      `${buyer}|self|banned`,
      `${left.userId}|indirect|deleted`,
      `${userId}|direct|banned`,
      `${userId}|indirect|banned`,
      `${child.userId}|direct|minor`,
    ].sort(),
  );
  const siblingBefore = await forfeitedOf(f, sibling.orderId);
  expect(siblingBefore.map((e) => [e.userId, e.role])).toEqual([[userId, 'direct']]);

  await restoreEach(f, [[diff, 85]]);

  expect(await forfeitedOf(f, order.orderId)).toEqual(
    before.filter((e) => !(e.userId === userId && e.role === 'direct')),
  );
  expect(await forfeitedOf(f, sibling.orderId)).toEqual(siblingBefore);
});

it('[AC-B2-09g#36] 依 D10-469 ③：恢复时净额 ≥ 应得不补发，但 active 事件已追加，之后同样不按被剥夺：净额 500 / 应得 500、净额 600 / 应得 500 → restored_fen 0、无 RESTORE 凭证、读取不再列出；之后佣金改 800 → 分别扣 100、200，都回到重拆份额 400，平台净额 400，应收净额 800；PUNISH 全额扣回的订单实发 0 同样不再列出', async () => {
  const f = await fixture(s);
  const even = await seedCase(f, soleCredited(500n));
  const over = await seedCase(f, soleCredited(600n));
  const punished = await seedCase(f, { punished: true });

  await restoreEach(f, [
    [even.diff, 0],
    [over.diff, 0],
    [punished.diff, 0],
  ]);

  expect(await restoreVouchers(f)).toEqual([]);
  for (const c of [even, over, punished]) {
    expect(await forfeitedOf(f, c.order.orderId)).toEqual([]);
  }
  const rows: readonly (readonly [Case, bigint, bigint])[] = [
    [even, 100n, 100n],
    [over, 200n, 0n],
  ];
  for (const [c, memberFen, platformFen] of rows) {
    const { result, eventId } = await partialRights(f, c.order, 800n);
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    await expectClawbacks(f, c.order, eventId, [[c.userId, 'self', memberFen]], platformFen);
    expect(await available(f, c.userId)).toBe(400n);
    const nets = await netsOf(f, c.order.orderKey);
    expect(netOf(nets, c.userId, 'self')).toBe(400n);
    expect(nets.platform_net_fen).toBe(400n);
    expect(nets.union_receivable_net_fen).toBe(800n);
  }
});

it('[AC-B2-09g#37] BR-CALC-13：active 之后又 forfeited（新一轮封禁或注销）时重新列出，原因为新事件的原因，与 active 同一时刻也按 event_seq 判定；再处理一张差错单后又不列出（实发 0）；created_at 晚于恢复时刻的旧 forfeited 排在 active 之前，不算重新没收', async () => {
  const f = await fixture(s);
  const banned = await seedCase(f);
  const deleted = await seedCase(f);
  const skewed = await seedCase(f);
  const later = new Date(f.clock.now().getTime() + 86_400_000);
  await forfeit(f, skewed.order, skewed.userId, 'direct', 'banned', later);

  await restoreEach(f, [
    [banned.diff, 85],
    [deleted.diff, 85],
    [skewed.diff, 85],
  ]);

  expect(await forfeitedOf(f, skewed.order.orderId)).toEqual([]);
  const rounds: readonly (readonly [Case, 'banned' | 'deleted'])[] = [
    [banned, 'banned'],
    [deleted, 'deleted'],
  ];
  for (const [{ order, userId }, reason] of rounds) {
    expect(await forfeitedOf(f, order.orderId)).toEqual([]);
    await f.db.transaction().execute((trx) =>
      commission.appendBeneficiaryEvent(
        trx,
        {
          appId: f.appId,
          orderId: order.orderId,
          userId,
          role: 'direct',
          status: 'forfeited',
          reason,
        },
        { clock: f.clock },
      ),
    );
    const last = (await shareEvents(f, order.orderId)).at(-1)!;
    expect(last).toMatchObject({ user_id: userId, status: 'forfeited', reason });
    const listed = await forfeitedOf(f, order.orderId);
    expect(listed).toContainEqual({ eventSeq: last.event_seq, userId, role: 'direct', reason });
    expect(listed.every((e) => e.userId === userId && e.role === 'direct')).toBe(true);
  }

  const again = await seedRestoreDiff(f, banned.order, { patch: { period: '2026-09' } });
  await restoreEach(f, [[again, 0]]);
  expect(await forfeitedOf(f, banned.order.orderId)).toEqual([]);
});

it('[AC-B2-09g#38] 恢复只解除差错单列出的角色：预留 1500、基数 850，本人 425，直推 85 没收后恢复，间推 42 没收未恢复；之后佣金改 600（基数 510）→ 本人扣 170、直推按重拆份额 51 扣 34，间推仍按被剥夺不扣不补，平台从 490 到 294 冲回 196，应收净额 600', async () => {
  const f = await fixture(s);
  const order = await seedOrder(f, {
    people: [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, forfeited: true },
      { role: 'indirect', ratioBp: 500, forfeited: true },
    ],
  });
  const buyer = order.user('self');
  const direct = order.user('direct');
  const indirect = order.user('indirect');
  const diff = await seedRestoreDiff(f, order, { userId: direct, roles: ['direct'] });

  await restoreEach(f, [[diff, 85]]);
  const before = await netsOf(f, order.orderKey);
  expect(netOf(before, direct, 'direct')).toBe(85n);
  expect(before.platform_net_fen).toBe(490n);

  const { result, eventId } = await partialRights(f, order, 600n);

  expect(result).toMatchObject({
    outcome: 'clawed_back',
    transition: 'R9',
    bookedBaseFen: 510n,
    bookedNFen: 600n,
  });
  await expectClawbacks(
    f,
    order,
    eventId,
    [
      [buyer, 'self', 170n],
      [direct, 'direct', 34n],
    ],
    196n,
  );
  const after = await netsOf(f, order.orderKey);
  expect(netOf(after, buyer, 'self')).toBe(255n);
  expect(netOf(after, direct, 'direct')).toBe(51n);
  expect(netOf(after, indirect, 'indirect')).toBe(0n);
  expect(after.platform_net_fen).toBe(294n);
  expect(after.union_receivable_net_fen).toBe(600n);
  expect(await available(f, direct)).toBe(51n);
  expect(await available(f, indirect)).toBe(0n);
});
