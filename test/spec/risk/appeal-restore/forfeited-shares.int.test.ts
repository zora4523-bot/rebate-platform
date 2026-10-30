// B1-03z: commission's read-only port listBannedForfeitedShares (task brief 9.2 ③; contract in
// apps/api/src/modules/commission/application/forfeited-shares.ts): the member's shares with a
// forfeited event of reason banned inside [since, until] (both inclusive), with the share's value
// from the split snapshot; deleted / minor never; nothing written. Attempt 4 (funds review S1):
// findBannedRunStart, the start of the member's last unbroken run of banned forfeitures in
// (notBefore, until], broken by any other share event of the member. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  findBannedRunStart,
  listBannedForfeitedShares,
  type BannedForfeitedShare,
} from '../../../../apps/api/src/modules/commission/application/forfeited-shares.ts';
import { openSuite, scenario, type Suite } from './db-kit.ts';
import {
  APPEAL_AT,
  BATCH_2,
  BATCH_3,
  BREAK_AT,
  CLOSED_AT,
  EARLIER_BAN_AT,
  IN_BAN_1,
  IN_BAN_2,
  LATER_BAN_AT,
  PENALTY_AT,
} from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

/** Only the contract's four fields: an implementation may carry more. */
function picked(shares: readonly BannedForfeitedShare[]) {
  return shares.map(({ orderId, role, amountFen, forfeitedAt }) => ({
    orderId,
    role,
    amountFen,
    forfeitedAt,
  }));
}

