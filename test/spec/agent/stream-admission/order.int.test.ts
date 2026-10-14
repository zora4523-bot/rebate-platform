// B3-03g replacement of the B3-03c order rules on PostgreSQL (design §7.3 rows order:25 … :230).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  accepted,
  guest,
  limits,
  member,
  opaque,
  originalOf,
  ticketOf,
  usePg,
  withGate,
} from './kit.ts';

const pg = usePg(createTestDatabase);
const STOP = { ending: 'stop', cardsDelivered: 1 } as const;

it('[AC-B3-03g#50][BR-AI-23] 同时不满足多条时返回顺序在前的码（⑦>⑧>⑨>⑩），被拒请求三张表逐行不变', async () => {
  await withGate(pg, async ({ a, req, values }) => {
    const user = member();
    const r1 = await req(user);
    const s1 = r1.sessionId;
    const tight = limits({ perMinute: 2, maxRounds: 1, memberDaily: 3 });
    const first = accepted(await a.admit(r1, tight));
    accepted(await a.admit(await req(user), tight));
    let before = await values();
    expect(await a.admit(await req(user, s1), tight)).toEqual({ kind: 'rejected', code: 30506 });
    expect(await values()).toEqual(before);
    await a.settle(first.ticket, STOP, tight);
    before = await values();
    expect(await a.admit(await req(user, s1), tight)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 60,
    });
    expect(await values()).toEqual(before);
    const dayFull = limits({ perMinute: 100, maxRounds: 1, memberDaily: 2 });
    expect(await a.admit(await req(user, s1), dayFull)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    const other = await req(user);
    before = await values();
    expect(await a.admit(other, dayFull)).toMatchObject({ kind: 'rejected', code: 30502 });
    expect(await values()).toEqual(before);
  });
});

it('[AC-B3-03g#51][BR-AI-23] ⑥ 已受理的 (会话, client_msg_id) 再来返回原 run（字段取自 PG）：进行中为 running（锁占着、日额度用完也一样），结束后为 final 原终态帧；不计数；被拒的 client_msg_id 不登记；会话过期后先按 ④ 30504', async () => {
  await withGate(pg, async ({ a, b, clock, req, values }) => {
    const user = member();
    const quota = limits({ memberDaily: 1 });
    const original = await req(user, undefined, 'm-1');
    const s1 = original.sessionId;
    const s2 = (await req(user)).sessionId;
    const first = accepted(await a.admit(original, quota));
    expect(first.ticket).toEqual(ticketOf(original, '2026-10-06', 1791252000000, 1791252050000));
    const before = await values();
    const retry = await req(user, s1, 'm-1');
    expect(await b.admit(retry, quota)).toEqual({
      kind: 'duplicate',
      original: originalOf(original),
      reply: { kind: 'running' },
    });
    expect(await values()).toEqual(before);
    await a.settle(first.ticket, STOP, quota);
    const finalFrame = { event: 'done', data: { finish_reason: 'stop', quota_left: 0 } };
    expect(await a.admit(await req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      original: originalOf(original),
      reply: { kind: 'final', frame: finalFrame },
    });
    expect(await a.admit(await req(user, s2, 'm-1'), quota)).toMatchObject({ code: 30502 });
    expect(await a.admit(await req(user, s1, 'm-2'), quota)).toMatchObject({ code: 30502 });
    clock.set('2026-10-07T09:00:00+08:00');
    expect(accepted(await a.admit(await req(user, s1, 'm-2'), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      original: originalOf(original),
      reply: { kind: 'final', frame: finalFrame },
    });
    clock.set('2026-10-08T10:00:00+08:00');
    expect(await a.admit(await req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'expired',
    });
  });
});

it('[AC-B3-03g#52][BR-AI-23] 崩溃收尾：锁过期而无终态 → 同键由本事务收尾后返回 final(50001)，同会话新消息先收尾再受理（退还当场可用）；迟到的原 settle 读回已有终态（5 → 4）、不删新锁', async () => {
  await withGate(pg, async ({ a, b, clock, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 5 });
    const original = await req(user, undefined, 'm-1');
    const s1 = original.sessionId;
    const first = accepted(await a.admit(original, quota));
    clock.set('2026-10-06T10:00:49.999+08:00');
    expect(await a.admit(await req(user, s1, 'm-1'), quota)).toMatchObject({
      reply: { kind: 'running' },
    });
    expect(await a.admit(await req(user, s1, 'm-2'), quota)).toEqual({
      kind: 'rejected',
      code: 30506,
    });
    clock.set('2026-10-06T10:00:50.000+08:00');
    const recovered = {
      event: 'error',
      data: { code: 50001, msg: '错误提示-50001', retryable: true, fallback: null },
    };
    expect(await a.admit(await req(user, s1, 'm-1'), quota)).toEqual({
      kind: 'duplicate',
      original: originalOf(original),
      reply: { kind: 'final', frame: recovered },
    });
    expect(accepted(await b.admit(await req(user, s1, 'm-2'), quota)).quotaLeft).toBe(4);
    expect(await a.settle(first.ticket, STOP, quota)).toEqual({ refunded: true, quotaLeft: 4 });
    expect(await a.admit(await req(user, s1, 'm-3'), quota)).toEqual({
      kind: 'rejected',
      code: 30506,
    });
  });
});

