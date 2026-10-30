// B1-03z: 「本次封禁」 and the forfeit reasons (08 BR-CALC-13 细则「申诉恢复」: 「因本次封禁 forfeited 的
// 份额（forfeit_reason=banned）…注销、未成年导致的 forfeited 不恢复」; task brief 9.2 ②③: the window is the
// appeal's penalty_started_at to its closed_at; without penalty_started_at it starts at the member's
// most recent banned forfeiture before the appeal was filed). Each case keeps one share that must be
// restored, so that a producer writing nothing cannot pass. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectRestore, openSuite, scenario, type Suite } from './db-kit.ts';
import { EARLIER_BAN_AT, IN_BAN_1, IN_BAN_2, LATER_BAN_AT } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it('[B1-03z 本次封禁] 封禁开始前（别的封禁周期）与申诉结案后（下一次封禁）被没收的份额不生成；只登记 penalty_started_at 至 closed_at 之间的那份', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const earlier = await f.order([{ userId: member, role: 'direct', amountFen: 70n }]);
  const inside = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const later = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  await f.forfeit(earlier, { userId: member, role: 'direct' }, 'banned', EARLIER_BAN_AT);
  await f.forfeit(inside, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(later, { userId: member, role: 'share' }, 'banned', LATER_BAN_AT);
  const appeal = await f.appeal({ userId: member });

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f.appId, {
    appealId: appeal.id,
    orderId: inside,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
});

it('[B1-03z 没收原因] 本次封禁期间因注销（deleted）、未成年（minor）被没收的份额，以及只是 held / active 的份额，都不生成；banned 的那份照常登记', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const deleted = await f.order([{ userId: member, role: 'self', amountFen: 410n }]);
  const minor = await f.order([{ userId: member, role: 'indirect', amountFen: 42n }]);
  const held = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  const banned = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  await f.forfeit(deleted, { userId: member, role: 'self' }, 'deleted', IN_BAN_1);
  await f.forfeit(minor, { userId: member, role: 'indirect' }, 'minor', IN_BAN_1);
  await f.shareEvent(held, member, 'share', 'held', null, IN_BAN_1);
  await f.forfeit(banned, { userId: member, role: 'direct' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f.appId, {
    appealId: appeal.id,
    orderId: banned,
    userId: member,
    role: 'direct',
    amountFen: 85n,
  });
});

it('[B1-03z 只恢复申诉人] 同期被封禁没收的其他会员份额（含同一子订单上的其他角色）不因本申诉生成', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const stranger = await f.user();
  const shared = await f.order([
    { userId: stranger, role: 'self', amountFen: 425n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  const strangers = await f.order([{ userId: stranger, role: 'share', amountFen: 300n }]);
  await f.forfeit(shared, { userId: stranger, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(shared, { userId: member, role: 'direct' }, 'banned', IN_BAN_1);
  await f.forfeit(strangers, { userId: stranger, role: 'share' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f.appId, {
    appealId: appeal.id,
    orderId: shared,
    userId: member,
    role: 'direct',
    amountFen: 85n,
  });
});

it('[B1-03z 存量申诉] penalty_started_at 为空时以申诉提交前最近一次 banned 没收起算：该份登记，结案后的没收不生成', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const inside = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const later = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  await f.forfeit(inside, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(later, { userId: member, role: 'direct' }, 'banned', LATER_BAN_AT);
  const appeal = await f.appeal({ userId: member, penaltyStartedAt: null });

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f.appId, {
    appealId: appeal.id,
    orderId: inside,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
});