it('[B1-03z commission 只读端口] 窗口内（两端含）reason=banned 的没收份额按没收时刻升序返回订单、角色、份额值与没收时刻；窗口外、deleted / minor、held / active、其他会员一律不返回；不写任何表', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const stranger = await f.user();
  const atStart = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const middle = await f.order([
    { userId: stranger, role: 'self', amountFen: 500n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  const atEnd = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  const outside = await f.order([{ userId: member, role: 'indirect', amountFen: 42n }]);
  const otherReasons = await f.order([{ userId: member, role: 'self', amountFen: 410n }]);
  const minor = await f.order([{ userId: member, role: 'direct', amountFen: 77n }]);
  const held = await f.order([{ userId: member, role: 'self', amountFen: 99n }]);
  await f.forfeit(atStart, { userId: member, role: 'self' }, 'banned', PENALTY_AT);
  await f.forfeit(middle, { userId: member, role: 'direct' }, 'banned', IN_BAN_1);
  await f.forfeit(middle, { userId: stranger, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(atEnd, { userId: member, role: 'share' }, 'banned', CLOSED_AT);
  await f.forfeit(outside, { userId: member, role: 'indirect' }, 'banned', EARLIER_BAN_AT);
  await f.forfeit(outside, { userId: member, role: 'indirect' }, 'banned', LATER_BAN_AT);
  await f.forfeit(otherReasons, { userId: member, role: 'self' }, 'deleted', IN_BAN_2);
  await f.forfeit(minor, { userId: member, role: 'direct' }, 'minor', IN_BAN_2);
  await f.shareEvent(held, member, 'self', 'held', null, IN_BAN_2);
  const before = await f.untouched();

  const shares = await f.db.transaction().execute((trx) =>
    listBannedForfeitedShares(trx, {
      appId: f.appId,
      userId: member,
      since: PENALTY_AT,
      until: CLOSED_AT,
    }),
  );

  expect(picked(shares)).toStrictEqual([
    { orderId: atStart, role: 'self', amountFen: 425n, forfeitedAt: PENALTY_AT },
    { orderId: middle, role: 'direct', amountFen: 85n, forfeitedAt: IN_BAN_1 },
    { orderId: atEnd, role: 'share', amountFen: 300n, forfeitedAt: CLOSED_AT },
  ]);
  expect(await f.untouched()).toEqual(before);
  expect(await f.diffs()).toEqual([]);
});

it('[B1-03z commission 只读端口] 没有符合条件的份额 → 空数组；别的 app 同一会员 id 的份额不串', async () => {
  const f = await scenario(suite);
  const other = await scenario(suite);
  const member = await f.user();
  const elsewhere = await other.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await other.forfeit(elsewhere, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const mine = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(mine, { userId: member, role: 'self' }, 'deleted', IN_BAN_1);

  const shares = await f.db.transaction().execute((trx) =>
    listBannedForfeitedShares(trx, {
      appId: f.appId,
      userId: member,
      since: PENALTY_AT,
      until: CLOSED_AT,
    }),
  );

  expect(picked(shares)).toStrictEqual([]);
});

it('[B1-03z commission 只读端口 findBannedRunStart] 同批三份连续 banned 没收 → 起点是最早那份；被 active 事件隔开的上一周期不算；其他会员的没收不接续；notBefore 为排他下界；(notBefore, until] 内没有 banned 没收 → null；不写任何表', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const stranger = await f.user();
  const earlier = await f.order([{ userId: member, role: 'indirect', amountFen: 42n }]);
  const first = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const second = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  const third = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  const later = await f.order([{ userId: member, role: 'direct', amountFen: 70n }]);
  const strangers = await f.order([{ userId: stranger, role: 'self', amountFen: 410n }]);
  await f.forfeit(earlier, { userId: member, role: 'indirect' }, 'banned', EARLIER_BAN_AT);
  await f.order([{ userId: member, role: 'self', amountFen: 99n }], { at: BREAK_AT });
  await f.forfeit(strangers, { userId: stranger, role: 'self' }, 'banned', PENALTY_AT);
  await f.forfeit(first, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(second, { userId: member, role: 'direct' }, 'banned', BATCH_2);
  await f.forfeit(third, { userId: member, role: 'share' }, 'banned', BATCH_3);
  await f.forfeit(later, { userId: member, role: 'direct' }, 'banned', LATER_BAN_AT);
  const before = await f.untouched();

  const runStart = (until: Date, notBefore: Date | null) =>
    f.db
      .transaction()
      .execute((trx) =>
        findBannedRunStart(trx, { appId: f.appId, userId: member, until, notBefore }),
      );

  expect(await runStart(APPEAL_AT, null)).toEqual(IN_BAN_1);
  expect(await runStart(APPEAL_AT, IN_BAN_1)).toEqual(BATCH_2);
  expect(await runStart(new Date('2026-09-03T00:00:00.000Z'), null)).toEqual(EARLIER_BAN_AT);
  expect(await runStart(APPEAL_AT, BATCH_3)).toBeNull();
  expect(await f.untouched()).toEqual(before);
  expect(await f.diffs()).toEqual([]);
});

it('[B1-03z commission 只读端口 findBannedRunStart] 注销 / 未成年原因的没收与 held 事件都打断连续段：起点是其后最早的 banned 没收', async () => {
  for (const breaker of ['deleted', 'minor', 'held'] as const) {
    const f = await scenario(suite);
    const member = await f.user();
    const prior = await f.order([{ userId: member, role: 'indirect', amountFen: 42n }]);
    const between = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
    const after = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
    await f.forfeit(prior, { userId: member, role: 'indirect' }, 'banned', PENALTY_AT);
    if (breaker === 'held') {
      await f.shareEvent(between, member, 'share', 'held', null, IN_BAN_1);
    } else {
      await f.forfeit(between, { userId: member, role: 'share' }, breaker, IN_BAN_1);
    }
    await f.forfeit(after, { userId: member, role: 'self' }, 'banned', IN_BAN_2);

    const start = await f.db.transaction().execute((trx) =>
      findBannedRunStart(trx, {
        appId: f.appId,
        userId: member,
        until: APPEAL_AT,
        notBefore: null,
      }),
    );

    expect({ breaker, start }).toEqual({ breaker, start: IN_BAN_2 });
  }
});
