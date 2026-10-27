// B2-04mb rule tests: the single-order credit (R5, B2-04m credit-order.ts) reads the attribution
// (reserve ratio, beneficiaries with their ratios, forfeited events) through commission's
// version-independent readCommissionAttribution (B2-04q, D10-317). BR-FUND-04 ⑦ ⑩ ⑫, BR-CALC-13.
//
// Scenario (编排 D10-317): a WAITING sub-order has the commission version 1 snapshot only
// (commission_splits, commission_split_totals / amounts at version 1). order-sync then sees a new
// estimate and moves orders.commission_version to 2 (planOrderSyncColumns: est_commission_fen
// changed → version + 1), but nothing writes version 2 snapshot rows yet. R5 must still credit the
// order: beneficiaries and ratios come from the immutable commission_splits row, amounts from the
// credit plan (B_credit from N = settle_commission_fen per BR-CALC-02, floor shares) — the same
// vouchers and booked pair as the version 1 order. It must not fail with commission's
// "expected commission_version 2 is not the current version 1" and roll the whole order back.
//
// Port shape (same as B2-04q beneficiary-credit): CreditOrderDependencies gains an optional
//   readAttribution(trx, { appId, orderId }): Promise<CreditSnapshot>
// wired to commission readCommissionAttribution. When it is supplied the credit reads the
// attribution only through it, on the caller's transaction after the order_key lock, and never
// calls readSnapshot (no fallback, no amount version read). The B2-04m harness (no
// readAttribution) keeps its current behaviour.
//
// Example as in B2-04m: N = 1000, reserve_bp 1500 → B_credit 850, reserve 150;
// self 5000 / direct 1000 / indirect 500 → 425 / 85 / 42; platform 298 + 150 = 448.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { addFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createCreditOrder,
  type CreditOrderDependencies,
  type CreditOrderResult,
  type CreditSnapshot,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  NOW,
  TIMEOUT,
  creditKey,
  databaseFixture,
  forfeitKey,
  harness,
  platformKey,
  platformLines,
  receivable,
  tracing,
  userCreditLines,
  type Harness,
  type SeededOrder,
} from '../credit/kit.ts';

type AttributionReader = (
  trx: Transaction<DB>,
  input: { readonly appId: string; readonly orderId: string },
) => Promise<CreditSnapshot>;

// Through commission's public entry, loaded at run time like the B2-04m kit does.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionAttribution: AttributionReader;
  readCommissionSnapshot: CreditOrderDependencies['readSnapshot'];
};

const p = databaseFixture(createTestDatabase);

/** order-sync's write time, between the order's attr_at and the credit (NOW). */
const SYNC_AT = '2032-07-10T10:00:00+08:00';
/** The new estimate order-sync received (any change of est_commission_fen bumps the version). */
const EST_CHANGE_FEN = 777n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPLIT_REF = /^commission_version:([1-9][0-9]*)$/;

/**
 * order-sync's write (BR-FUND-03, planOrderSyncColumns): a changed estimate and
 * commission_version + 1 in one CAS on row_version. No snapshot row of the new version is written.
 */
async function orderSyncBump(h: Harness, o: SeededOrder, version: number): Promise<void> {
  const row = await h.read(o);
  expect(row.commission_version).toBe(1);
  expect(row.est_commission_fen).not.toBeNull();
  const result = await h.db
    .updateTable('orders')
    .set({
      est_commission_fen: addFen(row.est_commission_fen ?? 0n, EST_CHANGE_FEN),
      commission_version: version,
      row_version: row.row_version + 1,
      updated_at: new Date(SYNC_AT),
    })
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  expect(result.numUpdatedRows).toBe(1n);
}

