// B3-03g replacement of the B3-03c lock rules on PostgreSQL (design §7.3 rows lock:26 … :171;
// lock:196 / :212 were Redis TTL rules and are dropped; rules:115 becomes the PG-unavailable case).
import { createTestDatabase } from '@couli/db/testing';
import { createDb, destroyDb } from '@couli/db';
import { expect, it } from 'vitest';
import {
  AdmissionUnavailableError,
  type AdmissionRequest,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import { createPgRunPorts } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { MutableLimits, TIMINGS, texts, terminate, snapshot } from '../stream-finalize/kit.ts';
import {
  START,
  accepted,
  guest,
  limits,
  member,
  opaque,
  ticketOf,
  usePg,
  withGate,
} from './kit.ts';

const pg = usePg(createTestDatabase);
const K = 8;
const STOP = { ending: 'stop', cardsDelivered: 0 } as const;

it('[AC-B3-03g#61][BR-AI-23] 并发：会员只剩 1 条时在不同会话并发 8 条（8 个连接），恰好 1 条受理（quota_left=0），其余 30502', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 3 });
    accepted(await a.admit(await req(user), quota));
    accepted(await a.admit(await req(user), quota));
    const requests: AdmissionRequest[] = [];
    for (let i = 0; i < K; i++) requests.push(await req(user));
    const results = await Promise.all(
      requests.map((r, i) => (i % 2 === 0 ? a : b).admit(r, quota)),
    );
    const winners = results.filter((r) => r.kind === 'accepted');
    expect(winners.length).toBe(1);
    expect(winners[0]).toMatchObject({ quotaLeft: 0 });
    expect(results.filter((r) => r.kind === 'rejected' && r.code === 30502).length).toBe(K - 1);
  });
});

it('[AC-B3-03g#62][BR-AI-23] 并发：同一会话并发 8 条不同 client_msg_id，恰好 1 条受理，其余 30506', async () => {
  await withGate(pg, async ({ a, b, req, session }) => {
    const user = member();
    const s = await session();
    const requests: AdmissionRequest[] = [];
    for (let i = 0; i < K; i++) requests.push(await req(user, s));
    const results = await Promise.all(
      requests.map((r, i) => (i % 2 === 0 ? a : b).admit(r, limits())),
    );
    expect(results.filter((r) => r.kind === 'accepted').length).toBe(1);
    expect(results.filter((r) => r.kind === 'rejected' && r.code === 30506).length).toBe(K - 1);
  });
});

it('[AC-B3-03g#63][BR-AI-23] 并发：同一 client_msg_id 并发 8 次，恰好 1 条受理，其余 duplicate 指向它（原用户消息 id），只计 1 条', async () => {
  await withGate(pg, async ({ a, b, req, session }) => {
    const user = member();
    const s = await session();
    const requests: AdmissionRequest[] = [];
    for (let i = 0; i < K; i++) requests.push(await req(user, s, 'm-same'));
    const results = await Promise.all(
      requests.map((r, i) => (i % 2 === 0 ? a : b).admit(r, limits({ memberDaily: 5 }))),
    );
    const winner = results.findIndex((r) => r.kind === 'accepted');
    expect(results.filter((r) => r.kind === 'accepted').length).toBe(1);
    const won = requests[winner]!;
    const duplicates = results.filter(
      (r, i) =>
        r.kind === 'duplicate' &&
        r.reply.kind === 'running' &&
        r.original.runId === won.runId &&
        r.original.userMessageId === won.messageId &&
        r.original.userMessageId !== requests[i]!.messageId,
    );
    expect(duplicates.length).toBe(K - 1);
    expect(accepted(await a.admit(await req(user), limits({ memberDaily: 5 }))).quotaLeft).toBe(3);
  });
});

it('[AC-B3-03g#64][BR-AI-23] 会话锁到期 = 受理 + run 最长时长 + 30 秒（按注入时钟毫秒），值为 run_id：到期前 30506，到期起由本事务收尾遗留 run 并受理', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const original = await req(user);
    const old = accepted(await a.admit(original, limits()));
    expect(old.ticket).toEqual(ticketOf(original, '2026-10-06', 1791252000000, 1791252050000));
    clock.set('2026-10-06T10:00:49.999+08:00');
    expect(await a.admit(await req(user, original.sessionId), limits())).toEqual({
      kind: 'rejected',
      code: 30506,
    });
    clock.set('2026-10-06T10:00:50.000+08:00');
    const next = await req(user, original.sessionId);
    const now = accepted(await a.admit(next, limits()));
    expect(now.ticket.runId).toBe(next.runId);
    const finalized = await a.inst.ports.finalizer.finalize(original.runId);
    expect(finalized).toMatchObject({ kind: 'final', wrote: false, refunded: true });
  });
});

it('[AC-B3-03g#65][BR-AI-23] 不同时长配置：锁到期随 runMaxMs 与宽限变化', async () => {
  await withGate(
    pg,
    async ({ a, clock, req }) => {
      const user = member();
      const first = await req(user);
      const held = accepted(await a.admit(first, limits()));
      expect(held.ticket.lockExpiresAtMs).toBe(1791252031001);
      clock.advanceMs(31_000);
      expect(await a.admit(await req(user, first.sessionId), limits())).toMatchObject({
        code: 30506,
      });
      clock.advanceMs(1);
      accepted(await a.admit(await req(user, first.sessionId), limits()));
    },
    { runMaxMs: 1_000, lockGraceMs: 30_001, cancelPgPollMs: 2_000 },
  );
});

