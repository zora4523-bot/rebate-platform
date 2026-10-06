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

const K = 8;
const STOP = { ending: 'stop', cardsDelivered: 0 } as const;

it('[BR-AI-23] 并发：会员只剩 1 条时在不同会话并发 8 条，恰好 1 条受理（quota_left=0），其余 30502', async () => {
  await withGate(server, async ({ a, b }) => {
    const user = member();
    const quota = limits({ memberDaily: 3 });
    accepted(await a.admit(req(user), quota));
    accepted(await a.admit(req(user), quota));
    const results = await Promise.all(
      Array.from({ length: K }, (_, i) => (i % 2 === 0 ? a : b).admit(req(user), quota)),
    );
    const winners = results.filter((r) => r.kind === 'accepted');
    expect(winners.length).toBe(1);
    expect(winners[0]).toMatchObject({ quotaLeft: 0 });
    expect(results.filter((r) => r.kind === 'rejected' && r.code === 30502).length).toBe(K - 1);
  });
});

it('[BR-AI-23] 并发：同一会话并发 8 条不同 client_msg_id，恰好 1 条受理，其余 30506', async () => {
  await withGate(server, async ({ a, b }) => {
    const user = member();
    const session = opaque('s');
    const results = await Promise.all(
      Array.from({ length: K }, (_, i) =>
        (i % 2 === 0 ? a : b).admit(req(user, session), limits()),
      ),
    );
    expect(results.filter((r) => r.kind === 'accepted').length).toBe(1);
    expect(results.filter((r) => r.kind === 'rejected' && r.code === 30506).length).toBe(K - 1);
  });
});

it('[BR-AI-23] 并发：同一 client_msg_id 并发 8 次，恰好 1 条受理，其余 duplicate 指向它，只计 1 条', async () => {
  await withGate(server, async ({ a, b }) => {
    const user = member();
    const session = opaque('s');
    const requests = Array.from({ length: K }, () => req(user, session, 'm-same'));
    const results = await Promise.all(
      requests.map((request, i) =>
        (i % 2 === 0 ? a : b).admit(request, limits({ memberDaily: 5 })),
      ),
    );
    const winner = results.findIndex((r) => r.kind === 'accepted');
    expect(results.filter((r) => r.kind === 'accepted').length).toBe(1);
    const won = requests[winner]!;
    const winning = results[winner]!;
    expect(winning.kind === 'accepted' ? winning.ticket.messageId : '').toBe(won.messageId);
    const duplicates = results.filter(
      (r, i) =>
        r.kind === 'duplicate' &&
        r.state === 'running' &&
        r.ticket.runId === won.runId &&
        r.ticket.messageId === won.messageId &&
        r.ticket.messageId !== requests[i]!.messageId,
    );
    expect(duplicates.length).toBe(K - 1);
    expect(accepted(await a.admit(req(user), limits({ memberDaily: 5 }))).quotaLeft).toBe(3);
  });
});

it('[BR-AI-23] 会话锁到期 = 受理 + run 最长时长 + 30 秒（按注入时钟毫秒），值为 run_id：到期前 30506，到期后未结算则交出遗留票据', async () => {
  await withGate(server, async ({ a, clock }) => {
    const user = member();
    const session = opaque('s');
    const original = req(user, session);
    const old = accepted(await a.admit(original, limits()));
    const expected = ticketOf(original, '2026-10-06', 1791252000000, 1791252050000);
    expect(old.ticket).toEqual(expected);
    clock.set('2026-10-06T10:00:49.999+08:00');
    expect(await a.admit(req(user, session), limits())).toEqual({ kind: 'rejected', code: 30506 });
    clock.set('2026-10-06T10:00:50.000+08:00');
    expect(await a.admit(req(user, session), limits())).toEqual({
      kind: 'unsettled',
      ticket: expected,
    });
  });
});

it('[BR-AI-23] 不同时长配置：锁到期随 runMaxMs 与宽限变化', async () => {
  await withGate(
    server,
    async ({ a, clock }) => {
      const user = member();
      const session = opaque('s');
      const held = accepted(await a.admit(req(user, session), limits()));
      expect(held.ticket.lockExpiresAtMs).toBe(1791252002001);
      clock.advanceMs(2_000);
      expect(await a.admit(req(user, session), limits())).toMatchObject({ code: 30506 });
      clock.advanceMs(1);
      expect(await a.admit(req(user, session), limits())).toMatchObject({ kind: 'unsettled' });
      await a.settle(held.ticket, STOP, limits());
      accepted(await a.admit(req(user, session), limits()));
    },
    { runMaxMs: 1_000, lockGraceMs: 1_001 },
  );
});