/** Every commission_version that has snapshot amount rows (totals or amounts) for the order. */
async function storedVersions(h: Harness, o: SeededOrder): Promise<number[]> {
  const totals = await h.db
    .selectFrom('commission_split_totals')
    .select('commission_version')
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  const amounts = await h.db
    .selectFrom('commission_split_amounts')
    .select('commission_version')
    .where('app_id', '=', h.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  return [...new Set([...totals, ...amounts].map((r) => r.commission_version))].sort();
}

/**
 * The credit service wired like the B2-04m harness plus readAttribution = commission
 * readCommissionAttribution (spied). The deps object is passed as a variable, so it also builds
 * against the B2-04m dependency interface.
 */
function attributed(h: Harness) {
  h.boot();
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const readAttribution = vi.fn<AttributionReader>((trx, input) =>
    commission.readCommissionAttribution(trx, input),
  );
  const deps = {
    clock: h.clock,
    logger,
    ledger: {
      openUserAccount: h.openUserAccount,
      lockBalances: h.lockBalances,
      post: h.post,
    },
    gate: { lockUsers: h.lockUsers, readStates: h.readStates },
    readSnapshot: h.readSnapshot,
    readTljDeductFen: h.readTljDeductFen,
    appendBeneficiaryEvent: h.appendBeneficiaryEvent,
    events: { publish: h.publish },
    readAttribution,
  };
  const service = createCreditOrder(deps);
  const transactions: Transaction<DB>[] = [];
  function run(o: SeededOrder, via: Kysely<DB> = h.db): Promise<CreditOrderResult> {
    return via.transaction().execute(async (trx) => {
      transactions.push(trx);
      return service.credit(trx, h.input(o));
    });
  }
  return { readAttribution, logs, transactions, run };
}

/** How a credit attempt ended: its result, or the message of the error it threw. */
type Settled =
  | { readonly resolved: true; readonly value: CreditOrderResult }
  | { readonly resolved: false; readonly error: string };

/**
 * Waits for a credit attempt and keeps a thrown error as data, so that a credit that throws (the
 * version assertion rolling the order back) fails the test's own expect on the outcome, with the
 * error's message in the diff, instead of escaping the test.
 */
async function settle(attempt: Promise<CreditOrderResult>): Promise<Settled> {
  try {
    return { resolved: true, value: await attempt };
  } catch (err) {
    return { resolved: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The result of an attempt that must have resolved (an assertion failure otherwise). */
function resolvedValue(outcome: Settled): CreditOrderResult {
  expect(outcome).toMatchObject({ resolved: true });
  if (!outcome.resolved) throw new Error('unreachable: the expect above failed');
  return outcome.value;
}

/** The order's ledger lines with the order key and user ids replaced by role names. */
async function footprint(h: Harness, o: SeededOrder) {
  const alias: [string, string][] = [
    [o.orderKey, 'ORDER'],
    ...o.people.map((person): [string, string] => [person.userId, `user:${person.role}`]),
  ];
  const rename = (text: string): string =>
    alias.reduce((out, [from, to]) => out.split(from).join(to), text);
  const lines: string[] = [];
  for (const l of await h.lines()) {
    if (!l.uniq_key.startsWith(`${o.orderKey}:`)) continue;
    const amount = String(l.amount_fen);
    const sub = l.sub_type ?? '';
    const text = [l.uniq_key, l.subject, l.owner_id, amount, l.ledger_type, sub].join('|');
    lines.push(rename(text));
  }
  lines.sort();
  const row = await h.read(o);
  const balances: Record<string, bigint> = {};
  for (const person of o.people) balances[person.role] = await h.balance(person.userId);
  const obligations: Record<string, string>[] = [];
  for (const b of await h.obligations()) {
    if (b.order_id !== o.orderId) continue;
    obligations.push({ user: rename(b.user_id), role: b.role, kind: b.kind, status: b.status });
  }
  const events: Record<string, string | null>[] = [];
  for (const e of await h.newBeneficiaryEvents(o)) {
    events.push({ user: rename(e.user_id), role: e.role, status: e.status, reason: e.reason });
  }
  return {
    lines,
    balances,
    obligations,
    events,
    rebate_status: row.rebate_status,
    booked_base_fen: row.booked_base_fen,
    booked_n_fen: row.booked_n_fen,
  };
}

/** The service result with user ids replaced by role names (order key dropped). */
function shape(o: SeededOrder, result: CreditOrderResult) {
  if (result.outcome !== 'credited') return result;
  const roleOf = new Map(o.people.map((person): [string, string] => [person.userId, person.role]));
  const beneficiaries = result.beneficiaries.map((b) => ({
    user: roleOf.get(b.userId),
    role: b.role,
    shareFen: b.shareFen,
    action: b.action,
    forfeitReason: b.forfeitReason,
    obligation: b.beneficiaryCreditId !== null,
  }));
  beneficiaries.sort((a, b) => (a.role < b.role ? -1 : 1));
  return {
    outcome: result.outcome,
    bCreditFen: result.bCreditFen,
    bookedNFen: result.bookedNFen,
    platformCreditFen: result.platformCreditFen,
    beneficiaries,
  };
}

it(
  '[AC-B2-04mb#1] order-sync 已把 commission_version 升到 2、v2 快照行不存在：WAITING 单照常入账（不因版本断言整单回滚），受益人与比例取自 commission_splits，金额按入账口径 850 / 425 / 85 / 42 / 平台 448，booked 成对写、CREDITED',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    await orderSyncBump(h, o, 2);
    // The reproduced state: orders at version 2, snapshot amount rows only at version 1, and the
    // asserting snapshot reader refuses exactly this order.
    expect(await storedVersions(h, o)).toEqual([1]);
    const asserting = h.db.transaction().execute(async (trx) => {
      return commission.readCommissionSnapshot(trx, {
        appId: h.appId,
        orderId: o.orderId,
        commissionVersion: 2,
      });
    });
    await expect(asserting).rejects.toThrow(
      'expected commission_version 2 is not the current version 1',
    );
    const initial = await h.read(o);

    const a = attributed(h);
    const traced = tracing(p.db);
    const attempt = await settle(a.run(o, traced.db));
    expect(attempt).toMatchObject({
      resolved: true,
      value: {
        outcome: 'credited',
        orderKey: o.orderKey,
        bCreditFen: 850n,
        bookedNFen: 1000n,
        platformCreditFen: 448n,
      },
    });

    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 425n));
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userCreditLines(o, 'direct', 85n));
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(
      userCreditLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.balance(o.user('self'))).toBe(425n);
    expect(await h.balance(o.user('direct'))).toBe(85n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.subjectNet('COMMISSION_REVENUE')).toBe(-448n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      settle_commission_fen: 1000n,
      // The credit does not touch the version order-sync wrote.
      commission_version: 2,
      row_version: initial.row_version + 1,
    });
    expect(await h.history(o)).toEqual([
      expect.objectContaining({
        field: 'rebate',
        from_status: 'WAITING',
        to_status: 'CREDITED',
        event: 'SETTLE_BATCH_CREDIT',
        at: new Date(NOW),
      }),
    ]);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith(
      a.transactions[0],
      expect.objectContaining({ appId: h.appId, name: 'order.credited' }),
    );
    expect(await h.obligations()).toEqual([]);
    expect(await h.newBeneficiaryEvents(o)).toEqual([]);

    // The attribution came from readCommissionAttribution on the caller's transaction, after the
    // order_key lock; the asserting snapshot reader and the amount version rows were not read.
    expect(a.readAttribution).toHaveBeenCalledTimes(1);
    expect(a.readAttribution).toHaveBeenCalledWith(
      a.transactions[0],
      expect.objectContaining({ appId: h.appId, orderId: o.orderId }),
    );
    expect(h.readSnapshot).not.toHaveBeenCalled();
    const statements = traced.queries.map((q) => q.sql);
    const advisory = statements.findIndex((s) => /pg_advisory_xact_lock/i.test(s));
    const splitReads = statements.flatMap((s, i) =>
      /from\s+(?:"app"\.)?"commission_split(?:s|_beneficiary_events)"/i.test(s) ? [i] : [],
    );
    expect(advisory).toBeGreaterThanOrEqual(0);
    expect(splitReads.length).toBeGreaterThan(0);
    expect(Math.min(...splitReads)).toBeGreaterThan(advisory);
    const versioned = statements.filter((s) => /"commission_split_(?:totals|amounts)"/i.test(s));
    expect(versioned).toEqual([]);
  },
  TIMEOUT,
);