it('[AC-B3-03g#66][BR-AI-23] done / error / 取消结算后锁即释放：时钟不动，同会话下一条立即受理；旧票据再结算不删新 run 的锁', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const endings = [
      { ending: 'stop', cardsDelivered: 1 },
      { ending: 'server_error', cardsDelivered: 0 },
      { ending: 'cancelled', cardsDelivered: 0 },
      { ending: 'timeout', cardsDelivered: 1 },
      { ending: 'consent_withdrawn', cardsDelivered: 0 },
    ] as const;
    for (const outcome of endings) {
      const r = await req(user);
      const first = accepted(await a.admit(r, limits()));
      await a.settle(first.ticket, outcome, limits());
      const next = accepted(await b.admit(await req(user, r.sessionId), limits()));
      await a.settle(first.ticket, outcome, limits());
      expect(await a.admit(await req(user, r.sessionId), limits()), outcome.ending).toEqual({
        kind: 'rejected',
        code: 30506,
      });
      await b.settle(next.ticket, STOP, limits());
    }
  });
});

it('[AC-B3-03g#67][BR-AI-23] 一次 admit 只开一个受理事务（判断与写入同一事务，提交一次），同键、新键、换会话都一样', async () => {
  await withGate(pg, async ({ a, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 1 });
    const first = await req(user, undefined, 'm-1');
    const other = await req(user);
    const commits = () => a.inst.hooks.steps.filter((s) => s === 'commit:admit').length;
    const seen: number[] = [];
    let last = commits();
    const once = () => {
      seen.push(commits() - last);
      last = commits();
    };
    accepted(await a.admit(first, quota));
    once();
    await a.admit(await req(user, first.sessionId, 'm-1'), quota);
    once();
    await a.admit(await req(user, first.sessionId, 'm-2'), quota);
    once();
    await a.admit(other, quota);
    once();
    expect(seen).toEqual([1, 1, 1, 1]);
    expect(
      a.inst.hooks.steps.filter((s) => s.startsWith('commit:') && s !== 'commit:admit'),
    ).toEqual([]);
  });
});

it('[AC-B3-03g#68][BR-AI-23] 并发临界：分钟窗口剩 1 条、游客设备剩 1 条、IP 剩 1 条时两实例并发 8 条，各恰好 1 条受理', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const minute = limits({ perMinute: 10 });
    for (let i = 0; i < 9; i++) accepted(await a.admit(await req(user), minute));
    const race = async (subject: () => ReturnType<typeof member>, quota: typeof minute) => {
      const requests: AdmissionRequest[] = [];
      for (let i = 0; i < K; i++) requests.push(await req(subject()));
      return Promise.all(requests.map((r, i) => (i % 2 === 0 ? a : b).admit(r, quota)));
    };
    const tally = (results: Awaited<ReturnType<typeof race>>, code: number) => [
      results.filter((r) => r.kind === 'accepted').length,
      results.filter((r) => r.kind === 'rejected' && r.code === code).length,
    ];
    expect(tally(await race(() => user, minute), 42901)).toEqual([1, 7]);

    const hash = opaque('dh');
    const device = limits({ guestDaily: 2 });
    accepted(await a.admit(await req(guest(hash, opaque('ik'))), device));
    expect(tally(await race(() => guest(hash, opaque('ik')), device), 30502)).toEqual([1, 7]);

    const ip = opaque('ik');
    const shared = limits({ guestIpDaily: 2 });
    accepted(await a.admit(await req(guest(opaque('dh'), ip)), shared));
    expect(tally(await race(() => guest(opaque('dh'), ip), shared), 30502)).toEqual([1, 7]);
  });
});

it('[AC-B3-03g#69][BR-AI-23] PG 不可用：连不上库或受理事务中途断开 → AdmissionUnavailableError(rolled_back)，三张表逐行不变（调用方回 50401）', async () => {
  await withGate(pg, async ({ a, req }) => {
    const request = await req(member());
    const before = await snapshot(pg.db);
    const dead = createDb({ connectionString: 'postgres://couli_app@127.0.0.1:1/rules', max: 1 });
    try {
      const ports = createPgRunPorts({
        db: dead,
        clock: new FixedClock(START),
        timings: TIMINGS,
        limits: new MutableLimits(),
        texts,
      });
      const error = await ports.admission.admit(request, limits()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdmissionUnavailableError);
      expect((error as AdmissionUnavailableError).outcome).toBe('rolled_back');
    } finally {
      await destroyDb(dead);
    }
    a.inst.hooks.onSql('admit', (pid) => terminate(pg.db, pid));
    const cut = await a.admit(request, limits()).catch((e: unknown) => e);
    expect(cut).toBeInstanceOf(AdmissionUnavailableError);
    expect((cut as AdmissionUnavailableError).outcome).toBe('rolled_back');
    expect(await snapshot(pg.db)).toBe(before);
  });
});