it('[BR-AI-23] done / error / 取消结算后锁即释放：时钟不动，同会话下一条立即受理；旧票据再结算不删新 run 的锁', async () => {
  await withGate(server, async ({ a, b }) => {
    const user = member();
    const endings = [
      { ending: 'stop', cardsDelivered: 1 },
      { ending: 'server_error', cardsDelivered: 0 },
      { ending: 'cancelled', cardsDelivered: 0 },
      { ending: 'timeout', cardsDelivered: 1 },
      { ending: 'consent_withdrawn', cardsDelivered: 0 },
    ] as const;
    for (const outcome of endings) {
      const session = opaque('s');
      const first = accepted(await a.admit(req(user, session), limits()));
      await a.settle(first.ticket, outcome, limits());
      const next = accepted(await b.admit(req(user, session), limits()));
      await a.settle(first.ticket, outcome, limits());
      expect(await a.admit(req(user, session), limits()), outcome.ending).toEqual({
        kind: 'rejected',
        code: 30506,
      });
      await b.settle(next.ticket, STOP, limits());
    }
  });
});

it('[BR-AI-23] 一次 admit 的判断与写入在同一次 eval 内完成（不另行 get / set / eval）', async () => {
  await withGate(server, async ({ a, calls }) => {
    const user = member();
    const session = opaque('s');
    const quota = limits({ memberDaily: 1 });
    const seen: string[] = [];
    const once = () => {
      seen.push(`${String(calls.eval)}/${String(calls.get)}/${String(calls.set)}`);
      calls.eval = 0;
      calls.get = 0;
      calls.set = 0;
    };
    once();
    accepted(await a.admit(req(user, session, 'm-1'), quota));
    once();
    await a.admit(req(user, session, 'm-1'), quota);
    once();
    await a.admit(req(user, session, 'm-2'), quota);
    once();
    await a.admit(req(user), quota);
    once();
    expect(seen.slice(1)).toEqual(['1/0/0', '1/0/0', '1/0/0', '1/0/0']);
  });
});

it('[BR-AI-23] 并发临界：分钟窗口剩 1 条、游客设备剩 1 条、IP 剩 1 条时两连接并发 8 条，各恰好 1 条受理', async () => {
  await withGate(server, async ({ a, b }) => {
    const user = member();
    const minute = limits({ perMinute: 10 });
    for (let i = 0; i < 9; i++) accepted(await a.admit(req(user), minute));
    const race = (make: () => Parameters<typeof a.admit>[0], quota: typeof minute) =>
      Promise.all(Array.from({ length: K }, (_, i) => (i % 2 === 0 ? a : b).admit(make(), quota)));
    const tally = (results: Awaited<ReturnType<typeof race>>, code: number) => [
      results.filter((r) => r.kind === 'accepted').length,
      results.filter((r) => r.kind === 'rejected' && r.code === code).length,
    ];
    expect(tally(await race(() => req(user), minute), 42901)).toEqual([1, 7]);

    const hash = opaque('dh');
    const device = limits({ guestDaily: 2 });
    accepted(await a.admit(req(guest(hash, opaque('ik'))), device));
    expect(tally(await race(() => req(guest(hash, opaque('ik'))), device), 30502)).toEqual([1, 7]);

    const ip = opaque('ik');
    const shared = limits({ guestIpDaily: 2 });
    accepted(await a.admit(req(guest(opaque('dh'), ip)), shared));
    expect(tally(await race(() => req(guest(opaque('dh'), ip)), shared), 30502)).toEqual([1, 7]);
  });
});

it('[BR-AI-15][BR-AI-23] 受理、结算、去重写下的每个键都有正的 TTL', async () => {
  await withGate(server, async ({ a, dump }) => {
    const ticket = accepted(
      await a.admit(req(member(), opaque('s'), 'm-1'), limits({ memberDaily: 2 })),
    ).ticket;
    const visitor = req(guest(opaque('dh'), opaque('ik')), opaque('s'), 'm-2');
    const guestTicket = accepted(await a.admit(visitor, limits())).ticket;
    await a.admit(req(visitor.subject, visitor.sessionId, 'm-2'), limits());
    await a.settle(ticket, { ending: 'server_error', cardsDelivered: 0 }, limits());
    await a.settle(guestTicket, { ending: 'disabled', cardsDelivered: 0 }, limits());
    const rows = Object.entries(await dump());
    expect(rows.length).toBeGreaterThan(0);
    for (const [key, [pttl]] of rows) expect(pttl, key).toBeGreaterThan(0);
  });
});

it('[BR-AI-23] 未结算时锁与受理状态的 Redis 回收期不早于 runMaxMs + 宽限（容差 5 秒），逻辑边界仍按注入时钟', async () => {
  await withGate(server, async ({ a, dump }) => {
    const user = member();
    const session = opaque('s');
    const { ticket } = accepted(await a.admit(req(user, session, 'm-1'), limits()));
    expect(ticket.lockExpiresAtMs - ticket.acceptedAtMs).toBe(50_000);
    const rows = Object.entries(await dump());
    expect(rows.length).toBeGreaterThan(0);
    for (const [key, [pttl]] of rows) expect(pttl, key).toBeGreaterThanOrEqual(45_000);
    expect(await a.admit(req(user, session, 'm-2'), limits())).toEqual({
      kind: 'rejected',
      code: 30506,
    });
  });
});
