// B1-03zf (编排 D10-495, B2-09ga money 评审范围外 S2 at commission forfeited-shares.ts): commission's
// listBannedForfeitedShares follows the latest-event rule of 编排裁定 D10-481 ② (the one judgement of
// 「该受益人份额是否被剥夺」): for each share (order_id, user_id, role) only its latest share event
// counts — latest by event_seq, never by created_at — and the share is listed only when that latest
// event is forfeited with reason banned (inside [since, until], both inclusive). A banned forfeiture
// later covered by an active or held event, or by a forfeiture for another reason (deleted / minor),
// is not listed; forfeited(deleted / minor) never is. risk's appeal restore producer then registers
// nothing for a covered share. Fixtures are B1-03z's (db-kit.ts: synthetic rows only).
// Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  listBannedForfeitedShares,
  type BannedForfeitedShare,
} from '../../../../apps/api/src/modules/commission/application/forfeited-shares.ts';
import { expectRestore, openSuite, scenario, type Suite } from '../appeal-restore/db-kit.ts';
import { BATCH_2, CLOSED_AT, IN_BAN_1, IN_BAN_2, PENALTY_AT } from '../appeal-restore/kit.ts';

/** R5: a share credited held while the member was frozen, before this ban began (PENALTY_AT). */
const FROZEN_CREDIT_AT = new Date('2026-09-08T00:00:00.000Z');

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

it('[B1-03zf 最新事件规则 D10-481 ②] 份额只看最新一条事件：先 forfeited(banned) 后被 active / held / forfeited(deleted) 覆盖 → 不列；先 active（或 R5 held）后 forfeited(banned) → 列；没收、恢复、再没收 → 列且没收时刻取最新那条；forfeited(deleted / minor) → 不列', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const coveredByActive = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const coveredByHeld = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  const coveredByDeleted = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  const activeThenBanned = await f.order([{ userId: member, role: 'indirect', amountFen: 42n }]);
  const heldThenBanned = await f.order([{ userId: member, role: 'direct', amountFen: 77n }]);
  const reForfeited = await f.order([{ userId: member, role: 'self', amountFen: 410n }]);
  const deleted = await f.order([{ userId: member, role: 'share', amountFen: 99n }]);
  const minor = await f.order([{ userId: member, role: 'self', amountFen: 66n }]);

  await f.forfeit(coveredByActive, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.shareEvent(coveredByActive, member, 'self', 'active', null, IN_BAN_2);
  await f.forfeit(coveredByHeld, { userId: member, role: 'direct' }, 'banned', IN_BAN_1);
  await f.shareEvent(coveredByHeld, member, 'direct', 'held', null, IN_BAN_2);
  await f.forfeit(coveredByDeleted, { userId: member, role: 'share' }, 'banned', IN_BAN_1);
  await f.forfeit(coveredByDeleted, { userId: member, role: 'share' }, 'deleted', IN_BAN_2);
  await f.forfeit(activeThenBanned, { userId: member, role: 'indirect' }, 'banned', IN_BAN_1);
  await f.shareEvent(heldThenBanned, member, 'direct', 'held', null, FROZEN_CREDIT_AT);
  await f.forfeit(heldThenBanned, { userId: member, role: 'direct' }, 'banned', BATCH_2, null);
  await f.forfeit(reForfeited, { userId: member, role: 'self' }, 'banned', PENALTY_AT);
  await f.shareEvent(reForfeited, member, 'self', 'active', null, IN_BAN_1);
  await f.forfeit(reForfeited, { userId: member, role: 'self' }, 'banned', IN_BAN_2);
  await f.forfeit(deleted, { userId: member, role: 'share' }, 'deleted', IN_BAN_1);
  await f.forfeit(minor, { userId: member, role: 'self' }, 'minor', IN_BAN_1);
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
    { orderId: activeThenBanned, role: 'indirect', amountFen: 42n, forfeitedAt: IN_BAN_1 },
    { orderId: heldThenBanned, role: 'direct', amountFen: 77n, forfeitedAt: BATCH_2 },
    { orderId: reForfeited, role: 'self', amountFen: 410n, forfeitedAt: IN_BAN_2 },
  ]);
  expect(await f.untouched()).toEqual(before);
  expect(await f.diffs()).toEqual([]);
});

it('[B1-03zf 最新事件规则 D10-481 ②] 「最新」只按 event_seq 定、不按 created_at：forfeited(banned) 之后写入、created_at 却更早的 active 事件 → 已覆盖、不列；active 之后写入、created_at 更早的 forfeited(banned) → 列', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const covered = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const forfeited = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  // event_seq order: the forfeiture first, then the active event stamped earlier.
  await f.forfeit(covered, { userId: member, role: 'self' }, 'banned', IN_BAN_2);
  await f.shareEvent(covered, member, 'self', 'active', null, IN_BAN_1);
  // event_seq order: the active event first, then the forfeiture stamped earlier.
  await f.shareEvent(forfeited, member, 'direct', 'active', null, IN_BAN_2);
  await f.forfeit(forfeited, { userId: member, role: 'direct' }, 'banned', IN_BAN_1);

  const shares = await f.db.transaction().execute((trx) =>
    listBannedForfeitedShares(trx, {
      appId: f.appId,
      userId: member,
      since: PENALTY_AT,
      until: CLOSED_AT,
    }),
  );

  expect(picked(shares)).toStrictEqual([
    { orderId: forfeited, role: 'direct', amountFen: 85n, forfeitedAt: IN_BAN_1 },
  ]);
});

it('[B1-03zf 最新事件规则] 撤销封禁申诉时，本次封禁内被没收、之后又被 active 覆盖的份额不登记差错单；最新事件仍为 forfeited(banned) 的份额照常登记（凭证金额）', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const covered = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const kept = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  await f.forfeit(covered, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.shareEvent(covered, member, 'self', 'active', null, IN_BAN_2);
  await f.forfeit(kept, { userId: member, role: 'share' }, 'banned', IN_BAN_2, 310n);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: kept,
    userId: member,
    role: 'share',
    amountFen: 310n,
  });
  expect(await f.untouched()).toEqual(before);
});
