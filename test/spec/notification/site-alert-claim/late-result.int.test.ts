// 规则测试（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ②，SPEC_REF 37808a5）：站长告警短信的旧领取 A
// 挂起超过 10 分钟、被 B 恢复领取之后，A 迟到的发送结果（accepted / unknown / rejected / 抛错）只按 A 自己的
// 领取标识比对：命不中就什么都不改（不改成 success、不退回 queued、不覆盖 B 的结果），只记一条 warn，A 的
// 交付正常结束（没有退回任何行，不要求队列重试）。B 照常落定；之后再交付不再发送。
// 正常单次领取（不迟到）的路径由 B1-22b 已冻结的 test/spec/union/auth-probe/** 覆盖，这里不重复。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { harness, STEP_MS, supersede, until } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const query of [true, false]) {
  const mode = query ? '恢复先查询得 not_sent' : '发送器无 query、恢复即重发';
  it(`[AC-B1-22t#1] A 挂起超 10 分钟、B 恢复领取并在发送中（${mode}）：A 迟到 accepted 不把 B 的行改成 success，只记一条 warn；B 落定 success，之后不再发送`, async () => {
    const h = await harness(database(), { query });
    const { a, b, claimB } = await supersede(h);
    const snapshot = await h.claimed(claimB);

    h.clock.advanceMs(STEP_MS);
    const from = h.mark();
    h.sms.sends[0]!.resolve('accepted');
    await until(() => a.state !== 'pending', 'A ends');
    expect(await h.row(), "A's late result leaves B's claim as it was").toEqual(snapshot);
    expect(a.state).toBe('resolved');
    h.expectOneWarn(from, 'A late accepted');

    h.clock.advanceMs(STEP_MS);
    h.sms.sends[1]!.resolve('accepted');
    await until(() => b.state !== 'pending', 'B ends');
    expect(b.state).toBe('resolved');
    await h.succeeded(h.clock.now());
    await h.expectQuiet('after B');
    expect(h.sms.sends).toHaveLength(2);
    h.expectNoPlainPhone();
  });
}

for (const query of [true, false]) {
  const mode = query ? '恢复先查询得 not_sent' : '发送器无 query、恢复即重发';
  it(`[AC-B1-22t#2] A 挂起超 10 分钟、B 恢复领取并在发送中（${mode}）：A 迟到抛错不把 B 退回 queued，只记一条 warn，A 的交付不要求重试；此时再交付不发送；B 落定后全程只有 B 一次发出`, async () => {
    const h = await harness(database(), { query });
    const { a, b, claimB } = await supersede(h);
    const snapshot = await h.claimed(claimB);

    h.clock.advanceMs(STEP_MS);
    const from = h.mark();
    h.sms.sends[0]!.reject(new Error('synthetic-transport-failure'));
    await until(() => a.state !== 'pending', 'A ends');
    expect(await h.row(), "A's late failure does not hand B's claim back").toEqual(snapshot);
    expect(a.state, 'nothing was handed back: no retry asked').toBe('resolved');
    h.expectOneWarn(from, 'A late throw');
    // B 的领取仍新鲜（1 分钟）：再交付既不领取也不发送。
    await h.expectQuiet('while B is sending');
    expect(await h.row()).toEqual(snapshot);

    h.clock.advanceMs(STEP_MS);
    h.sms.sends[1]!.resolve('accepted');
    await until(() => b.state !== 'pending', 'B ends');
    expect(b.state).toBe('resolved');
    await h.succeeded(h.clock.now());
    await h.expectQuiet('after B');
    // A 的发送抛错（未发出）：真实发出的只有 B 这一次。
    expect(h.sms.sends).toHaveLength(2);
    h.expectNoPlainPhone();
  });
}

for (const late of ['accepted', 'unknown', 'rejected', 'throws'] as const) {
  it(`[AC-B1-22t#3] B 恢复领取并已落定 success 后 A 迟到 ${late}：不覆盖 B 的结果，只记一条 warn（不记 error），A 的交付正常结束，之后不再发送`, async () => {
    const h = await harness(database(), { query: true });
    const { a, b } = await supersede(h);

    h.clock.advanceMs(STEP_MS);
    h.sms.sends[1]!.resolve('accepted');
    await until(() => b.state !== 'pending', 'B ends');
    expect(b.state).toBe('resolved');
    const done = await h.succeeded(h.clock.now());

    h.clock.advanceMs(STEP_MS);
    const from = h.mark();
    if (late === 'throws') h.sms.sends[0]!.reject(new Error('synthetic-transport-failure'));
    else h.sms.sends[0]!.resolve(late);
    await until(() => a.state !== 'pending', 'A ends');
    expect(await h.row(), "A's late result leaves B's outcome as it was").toEqual(done);
    expect(a.state, 'nothing was handed back: no retry asked').toBe('resolved');
    h.expectOneWarn(from, `A late ${late}`);
    await h.expectQuiet('after A');
    expect(h.sms.sends).toHaveLength(2);
    h.expectNoPlainPhone();
  });
}