it('[AC-B3-03g#53][BR-AI-23] 崩溃收尾（新消息先到）：锁过期后同会话新消息在同一事务里先把遗留 run 以 50001 无卡退还收尾再受理；首次结算 5、再受理一条后旧票据再 settle 得 refunded=true、quotaLeft=4，原终态不变', async () => {
  await withGate(pg, async ({ a, b, clock, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 5 });
    const original = await req(user, undefined, 'm-1');
    const first = accepted(await a.admit(original, quota));
    clock.set('2026-10-06T10:00:50.000+08:00');
    const finalized = await b.inst.ports.finalizer.finalize(first.ticket.runId);
    expect(finalized).toMatchObject({ kind: 'final', refunded: true, quotaLeft: 5 });
    expect(
      accepted(await b.admit(await req(user, original.sessionId, 'm-2'), quota)).quotaLeft,
    ).toBe(4);
    expect(
      await a.settle(first.ticket, { ending: 'server_error', cardsDelivered: 0 }, quota),
    ).toEqual({
      refunded: true,
      quotaLeft: 4,
    });
  });
});

it('[AC-B3-03g#54][BR-AI-15] 游客分钟窗口只按 device_hash：同一分钟换 ipKey、换 loggedIn 仍 42901，且 42901 不耗日额度', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const hash = opaque('dh');
    const quota = limits({ perMinute: 1, guestDaily: 2 });
    expect(accepted(await a.admit(await req(guest(hash, opaque('ik'))), quota)).quotaLeft).toBe(1);
    expect(await a.admit(await req(guest(hash, opaque('ik'))), quota)).toMatchObject({
      code: 42901,
    });
    expect(await a.admit(await req(guest(hash, opaque('ik'), true)), quota)).toMatchObject({
      code: 42901,
    });
    clock.advanceMs(60_000);
    expect(
      accepted(await a.admit(await req(guest(hash, opaque('ik'), true)), quota)).quotaLeft,
    ).toBe(0);
  });
});

it('[AC-B3-03g#55][BR-AI-15][BR-AI-23] ⑨ 轮数按会话累计、不随自然日清零：满轮后跨午夜同会话仍 30504，新会话可受理', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ maxRounds: 2 });
    clock.set('2026-10-06T23:58:00+08:00');
    const r1 = await req(user);
    const session = r1.sessionId;
    await a.settle(accepted(await a.admit(r1, quota)).ticket, STOP, quota);
    await a.settle(accepted(await a.admit(await req(user, session), quota)).ticket, STOP, quota);
    clock.set('2026-10-07T00:00:01+08:00');
    expect(await a.admit(await req(user, session), quota)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(99);
  });
});

