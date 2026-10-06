import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accepted,
  acquireRedis,
  guest,
  limits,
  member,
  opaque,
  req,
  ticketOf,
  withGate,
  type TestRedis,
} from './kit.ts';

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

const STOP = { ending: 'stop', cardsDelivered: 1 } as const;

it('[BR-AI-23] 同时不满足多条时返回顺序在前的码（⑦>⑧>⑨>⑩），被拒请求不改动任何存储值', async () => {
  await withGate(server, async ({ a, values }) => {
    const user = member();
    const s1 = opaque('s');
    const tight = limits({ perMinute: 2, maxRounds: 1, memberDaily: 3 });
    const first = accepted(await a.admit(req(user, s1), tight));
    accepted(await a.admit(req(user), tight));
    // s1: lock held, minute 2/2, rounds 1/1; day 2/3.
    let before = await values();
    expect(await a.admit(req(user, s1), tight)).toEqual({ kind: 'rejected', code: 30506 });
    expect(await values()).toEqual(before);
    await a.settle(first.ticket, STOP, tight);
    before = await values();
    expect(await a.admit(req(user, s1), tight)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 60,
    });
    expect(await values()).toEqual(before);
    const dayFull = limits({ perMinute: 100, maxRounds: 1, memberDaily: 2 });
    expect(await a.admit(req(user, s1), dayFull)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    expect(await a.admit(req(user), dayFull)).toMatchObject({ kind: 'rejected', code: 30502 });
    expect(await values()).toEqual(before);
  });
});

it('[BR-AI-23] ⑥ 已受理的 (会话, client_msg_id) 再来返回原受理票据：原 run 进行中为 running（锁占着、日额度用完也一样），结算后为 settled；不计数；被拒的 client_msg_id 不登记', async () => {
  await withGate(server, async ({ a, b, clock, values }) => {
    const user = member();
    const [s1, s2] = [opaque('s'), opaque('s')];
    const quota = limits({ memberDaily: 1 });
    const original = req(user, s1, 'm-1');
    const first = accepted(await a.admit(original, quota));
    const expected = ticketOf(original, '2026-10-06', 1791252000000, 1791252050000);
    expect(first.ticket).toEqual(expected);
    expect(first.ticket.messageId).toBe(original.messageId);
    const before = await values();
    const retry = req(user, s1, 'm-1');
    const again = await b.admit(retry, quota);
    expect(again).toEqual({ kind: 'duplicate', ticket: expected, state: 'running' });
    expect(again.kind === 'duplicate' ? again.ticket.messageId : '').toBe(original.messageId);
    expect(again.kind === 'duplicate' ? again.ticket.messageId : '').not.toBe(retry.messageId);
    expect(await values()).toEqual(before);
    await a.settle(first.ticket, STOP, quota);
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      ticket: expected,
      state: 'settled',
    });
    expect(await a.admit(req(user, s2, 'm-1'), quota)).toMatchObject({ code: 30502 });
    expect(await a.admit(req(user, s1, 'm-2'), quota)).toMatchObject({ code: 30502 });
    clock.set('2026-10-07T10:00:00+08:00');
    expect(accepted(await a.admit(req(user, s1, 'm-2'), quota)).quotaLeft).toBe(0);
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      ticket: expected,
      state: 'settled',
    });
    clock.set('2026-10-08T09:00:00+08:00');
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toMatchObject({ kind: 'duplicate' });
  });
});

it('[BR-AI-23] 崩溃收尾：锁过期而未结算 → 同键为 unsettled、同会话新消息先得 unsettled{遗留票据}（不写任何值）；补结算后才受理，迟到的原结算不改结论、不删新锁', async () => {
  await withGate(server, async ({ a, b, clock, values }) => {
    const user = member();
    const s1 = opaque('s');
    const quota = limits({ memberDaily: 5 });
    const original = req(user, s1, 'm-1');
    const first = accepted(await a.admit(original, quota));
    const expected = ticketOf(original, '2026-10-06', 1791252000000, 1791252050000);
    clock.set('2026-10-06T10:00:49.999+08:00');
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toMatchObject({ state: 'running' });
    expect(await a.admit(req(user, s1, 'm-2'), quota)).toEqual({ kind: 'rejected', code: 30506 });
    clock.set('2026-10-06T10:00:50.000+08:00');
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      ticket: expected,
      state: 'unsettled',
    });
    const before = await values();
    expect(await b.admit(req(user, s1, 'm-2'), quota)).toEqual({
      kind: 'unsettled',
      ticket: expected,
    });
    expect(await values()).toEqual(before);
    const crashed = { ending: 'server_error', cardsDelivered: 0 } as const;
    expect(await b.settle(expected, crashed, quota)).toEqual({ refunded: true, quotaLeft: 5 });
    expect(await a.admit(req(user, s1, 'm-1'), quota)).toMatchObject({ state: 'settled' });
    expect(accepted(await b.admit(req(user, s1, 'm-2'), quota)).quotaLeft).toBe(4);
    expect(await a.settle(first.ticket, STOP, quota)).toEqual({ refunded: true, quotaLeft: 4 });
    expect(await a.admit(req(user, s1, 'm-3'), quota)).toEqual({ kind: 'rejected', code: 30506 });
  });
});

it('[BR-AI-15] 游客分钟窗口只按 device_hash：同一分钟换 ipKey、换 loggedIn 仍 42901，且 42901 不耗日额度', async () => {
  await withGate(server, async ({ a, clock }) => {
    const hash = opaque('dh');
    const quota = limits({ perMinute: 1, guestDaily: 2 });
    expect(accepted(await a.admit(req(guest(hash, opaque('ik'))), quota)).quotaLeft).toBe(1);
    expect(await a.admit(req(guest(hash, opaque('ik'))), quota)).toMatchObject({ code: 42901 });
    expect(await a.admit(req(guest(hash, opaque('ik'), true)), quota)).toMatchObject({
      code: 42901,
    });
    clock.advanceMs(60_000);
    expect(accepted(await a.admit(req(guest(hash, opaque('ik'), true)), quota)).quotaLeft).toBe(0);
  });
});

