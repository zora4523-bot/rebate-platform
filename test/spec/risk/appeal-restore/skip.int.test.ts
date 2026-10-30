// B1-03z: only a revoked account appeal against a ban (prev_risk_state banned) restores shares
// (task brief 9.2 ①). Upholding, a freeze appeal, an order appeal (settlement's appeal_restore, not
// this producer) and a blocked request's appeal are acknowledged with nothing written, even when
// the member has shares forfeited for a ban in the window. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSuite, scenario, type AppealInput, type Suite } from './db-kit.ts';
import { IN_BAN_1, IN_BAN_2 } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

const cases: ReadonlyArray<[string, (userId: string) => AppealInput]> = [
  ['封禁申诉维持（upheld）', (userId) => ({ userId, status: 'upheld', prev: 'banned' })],
  ['冻结申诉撤销（prev=frozen）', (userId) => ({ userId, status: 'revoked', prev: 'frozen' })],
  ['冻结申诉维持', (userId) => ({ userId, status: 'upheld', prev: 'frozen' })],
  ['订单申诉撤销', (userId) => ({ userId, targetType: 'order', status: 'revoked' })],
  ['订单申诉维持', (userId) => ({ userId, targetType: 'order', status: 'upheld' })],
  [
    '被拦截请求申诉撤销（提现）',
    (userId) => ({ userId, targetType: 'blocked_request', requestType: 'withdraw' }),
  ],
  [
    '被拦截请求申诉撤销（注册，无 user_id）',
    () => ({ userId: null, targetType: 'blocked_request', requestType: 'register' }),
  ],
];

it.each(cases)(
  '[B1-03z 不生成] %s → 处理器正常确认，不写差错单、不入账、不动份额事件与申诉行',
  async (_label, input) => {
    const f = await scenario(suite);
    const member = await f.user();
    const first = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
    const second = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
    await f.forfeit(first, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
    await f.forfeit(second, { userId: member, role: 'direct' }, 'banned', IN_BAN_2);
    const appeal = await f.appeal(input(member));
    const before = await f.untouched();

    await f.deliver(f.event(appeal));

    expect(await f.diffs()).toEqual([]);
    expect(await f.untouched()).toEqual(before);
  },
);
