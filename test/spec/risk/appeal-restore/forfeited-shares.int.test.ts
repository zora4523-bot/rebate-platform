// B1-03z: commission's read-only port listBannedForfeitedShares (task brief 9.2 ③; contract in
// apps/api/src/modules/commission/application/forfeited-shares.ts): the member's shares with a
// forfeited event of reason banned inside [since, until] (both inclusive), with the share's value
// from the split snapshot; deleted / minor never; nothing written. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  listBannedForfeitedShares,
  type BannedForfeitedShare,
} from '../../../../apps/api/src/modules/commission/application/forfeited-shares.ts';
import { openSuite, scenario, type Suite } from './db-kit.ts';
import { CLOSED_AT, EARLIER_BAN_AT, IN_BAN_1, IN_BAN_2, LATER_BAN_AT, PENALTY_AT } from './kit.ts';

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