it('[AC-B3-03g#56][BR-AI-15][BR-AI-23] ⑧ 60 秒滑动窗口：超限 42901 且 Retry-After=ceil(剩余秒)≥1，窗口滑过后恢复，42901 不占日额度', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ perMinute: 2, memberDaily: 4 });
    accepted(await a.admit(await req(user), quota));
    clock.advanceMs(1_000);
    accepted(await a.admit(await req(user), quota));
    clock.advanceMs(500);
    expect(await a.admit(await req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 59,
    });
    clock.set('2026-10-06T10:00:59.999+08:00');
    expect(await a.admit(await req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 1,
    });
    clock.set('2026-10-06T10:01:00.000+08:00');
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(1);
    expect(await a.admit(await req(user), quota)).toMatchObject({ code: 42901 });
    clock.advanceMs(60_000);
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(0);
  });
});

it('[AC-B3-03g#57][BR-AI-15] 分钟限流游客按 device_hash 计（同 IP 不同设备互不影响）', async () => {
  await withGate(pg, async ({ a, req }) => {
    const ip = opaque('ik');
    const quota = limits({ perMinute: 1 });
    const one = guest(opaque('dh'), ip);
    const two = guest(opaque('dh'), ip);
    accepted(await a.admit(await req(one), quota));
    accepted(await a.admit(await req(two), quota));
    expect(await a.admit(await req(one), quota)).toMatchObject({ code: 42901 });
  });
});

it('[AC-B3-03g#58][BR-AI-15][BR-AI-23] ⑨ 会话满轮数后 30504{round_limit} 且不计配额；退还只退日配额，不减轮数与分钟窗口', async () => {
  await withGate(pg, async ({ a, req }) => {
    const user = member();
    const quota = limits({ maxRounds: 2, perMinute: 3, memberDaily: 10 });
    const refund = { ending: 'input_review_timeout', cardsDelivered: 0 } as const;
    const r1 = await req(user);
    const session = r1.sessionId;
    const one = accepted(await a.admit(r1, quota));
    expect(await a.settle(one.ticket, refund, quota)).toEqual({ refunded: true, quotaLeft: 10 });
    const two = accepted(await a.admit(await req(user, session), quota));
    expect(two.quotaLeft).toBe(9);
    expect(await a.settle(two.ticket, refund, quota)).toEqual({ refunded: true, quotaLeft: 10 });
    expect(await a.admit(await req(user, session), quota)).toEqual({
      kind: 'rejected',
      code: 30504,
      reason: 'round_limit',
    });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(9);
    expect(await a.admit(await req(user), quota)).toMatchObject({ code: 42901 });
  });
});

it('[AC-B3-03g#59][BR-AI-15] 会员分钟窗口按 user_id 隔离：A 满上限后换会话、换实例仍 42901，同一时刻 B 可受理', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const [userA, userB] = [member(), member()];
    const quota = limits({ perMinute: 2 });
    accepted(await a.admit(await req(userA), quota));
    accepted(await b.admit(await req(userA), quota));
    expect(await a.admit(await req(userA), quota)).toMatchObject({ code: 42901 });
    expect(await b.admit(await req(userA), quota)).toMatchObject({ code: 42901 });
    expect(accepted(await a.admit(await req(userB), quota)).quotaLeft).toBe(99);
    expect(accepted(await b.admit(await req(userB), quota)).quotaLeft).toBe(98);
    expect(await a.admit(await req(userB), quota)).toMatchObject({ code: 42901 });
  });
});

it('[AC-B3-03g#60][BR-AI-15] 分钟窗口跨午夜保留：23:59:55 受理满 10 条，00:00:00 新会话仍 42901，满 60 秒才恢复（日额度已重置）', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ perMinute: 10, memberDaily: 10 });
    clock.set('2026-10-06T23:59:55+08:00');
    for (let i = 0; i < 10; i++) accepted(await a.admit(await req(user), quota));
    clock.set('2026-10-07T00:00:00.000+08:00');
    expect(await a.admit(await req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 55,
    });
    clock.set('2026-10-07T00:00:54.999+08:00');
    expect(await a.admit(await req(user), quota)).toEqual({
      kind: 'rejected',
      code: 42901,
      retryAfterSeconds: 1,
    });
    clock.set('2026-10-07T00:00:55.000+08:00');
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(9);
  });
});
