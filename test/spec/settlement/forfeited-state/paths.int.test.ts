// B2-09ga funds-path rule tests (claude-independent, SPEC_REF 9ab94dc0): 编排裁定 D10-481 ②, 08
// BR-FUND-22 ③「补发后该受益人不再按被剥夺处理」, BR-CALC-09, BR-CALC-13 — the same event histories run
// through the real entries of credit-order, pending-earnings, clawback-order and beneficiary-credit,
// and each path agrees with the one judgement. A history where the old `initialStatus === 'forfeited'
// || listed` and the judgement differ (initial forfeited then restored, a held event after a
// forfeited one) fails on any path that keeps its own copy.
// The restore through the admin entry refuses an order without a booked base, so on the paths before
// the credit the active event comes from commission's event writer, the writer the restore uses.
// Default order (kit.ts): N 1000, reserve 1500 → B 850; self 425 / direct 85 / indirect 42. Expected
// amounts are written by hand. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  appendShareEvent,
  available,
  creditOf,
  executeItem,
  expectClawbacks,
  fixture,
  judged,
  leaveObligationOpen,
  memberOf,
  netOf,
  netsOf,
  obligationsOf,
  partialRights,
  restoreShare,
  seedShareOrder,
  setRiskState,
  shareEvents,
  suite,
  threePeople,
  voucherKeysOf,
  type Reason,
  type ShareStep,
  type StateFixture,
} from './kit.ts';

const s = suite();

const ACTIVE: ShareStep = { status: 'active', reason: null };
const HELD: ShareStep = { status: 'held', reason: null };
const BANNED: ShareStep = { status: 'forfeited', reason: 'banned' };

interface History {
  readonly label: string;
  /** forfeit_reason of the snapshot's initial forfeited status; null: initially active. */
  readonly initial: Reason | null;
  /** Events of the direct share after the snapshot. */
  readonly steps: readonly ShareStep[];
  readonly forfeited: boolean;
}

const HISTORIES: readonly History[] = [
  { label: '初始 forfeited 未恢复', initial: 'banned', steps: [], forfeited: true },
  { label: '初始 forfeited + 恢复 active', initial: 'banned', steps: [ACTIVE], forfeited: false },
  { label: '初始 active → forfeited', initial: null, steps: [BANNED], forfeited: true },
  {
    label: 'forfeited → active → forfeited',
    initial: null,
    steps: [BANNED, ACTIVE, BANNED],
    forfeited: true,
  },
  {
    label: '初始 forfeited → active → forfeited',
    initial: 'banned',
    steps: [ACTIVE, BANNED],
    forfeited: true,
  },
  { label: 'forfeited 之后 held', initial: null, steps: [BANNED, HELD], forfeited: false },
  { label: '从未被剥夺', initial: null, steps: [], forfeited: false },
];

/** The history's order: the direct share carries the initial status and the events. */
async function historyOrder(
  f: StateFixture,
  status: 'ESTIMATED' | 'WAITING',
  history: Pick<History, 'initial' | 'steps'>,
  userId?: string,
) {
  const order = await seedShareOrder(f, {
    status,
    people: threePeople({ userId, initial: history.initial }),
  });
  for (const step of history.steps) {
    await appendShareEvent(f, order.orderId, order.user('direct'), 'direct', step);
  }
  return order;
}

it.each(HISTORIES)(
  '[AC-B2-09ga#11] credit-order 入账与判定一致（R5，真实 credit 入口）：被剥夺 → 不写凭证不加事件、份额 85 留平台（PLATFORM:CREDIT 533）；否则按恢复后的份额入账 85（PLATFORM:CREDIT 448）——$label',
  async (history) => {
    const f = await fixture(s);
    const order = await historyOrder(f, 'WAITING', history);
    const direct = order.user('direct');
    expect(await judged(f, order.orderId, direct, 'direct')).toBe(history.forfeited);
    const eventsBefore = await shareEvents(f, order.orderId);

    const result = await creditOf(f, order);

    expect(result).toMatchObject({
      outcome: 'credited',
      bCreditFen: 850n,
      bookedNFen: 1000n,
      platformCreditFen: history.forfeited ? 533n : 448n,
    });
    expect(result).toMatchObject({
      beneficiaries: expect.arrayContaining([
        expect.objectContaining({
          userId: direct,
          role: 'direct',
          shareFen: history.forfeited ? 0n : 85n,
          action: history.forfeited ? 'forfeited' : 'credit',
          forfeitReason: null,
        }),
      ]) as unknown,
    });
    const paid = [
      `${order.orderKey}:${order.user('self')}:self:CREDIT`,
      `${order.orderKey}:${order.user('indirect')}:indirect:CREDIT`,
      `${order.orderKey}:PLATFORM:CREDIT`,
    ];
    if (!history.forfeited) paid.push(`${order.orderKey}:${direct}:direct:CREDIT`);
    expect(await voucherKeysOf(f, order)).toEqual(paid.sort());
    expect(await available(f, direct)).toBe(history.forfeited ? 0n : 85n);
    expect(await shareEvents(f, order.orderId)).toEqual(eventsBefore);
  },
);

