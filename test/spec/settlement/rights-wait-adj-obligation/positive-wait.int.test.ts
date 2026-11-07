// B2-04zza regression: only the positive difference keeps waiting. A CREDITED order whose rights
// success waits for the union (WAIT_COMMISSION) receives the union's new settlement record above
// the booked pair (BR-FUND-09 ②: B_settle > booked_base_fen, or equal and the settlement
// commission's positive part > booked_n_fen). The positive-difference candidate is not built here
// (FU-SETTLE-ADJ-POSITIVE): nothing is posted, the rights record keeps WAIT_COMMISSION, no
// candidate row, no obligation disposed of, and one alert line (rights_settle_adjust_unsupported)
// names the order — whatever the beneficiaries' states.
//
// Default order: B 850 / N 1000. Record 1200 → B 1020 (> 850). Record 1001 → B 850 (850.85 floored),
// N 1001 > 1000.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  ALERT_HELD,
  LATER,
  TIMEOUT,
  databaseFixture,
  harness,
  people,
  type Harness,
  type SeededOrder,
} from './kit.ts';

const p = databaseFixture(createTestDatabase);

async function expectStillWaiting(
  h: Harness,
  o: SeededOrder,
  settleAfter: bigint,
  waitingId: string,
): Promise<void> {
  const money = await h.moneyState(o);
  const obligations = await h.orderObligations(o);
  const events = await h.newBeneficiaryEvents(o);

  h.clock.set(LATER);
  const { result } = await h.arrive(o, { settleAfter, newSeq: 3 });

  expect(result).toMatchObject({ outcome: 'wait_commission', orderKey: o.orderKey });
  expect(await h.moneyState(o)).toEqual(money);
  expect(await h.onlyRights(o)).toMatchObject({ id: waitingId, status: 'WAIT_COMMISSION' });
  expect((await h.read(o)).rights_pending).toBe(true);
  expect(await h.pendingRows(o)).toEqual([
    expect.objectContaining({ reason: 'CLAWBACK_NO_COMMISSION', status: 'open' }),
  ]);
  expect(await h.clawbackKeys(o)).toEqual([]);
  expect((await h.orderVoucherKeys(o)).filter((k) => k.includes(':ADJ:'))).toEqual([]);
  expect(await h.orderObligations(o)).toEqual(obligations);
  expect(await h.newBeneficiaryEvents(o)).toEqual(events);
  expect(await h.candidates(o)).toEqual([]);
  expect(await h.rebateHistoryAfterCredit(o)).toEqual([]);
  expect(h.heldAlerts()).toEqual([
    expect.objectContaining({
      alert: ALERT_HELD,
      app_id: h.appId,
      order_id: o.orderId,
      order_key: o.orderKey,
    }),
  ]);
}

it(
  '[AC-B2-04zza#9] 回归：受益人都正常，维权等佣金中联盟新结算记录 1200（B 1020 > booked 850）是正差 → 仍等待并告警（rights_settle_adjust_unsupported），不记账、不生成候选、维权记录仍 WAIT_COMMISSION、rights_pending 仍 true',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting();
    await expectStillWaiting(h, o, 1200n, waitingId);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zza#10] 回归：基数相等而结算佣金高于 booked_n（新记录 1001 → B 仍 850、N 1001 > 1000）也是正差 → 仍等待并告警，什么都不写',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting();
    await expectStillWaiting(h, o, 1001n, waitingId);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zza#11] 回归：本人入账时冻结（first_credit 义务）且仍冻结，正差记录 1200 → 仍等待并告警，义务原样、不补给、不进候选',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting({ people: people({ self: 'frozen' }) });
    await expectStillWaiting(h, o, 1200n, waitingId);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zza#12] 回归：本人入账时冻结、之后封禁（有 first_credit 义务），正差记录 1200 → 仍等待并告警：义务不没收、不追加 forfeited 事件、不记账',
  async () => {
    const h = await harness(p.db);
    const { o, waitingId } = await h.waiting({ people: people({ self: 'frozen' }) }, (seeded) =>
      h.setState(seeded, 'self', 'banned'),
    );
    await expectStillWaiting(h, o, 1200n, waitingId);
  },
  TIMEOUT,
);
