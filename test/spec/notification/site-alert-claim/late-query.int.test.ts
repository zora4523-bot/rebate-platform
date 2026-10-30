// 规则测试（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ②，SPEC_REF 37808a5）：未决恢复的查询结果同样只按
// 本次领取标识比对。A 领取后发送挂起；超 10 分钟 B 恢复领取、查询挂起；再超 10 分钟 C 恢复领取、查得
// not_sent 并在发送中。B 迟到的查询结果（sent / not_sent）不改 C 的领取，也不据此发送，只记一条 warn；C 照常
// 落定；A 再迟到抛错也不改 C 的结果。全程同一号码同一阶段只有 C 一次发出（A 的发送抛错、未发出）。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { expectSendsOfTheRow, harness, RECOVER_MS, STEP_MS, until } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const late of ['sent', 'not_sent'] as const) {
  it(`[AC-B1-22t#4] B 的恢复查询挂起超 10 分钟、C 再恢复并在发送中：B 迟到 ${late} 不改 C 的领取、不据此发送，只记一条 warn；C 落定 success，A 迟到抛错也不改；全程只有 C 一次发出`, async () => {
    const h = await harness(database(), { query: true });
    const a = h.deliver();
    await until(() => h.sms.sends.length === 1, 'A sends');

    h.clock.advanceMs(RECOVER_MS);
    const claimB = h.clock.now();
    const b = h.deliver();
    await until(() => h.sms.queries.length === 1, 'B queries the unconfirmed claim');
    await h.claimed(claimB);

    h.clock.advanceMs(RECOVER_MS);
    const claimC = h.clock.now();
    const c = h.deliver();
    await until(() => h.sms.queries.length === 2, 'C queries the unconfirmed claim');
    h.sms.queries[1]!.resolve('not_sent');
    await until(() => h.sms.sends.length === 2, 'C sends');
    expectSendsOfTheRow(h);
    const snapshot = await h.claimed(claimC);

    h.clock.advanceMs(STEP_MS);
    let from = h.mark();
    h.sms.queries[0]!.resolve(late);
    await until(() => b.state !== 'pending' || h.sms.sends.length > 2, 'B ends');
    expect(h.sms.sends, 'B sends nothing for a claim no longer its own').toHaveLength(2);
    expect(b.state).toBe('resolved');
    expect(await h.row(), "B's late query result leaves C's claim as it was").toEqual(snapshot);
    h.expectOneWarn(from, `B late ${late}`);

    h.clock.advanceMs(STEP_MS);
    h.sms.sends[1]!.resolve('accepted');
    await until(() => c.state !== 'pending', 'C ends');
    expect(c.state).toBe('resolved');
    const done = await h.succeeded(h.clock.now());

    h.clock.advanceMs(STEP_MS);
    from = h.mark();
    h.sms.sends[0]!.reject(new Error('synthetic-transport-failure'));
    await until(() => a.state !== 'pending', 'A ends');
    expect(await h.row(), "A's late failure leaves C's outcome as it was").toEqual(done);
    expect(a.state, 'nothing was handed back: no retry asked').toBe('resolved');
    h.expectOneWarn(from, 'A late throw');

    await h.expectQuiet('after all');
    expect(h.sms.sends).toHaveLength(2);
    expect(h.sms.queries).toHaveLength(2);
    h.expectNoPlainPhone();
  });
}