it.each([{ version: 2 }, { version: 3 }, { version: 9 }])(
  '[AC-B2-04mb#2] 同一规格两单（本人正常、直推冻结、间推封禁）：一单保持 v1，一单被 order-sync 升到 v$version 且无该版本快照行；两单入账结果、凭证分录、余额、义务、受益人事件与 booked 成对值完全一致',
  async ({ version }) => {
    const h = await harness(p.db);
    const people = [
      { role: 'self', ratioBp: 5000 },
      { role: 'direct', ratioBp: 1000, state: 'frozen' },
      { role: 'indirect', ratioBp: 500, state: 'banned' },
    ] as const;
    const v1 = await h.order({ people });
    const bumped = await h.order({ people });
    await orderSyncBump(h, bumped, version);
    expect(await storedVersions(h, bumped)).toEqual([1]);

    const a = attributed(h);
    const first = await a.run(v1);
    expect(first).toMatchObject({ outcome: 'credited', bCreditFen: 850n, platformCreditFen: 448n });
    const second = await settle(a.run(bumped));
    expect(second).toMatchObject({ resolved: true, value: { outcome: 'credited' } });

    expect(shape(bumped, resolvedValue(second))).toEqual(shape(v1, first));
    expect(await footprint(h, bumped)).toEqual(await footprint(h, v1));
    expect(await h.read(bumped)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      commission_version: version,
    });
    expect(a.readAttribution).toHaveBeenCalledTimes(2);
    expect(h.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04mb#3] 升版本后锁内逐受益人判定照旧（BR-CALC-13）：本人冻结 → held 事件 + first_credit 义务（split_ref 指向本单已有版本），直推封禁 → FORFEIT 85（banned），间推正常入账 42，平台 448，应收 = N − 暂缓 425',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000, state: 'frozen' },
        { role: 'direct', ratioBp: 1000, state: 'banned' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    await orderSyncBump(h, o, 2);
    const a = attributed(h);
    const attempt = await settle(a.run(o));
    expect(attempt).toMatchObject({
      resolved: true,
      value: {
        outcome: 'credited',
        bCreditFen: 850n,
        bookedNFen: 1000n,
        platformCreditFen: 448n,
      },
    });

    expect(await h.voucherKeys()).toEqual(
      [creditKey(o, 'indirect'), platformKey(o), forfeitKey(o, 'direct')].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(
      userCreditLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(forfeitKey(o, 'direct'))).toEqual(platformLines(o, 85n));
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.balance(o.user('self'))).toBe(0n);
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(42n);
    expect(await h.subjectNet(receivable(o))).toBe(575n);

    const obligations = await h.obligations();
    expect(obligations).toEqual([
      expect.objectContaining({
        order_id: o.orderId,
        user_id: o.user('self'),
        role: 'self',
        kind: 'first_credit',
        opened_by: 'R5',
        opened_ref: h.input(o).openedRef,
        status: 'open',
        opened_at: new Date(NOW),
      }),
    ]);
    expect(obligations[0]?.beneficiary_credit_id).toMatch(UUID);
    // BR-FUND-04 ⑫「归属快照」: commission_version:{K} with K a version of this order (1 ≤ K ≤ 2),
    // which R5a (B2-04q attributionUnchanged) accepts as the unchanged attribution.
    const ref = SPLIT_REF.exec(obligations[0]?.split_ref ?? '');
    expect(ref).not.toBeNull();
    expect(Number(ref?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(ref?.[1])).toBeLessThanOrEqual(2);

    const events = await h.newBeneficiaryEvents(o);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: o.user('self'), role: 'self', status: 'held' }),
        expect.objectContaining({
          user_id: o.user('direct'),
          role: 'direct',
          status: 'forfeited',
          reason: 'banned',
        }),
      ]),
    );
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      hold: false,
    });
    expect(h.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04mb#4] 升版本后已没收的受益人终局不变：快照阶段没收的直推与此前已有 forfeited 事件的间推（事件经归属读取带回）都不写凭证、不追加事件，份额留在平台凭证 575，应收 = N',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({
      people: [
        { role: 'self', ratioBp: 5000 },
        { role: 'direct', ratioBp: 1000, initialStatus: 'forfeited' },
        { role: 'indirect', ratioBp: 500 },
      ],
    });
    // An earlier forfeited event of the indirect beneficiary (BR-CALC-13: final).
    await h.db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: h.appId,
        order_id: o.orderId,
        user_id: o.user('indirect'),
        role: 'indirect',
        status: 'forfeited',
        reason: 'banned',
        created_at: new Date(SYNC_AT),
      })
      .execute();
    await orderSyncBump(h, o, 2);
    const eventsBefore = await h.beneficiaryEvents(o);

    const a = attributed(h);
    const attempt = await settle(a.run(o));
    // 850 − 425 (self) + 150 reserve = 575: the direct 85 and indirect 42 stay with the platform.
    expect(attempt).toMatchObject({
      resolved: true,
      value: { outcome: 'credited', bCreditFen: 850n, platformCreditFen: 575n },
    });
    expect(await h.voucherKeys()).toEqual([creditKey(o, 'self'), platformKey(o)].sort());
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 425n));
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 575n));
    expect(await h.balance(o.user('direct'))).toBe(0n);
    expect(await h.balance(o.user('indirect'))).toBe(0n);
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.obligations()).toEqual([]);
    expect(await h.beneficiaryEvents(o)).toEqual(eventsBefore);
    expect(h.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04mb#5] 对照：commission_version 未变（=1）时与 B2-04m 一致（850 / 425 / 85 / 42 / 平台 448），归属同样只经 readCommissionAttribution 在调用方事务内读取，不调用 readSnapshot',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const a = attributed(h);
    const result = await a.run(o);

    expect(result).toMatchObject({
      outcome: 'credited',
      orderKey: o.orderKey,
      bCreditFen: 850n,
      bookedNFen: 1000n,
      platformCreditFen: 448n,
    });
    expect(await h.voucherKeys()).toEqual(
      [
        creditKey(o, 'self'),
        creditKey(o, 'direct'),
        creditKey(o, 'indirect'),
        platformKey(o),
      ].sort(),
    );
    expect(await h.voucherLines(creditKey(o, 'self'))).toEqual(userCreditLines(o, 'self', 425n));
    expect(await h.voucherLines(creditKey(o, 'direct'))).toEqual(userCreditLines(o, 'direct', 85n));
    expect(await h.voucherLines(creditKey(o, 'indirect'))).toEqual(
      userCreditLines(o, 'indirect', 42n),
    );
    expect(await h.voucherLines(platformKey(o))).toEqual(platformLines(o, 448n));
    expect(await h.subjectNet(receivable(o))).toBe(1000n);
    expect(await h.read(o)).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 850n,
      booked_n_fen: 1000n,
      commission_version: 1,
    });

    expect(a.readAttribution).toHaveBeenCalledTimes(1);
    expect(a.readAttribution).toHaveBeenCalledWith(
      a.transactions[0],
      expect.objectContaining({ appId: h.appId, orderId: o.orderId }),
    );
    expect(h.readSnapshot).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[AC-B2-04mb#6] 归属读取抛错（子订单没有分佣快照）：整单抛错且什么都不写，不退回 readSnapshot、不按空归属把整单归平台',
  async () => {
    const h = await harness(p.db);
    const o = await h.order();
    const before = await h.state();
    const a = attributed(h);
    a.readAttribution.mockRejectedValueOnce(
      new Error('commission: the sub-order has no commission snapshot'),
    );

    await expect(a.run(o)).rejects.toThrow('no commission snapshot');
    expect(a.readAttribution).toHaveBeenCalledTimes(1);
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(h.post).not.toHaveBeenCalled();
    expect(await h.state()).toEqual(before);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04mb#7] 升版本后的淘礼金单（tlj_deduct_fen 100 > 0，D10-272）：照常跳过（tlj_deduct_unsupported）并告警，不抛版本错误，什么都不写，保持 WAITING',
  async () => {
    const h = await harness(p.db);
    const o = await h.order({ tljDeductFen: 100n });
    await orderSyncBump(h, o, 2);
    const before = await h.state();
    const a = attributed(h);

    expect(await settle(a.run(o))).toEqual({
      resolved: true,
      value: { outcome: 'skipped', reason: 'tlj_deduct_unsupported' },
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.readSnapshot).not.toHaveBeenCalled();
    expect(await h.state()).toEqual(before);
    expect(await h.read(o)).toMatchObject({ rebate_status: 'WAITING', commission_version: 2 });
    const alerts = a.logs.filter((line) => line['alert'] === 'credit_tlj_deduct_unsupported');
    expect(alerts).toHaveLength(1);
    expect(Number(alerts[0]?.['level'])).toBeGreaterThanOrEqual(40);
    expect(alerts[0]).toMatchObject({ app_id: h.appId, order_id: o.orderId });
  },
  TIMEOUT,
);