it.each(HISTORIES)(
  '[AC-B2-09ga#12] pending-earnings 预估与判定一致（BR-FUND-18，真实 forUser / forApp 入口）：ESTIMATED 与 WAITING 各一单，被剥夺的份额为 0，否则按恢复后的份额 85——$label',
  async (history) => {
    const f = await fixture(s);
    const direct = await memberOf(f);
    const estimated = await historyOrder(f, 'ESTIMATED', history, direct);
    const waiting = await historyOrder(f, 'WAITING', history, direct);
    expect(await judged(f, estimated.orderId, direct, 'direct')).toBe(history.forfeited);
    expect(await judged(f, waiting.orderId, direct, 'direct')).toBe(history.forfeited);
    const share = history.forfeited ? 0n : 85n;

    const mine = await f.db
      .transaction()
      .execute((trx) => f.pending.forUser(trx, { appId: f.appId, userId: direct }));
    const app = await f.db
      .transaction()
      .execute((trx) => f.pending.forApp(trx, { appId: f.appId }));

    expect(mine).toEqual({
      estimated_total_fen: 2n * share,
      estimated_fen: share,
      pending_credit_fen: share,
      pending_credit_paused_fen: 0n,
      next_credit_period: null,
      credit_overdue: false,
    });
    expect(app).toEqual({
      total_waiting_fen: 467n + share,
      total_estimated_fen: 467n + share,
    });
  },
);

interface ClawbackRow {
  readonly label: string;
  readonly initial: Reason | null;
  /** Events before the credit. */
  readonly before: readonly ShareStep[];
  /** The restore through the admin entry after the credit (pays 85). */
  readonly restore: boolean;
  /** Events after the restore. */
  readonly after: readonly ShareStep[];
  readonly forfeited: boolean;
  /** What the clawback takes from the direct share. */
  readonly directFen: bigint;
  /** What it takes from the platform. */
  readonly platformFen: bigint;
  /** The direct share's net afterwards. */
  readonly directNetFen: bigint;
}

// N 1000 → 600, B 850 → 510: self 425 → 255 (170), indirect 42 → 25 (17). The platform ends at
// 600 − 255 − 25 − the direct share's net.
const CLAWBACKS: readonly ClawbackRow[] = [
  {
    label: '初始 forfeited 未恢复：直推不扣不补，净额 0，平台 533 → 320',
    initial: 'banned',
    before: [],
    restore: false,
    after: [],
    forfeited: true,
    directFen: 0n,
    platformFen: 213n,
    directNetFen: 0n,
  },
  {
    label: '初始 forfeited + 恢复：直推按重拆份额 51 扣 34，平台 448 → 269',
    initial: 'banned',
    before: [],
    restore: true,
    after: [],
    forfeited: false,
    directFen: 34n,
    platformFen: 179n,
    directNetFen: 51n,
  },
  {
    label: '初始 active → forfeited：直推不扣不补，净额 0，平台 533 → 320',
    initial: null,
    before: [BANNED],
    restore: false,
    after: [],
    forfeited: true,
    directFen: 0n,
    platformFen: 213n,
    directNetFen: 0n,
  },
  {
    label: 'forfeited → 恢复 → forfeited：又被剥夺，直推净额 85 不动，平台 448 → 235',
    initial: null,
    before: [BANNED],
    restore: true,
    after: [BANNED],
    forfeited: true,
    directFen: 0n,
    platformFen: 213n,
    directNetFen: 85n,
  },
  {
    label: '初始 forfeited → 恢复 → forfeited：又被剥夺，直推净额 85 不动，平台 448 → 235',
    initial: 'banned',
    before: [],
    restore: true,
    after: [BANNED],
    forfeited: true,
    directFen: 0n,
    platformFen: 213n,
    directNetFen: 85n,
  },
  {
    label: 'forfeited 之后 held：不算被剥夺，入账 85 后按重拆份额 51 扣 34，平台 448 → 269',
    initial: null,
    before: [BANNED, HELD],
    restore: false,
    after: [],
    forfeited: false,
    directFen: 34n,
    platformFen: 179n,
    directNetFen: 51n,
  },
  {
    label: '从未被剥夺：按重拆份额 51 扣 34，平台 448 → 269',
    initial: null,
    before: [],
    restore: false,
    after: [],
    forfeited: false,
    directFen: 34n,
    platformFen: 179n,
    directNetFen: 51n,
  },
];