it('[BR-AI-15][BR-AI-23] ⑨ 轮数按会话累计、不随自然日清零：满轮后跨午夜同会话仍 30504，新会话可受理', async () => {
  await withGate(server, async ({ a, clock }) => {
    const user = member();
    const session = opaque('s');
    const quota = limits({ maxRounds: 2 });
    clock.set('2026-10-06T23:58:00+08:00');
    await a.settle(accepted(await a.admit(req(user, session), quota)).ticket, STOP, quota);
    await a.settle(accepted(await a.admit(req(user, session), quota)).ticket, STOP, quota);
    clock.set('2026-10-07T00:00:01+08:00');
    expect(await a.admit(req(user, session), quota)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    expect(accepted(await a.admit(req(user), quota)).quotaLeft).toBe(99);
  });
});

it('[BR-AI-15][BR-AI-23] ⑧ 60 秒滑动窗口：超限 42901 且 Retry-After=ceil(剩余秒)≥1，窗口滑过后恢复，42901 不占日额度', async () => {
  await withGate(server, async ({ a, clock }) => {
    const user = member();
    const quota = limits({ perMinute: 2, memberDaily: 4 });
    accepted(await a.admit(req(user), quota));
    clock.advanceMs(1_000);
    accepted(await a.admit(req(user), quota));
    clock.advanceMs(500);
    expect(await a.admit(req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 59,
    });
    clock.set('2026-10-06T10:00:59.999+08:00');
    expect(await a.admit(req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 1,
    });
    clock.set('2026-10-06T10:01:00.000+08:00');
    expect(accepted(await a.admit(req(user), quota)).quotaLeft).toBe(1);
    expect(await a.admit(req(user), quota)).toMatchObject({ code: 42901 });
    clock.advanceMs(60_000);
    expect(accepted(await a.admit(req(user), quota)).quotaLeft).toBe(0);
  });
});

it('[BR-AI-15] 分钟限流游客按 device_hash 计（同 IP 不同设备互不影响）', async () => {
  await withGate(server, async ({ a }) => {
    const ip = opaque('ik');
    const quota = limits({ perMinute: 1 });
    const one = { tier: 'guest', loggedIn: false, deviceHash: opaque('dh'), ipKey: ip } as const;
    const two = { tier: 'guest', loggedIn: false, deviceHash: opaque('dh'), ipKey: ip } as const;
    accepted(await a.admit(req(one), quota));
    accepted(await a.admit(req(two), quota));
    expect(await a.admit(req(one), quota)).toMatchObject({ code: 42901 });
  });
});

it('[BR-AI-15][BR-AI-23] ⑨ 会话满轮数后 30504{round_limit} 且不计配额；退还只退日配额，不减轮数与分钟窗口', async () => {
  await withGate(server, async ({ a }) => {
    const user = member();
    const session = opaque('s');
    const quota = limits({ maxRounds: 2, perMinute: 3, memberDaily: 10 });
    const refund = { ending: 'input_review_timeout', cardsDelivered: 0 } as const;
    const one = accepted(await a.admit(req(user, session), quota));
    expect(await a.settle(one.ticket, refund, quota)).toEqual({ refunded: true, quotaLeft: 10 });
    const two = accepted(await a.admit(req(user, session), quota));
    expect(two.quotaLeft).toBe(9);
    expect(await a.settle(two.ticket, refund, quota)).toEqual({ refunded: true, quotaLeft: 10 });
    expect(await a.admit(req(user, session), quota)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    expect(accepted(await a.admit(req(user), quota)).quotaLeft).toBe(9);
    expect(await a.admit(req(user), quota)).toMatchObject({ code: 42901 });
  });
});

it('[BR-AI-15] 会员分钟窗口按 user_id 隔离：A 满上限后换会话、换实例仍 42901，同一时刻 B 可受理', async () => {
  await withGate(server, async ({ a, b }) => {
    const [userA, userB] = [member(), member()];
    const quota = limits({ perMinute: 2 });
    accepted(await a.admit(req(userA), quota));
    accepted(await b.admit(req(userA), quota));
    expect(await a.admit(req(userA), quota)).toMatchObject({ code: 42901 });
    expect(await b.admit(req(userA), quota)).toMatchObject({ code: 42901 });
    expect(accepted(await a.admit(req(userB), quota)).quotaLeft).toBe(99);
    expect(accepted(await b.admit(req(userB), quota)).quotaLeft).toBe(98);
    expect(await a.admit(req(userB), quota)).toMatchObject({ code: 42901 });
  });
});

it('[BR-AI-15] 分钟窗口跨午夜保留：23:59:55 受理满 10 条，00:00:00 新会话仍 42901，满 60 秒才恢复（日额度已重置）', async () => {
  await withGate(server, async ({ a, clock }) => {
    const user = member();
    const quota = limits({ perMinute: 10, memberDaily: 10 });
    clock.set('2026-10-06T23:59:55+08:00');
    for (let i = 0; i < 10; i++) accepted(await a.admit(req(user), quota));
    clock.set('2026-10-07T00:00:00.000+08:00');
    expect(await a.admit(req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 55,
    });
    clock.set('2026-10-07T00:00:54.999+08:00');
    expect(await a.admit(req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 1,
    });
    clock.set('2026-10-07T00:00:55.000+08:00');
    expect(accepted(await a.admit(req(user), quota)).quotaLeft).toBe(9);
  });
});