it.each(CLAWBACKS)(
  '[AC-B2-09ga#13] clawback-order 扣回与判定一致（R9，真实 apply 入口，佣金 1000 → 600）——$label',
  async (row) => {
    const f = await fixture(s);
    const order = await historyOrder(f, 'WAITING', { initial: row.initial, steps: row.before });
    const direct = order.user('direct');
    await creditOf(f, order);
    if (row.restore) await restoreShare(f, order, direct, 'direct', 85);
    for (const step of row.after) {
      await appendShareEvent(f, order.orderId, direct, 'direct', step);
    }
    expect(await judged(f, order.orderId, direct, 'direct')).toBe(row.forfeited);

    const { result, eventId } = await partialRights(f, order, 600n);

    expect(result).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      bookedBaseFen: 510n,
      bookedNFen: 600n,
    });
    const buyer = order.user('self');
    const indirect = order.user('indirect');
    await expectClawbacks(
      f,
      order,
      eventId,
      [
        [buyer, 'self', 170n],
        [indirect, 'indirect', 17n],
        ...(row.directFen > 0n ? ([[direct, 'direct', row.directFen]] as const) : []),
      ],
      row.platformFen,
    );
    const nets = await netsOf(f, order.orderKey);
    expect(netOf(nets, buyer, 'self')).toBe(255n);
    expect(netOf(nets, indirect, 'indirect')).toBe(25n);
    expect(netOf(nets, direct, 'direct')).toBe(row.directNetFen);
    expect(nets.platform_net_fen).toBe(320n - row.directNetFen);
    expect(nets.union_receivable_net_fen).toBe(600n);
    expect(await available(f, direct)).toBe(row.directNetFen);
  },
);

it.each(HISTORIES.filter((history) => !history.forfeited))(
  '[AC-B2-09ga#14] beneficiary-credit 补记与判定一致（R5a，真实 execute 入口）：不算被剥夺的份额入账时冻结暂缓，解冻后补记 85、义务 done、⑤ 成立不跳过——$label',
  async (history) => {
    const f = await fixture(s);
    const order = await historyOrder(f, 'WAITING', history);
    const direct = order.user('direct');
    expect(await judged(f, order.orderId, direct, 'direct')).toBe(false);
    await setRiskState(f, direct, 'frozen');
    await creditOf(f, order);
    const [obligation] = await obligationsOf(f, order, 'direct');
    expect(obligation, 'the first_credit obligation of the held share').toBeDefined();
    await setRiskState(f, direct, 'normal');

    const result = await executeItem(f, order, obligation!.beneficiary_credit_id);

    expect(result).toMatchObject({
      outcome: 'credited',
      userId: direct,
      role: 'direct',
      amountFen: 85n,
    });
    expect(await voucherKeysOf(f, order)).toContain(`${order.orderKey}:${direct}:direct:CREDIT`);
    expect(await available(f, direct)).toBe(85n);
    expect((await obligationsOf(f, order, 'direct'))[0]).toMatchObject({ status: 'done' });
  },
);

it.each(HISTORIES.filter((history) => history.forfeited))(
  '[AC-B2-09ga#15] beneficiary-credit 与判定一致（R5a，真实 execute 入口）：被剥夺的份额即使留着未完成义务也不补记：金额 0、无凭证、义务按 0 关闭、余额不变——$label',
  async (history) => {
    const f = await fixture(s);
    const order = await historyOrder(f, 'WAITING', history);
    const direct = order.user('direct');
    expect(await judged(f, order.orderId, direct, 'direct')).toBe(true);
    await creditOf(f, order);
    const keysBefore = await voucherKeysOf(f, order);
    const id = await leaveObligationOpen(f, order, direct, 'direct');

    const result = await executeItem(f, order, id);

    expect(result).toMatchObject({
      outcome: 'credited',
      userId: direct,
      role: 'direct',
      amountFen: 0n,
      voucherId: null,
    });
    expect(await voucherKeysOf(f, order)).toEqual(keysBefore);
    expect(await available(f, direct)).toBe(0n);
    expect((await obligationsOf(f, order, 'direct'))[0]).toMatchObject({ status: 'done' });
  },
);
