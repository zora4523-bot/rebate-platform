// B3-03g replacement of the B3-03c quota rules on PostgreSQL (design §7.3 rows quota:23 … :287).
// Day usage = runs accepted that +08:00 day whose settle_result is not 'refunded'; settle's
// quota_left uses the limits the source gives at settle time (set by the kit before settle).
import { expect, it } from 'vitest';
import {
  nextStepOf,
  shouldRefund,
  type RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import { accepted, guest, limits, member, opaque, usePg, withGate } from './kit.ts';

const pg = usePg();

it('[AC-B3-03g#70][BR-AI-15] 会员按 user_id 计：quota_left 逐条递减到 0，下一条 30502{reset_at 次日 00:00+08:00, next none}，跨设备合计', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    expect(nextStepOf(user)).toBe('none');
    const quota = limits({ memberDaily: 3 });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(2);
    expect(accepted(await b.admit(await req(user), quota)).quotaLeft).toBe(1);
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(0);
    expect(await b.admit(await req(user), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-07T00:00:00+08:00',
      next: 'none',
    });
    expect(accepted(await a.admit(await req(member()), quota)).quotaLeft).toBe(2);
  });
});

it('[AC-B3-03g#71][BR-AI-15] 自然日 +08:00 00:00 重置：23:59:59.999 仍 30502，00:00:00.000 起重新计数', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 1 });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(0);
    clock.set('2026-10-06T23:59:59.999+08:00');
    expect(await a.admit(await req(user), quota)).toMatchObject({ kind: 'rejected', code: 30502 });
    clock.set('2026-10-07T00:00:00.000+08:00');
    const next = accepted(await a.admit(await req(user), quota));
    expect(next.quotaLeft).toBe(0);
    expect(next.ticket.dayKey).toBe('2026-10-07');
  });
});

it('[AC-B3-03g#72][BR-AI-15] 游客档：device_hash 与 IP 两个计数任一到上限即 30502（next：游客 login、已登录未绑手机 bind_phone），quota_left 取较小者，同 IP 不同设备合计', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const ip = opaque('ik');
    const [h1, h2, h3] = [opaque('dh'), opaque('dh'), opaque('dh')];
    expect(nextStepOf(guest(h1, ip))).toBe('login');
    expect(nextStepOf(guest(h1, ip, true))).toBe('bind_phone');
    const quota = limits({ guestDaily: 2, guestIpDaily: 3 });
    expect(accepted(await a.admit(await req(guest(h1, ip)), quota)).quotaLeft).toBe(1);
    expect(accepted(await b.admit(await req(guest(h1, ip)), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(guest(h1, ip)), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-07T00:00:00+08:00',
      next: 'login',
    });
    expect(accepted(await a.admit(await req(guest(h2, ip)), quota)).quotaLeft).toBe(0);
    expect(await b.admit(await req(guest(h3, ip, true)), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-07T00:00:00+08:00',
      next: 'bind_phone',
    });
    expect(accepted(await a.admit(await req(guest(h3, opaque('ik'))), quota)).quotaLeft).toBe(1);
  });
});

it('[AC-B3-03g#73][BR-AI-15] 同一 device_hash 登录前后共用计数（只登录不绑手机仍 30502）；绑手机后按 user_id 重新计，游客计数不迁移', async () => {
  await withGate(pg, async ({ a, req }) => {
    const hash = opaque('dh');
    const quota = limits({ guestDaily: 3, memberDaily: 30 });
    expect(accepted(await a.admit(await req(guest(hash, opaque('ik'))), quota)).quotaLeft).toBe(2);
    expect(
      accepted(await a.admit(await req(guest(hash, opaque('ik'), true)), quota)).quotaLeft,
    ).toBe(1);
    expect(accepted(await a.admit(await req(guest(hash, opaque('ik'))), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(guest(hash, opaque('ik'), true)), quota)).toMatchObject({
      kind: 'rejected',
      code: 30502,
      next: 'bind_phone',
    });
    expect(accepted(await a.admit(await req(member()), quota)).quotaLeft).toBe(29);
  });
});

it('[AC-B3-03g#74][BR-AI-15] 退还：服务端原因且无卡片退 1 条（quota_left 计入退还）；有卡片或照常计数的结局不退；同票据二次结算不再退（返回首次结算结论）、不退到负数', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 2 });
    const first = accepted(await a.admit(await req(user), quota));
    expect(first.quotaLeft).toBe(1);
    const failed = { ending: 'server_error', cardsDelivered: 0 } as const;
    expect(await a.settle(first.ticket, failed, quota)).toEqual({ refunded: true, quotaLeft: 2 });
    expect(await b.settle(first.ticket, failed, quota)).toEqual({ refunded: true, quotaLeft: 2 });
    const second = accepted(await a.admit(await req(user), quota));
    expect(second.quotaLeft).toBe(1);
    const carded = { ending: 'timeout', cardsDelivered: 1 } as const;
    expect(await a.settle(second.ticket, carded, quota)).toEqual({ refunded: false, quotaLeft: 1 });
    const third = accepted(await a.admit(await req(user), quota));
    expect(third.quotaLeft).toBe(0);
    const cancelled = { ending: 'cancelled', cardsDelivered: 0 } as const;
    expect(await a.settle(third.ticket, cancelled, quota)).toEqual({
      refunded: false,
      quotaLeft: 0,
    });
    expect(await a.admit(await req(user), quota)).toMatchObject({ kind: 'rejected', code: 30502 });
  });
});

it('[AC-B3-03g#75][BR-AI-15] 游客退还 device_hash 与 IP 两个计数', async () => {
  await withGate(pg, async ({ a, req }) => {
    const ip = opaque('ik');
    const [h1, h2, h3] = [opaque('dh'), opaque('dh'), opaque('dh')];
    const quota = limits({ guestDaily: 1, guestIpDaily: 2 });
    const first = accepted(await a.admit(await req(guest(h1, ip)), quota));
    expect(await a.admit(await req(guest(h1, ip)), quota)).toMatchObject({ code: 30502 });
    const refund = { ending: 'disabled', cardsDelivered: 0 } as const;
    expect(await a.settle(first.ticket, refund, quota)).toEqual({ refunded: true, quotaLeft: 1 });
    expect(accepted(await a.admit(await req(guest(h1, ip)), quota)).quotaLeft).toBe(0);
    expect(accepted(await a.admit(await req(guest(h2, ip)), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(guest(h3, ip)), quota)).toMatchObject({
      code: 30502,
      next: 'login',
    });
  });
});

it('[AC-B3-03g#76][BR-AI-15] 跨日退还退受理日：23:59:50 受理、次日 00:00:20 以服务端原因无卡结束 → 退前一日，新一日不受影响，settle 返回结算当日剩余', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 2 });
    clock.set('2026-10-06T23:59:50+08:00');
    const late = accepted(await a.admit(await req(user), quota));
    expect(late.ticket.dayKey).toBe('2026-10-06');
    expect(late.ticket.acceptedAtMs).toBe(1791302390000);
    clock.set('2026-10-07T00:00:20+08:00');
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(1);
    const failed = { ending: 'server_error', cardsDelivered: 0 } as const;
    expect(await a.settle(late.ticket, failed, quota)).toEqual({ refunded: true, quotaLeft: 1 });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(user), quota)).toMatchObject({ kind: 'rejected', code: 30502 });
    clock.set('2026-10-06T23:59:55+08:00');
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(1);
  });
});

it('[AC-B3-03g#77][BR-AI-15] 游客两个计数的日界：23:59:59.999 设备满或 IP 满仍 30502（reset_at、next 照身份），00:00 两个计数都重置', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const ip = opaque('ik');
    const [h1, h2, h3, h4] = [opaque('dh'), opaque('dh'), opaque('dh'), opaque('dh')];
    const quota = limits({ guestDaily: 1, guestIpDaily: 2 });
    accepted(await a.admit(await req(guest(h1, ip)), quota));
    clock.set('2026-10-06T23:59:59.999+08:00');
    expect(await a.admit(await req(guest(h1, ip)), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-07T00:00:00+08:00',
      next: 'login',
    });
    accepted(await a.admit(await req(guest(h2, ip)), quota));
    expect(await a.admit(await req(guest(h3, ip, true)), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-07T00:00:00+08:00',
      next: 'bind_phone',
    });
    clock.set('2026-10-07T00:00:00.000+08:00');
    expect(accepted(await a.admit(await req(guest(h1, ip)), quota)).quotaLeft).toBe(0);
    expect(accepted(await a.admit(await req(guest(h3, ip, true)), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(guest(h4, ip)), quota)).toEqual({
      kind: 'rejected',
      code: 30502,
      resetAt: '2026-10-08T00:00:00+08:00',
      next: 'login',
    });
  });
});

it('[AC-B3-03g#78][BR-AI-15] 结束原因 × 卡片 0/1（服务端原因另加 2）用真实收尾结算：只有服务端原因且无卡退 1 条（与 shouldRefund 一致），经后续受理核对计数', async () => {
  const table: [RunEnding, number, boolean][] = [
    ['server_error', 0, true],
    ['server_error', 1, false],
    ['server_error', 2, false],
    ['disabled', 0, true],
    ['disabled', 1, false],
    ['timeout', 0, true],
    ['timeout', 1, false],
    ['timeout', 2, false],
    ['input_review_timeout', 0, true],
    ['input_review_timeout', 1, false],
    ['stop', 0, false],
    ['stop', 1, false],
    ['fallback', 0, false],
    ['fallback', 1, false],
    ['budget', 0, false],
    ['budget', 1, false],
    ['auth_required', 0, false],
    ['auth_required', 1, false],
    ['safety', 0, false],
    ['safety', 1, false],
    ['limit', 0, false],
    ['limit', 1, false],
    ['client_error', 0, false],
    ['client_error', 1, false],
    ['cancelled', 0, false],
    ['cancelled', 1, false],
    ['disconnected', 0, false],
    ['disconnected', 1, false],
    ['consent_withdrawn', 0, false],
    ['consent_withdrawn', 1, false],
  ];
  for (const [ending, cardsDelivered, refund] of table) {
    expect(shouldRefund({ ending, cardsDelivered }), `${ending}/${String(cardsDelivered)}`).toBe(
      refund,
    );
  }
  await withGate(pg, async ({ a, req }) => {
    const quota = limits({ memberDaily: 1 });
    for (const [ending, cardsDelivered, refund] of table) {
      const label = `${ending}/${String(cardsDelivered)}`;
      const user = member();
      const { ticket } = accepted(await a.admit(await req(user), quota));
      if (cardsDelivered > 0) {
        await a.inst.ports.registry.recordFacts(ticket.runId, { ending: null, cardsDelivered });
      }
      expect(await a.settle(ticket, { ending, cardsDelivered }, quota), label).toEqual({
        refunded: refund,
        quotaLeft: refund ? 1 : 0,
      });
      const after = await a.admit(await req(user), quota);
      expect(
        after.kind === 'accepted' ? 'accepted' : after.kind === 'rejected' ? after.code : 0,
        label,
      ).toBe(refund ? 'accepted' : 30502);
    }
  });
});

it('[AC-B3-03g#79][BR-AI-15] 跨日已出卡后失败不退：23:59:50 受理、次日 00:00:20 以 server_error 结束且已下发 1 张卡 → 前一日仍计 1 条', async () => {
  await withGate(pg, async ({ a, clock, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 1 });
    clock.set('2026-10-06T23:59:50+08:00');
    const late = accepted(await a.admit(await req(user), quota));
    clock.set('2026-10-07T00:00:20+08:00');
    const carded = { ending: 'server_error', cardsDelivered: 1 } as const;
    expect(await a.settle(late.ticket, carded, quota)).toEqual({ refunded: false, quotaLeft: 1 });
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(0);
    clock.set('2026-10-06T23:59:55+08:00');
    expect(await a.admit(await req(user), quota)).toMatchObject({ kind: 'rejected', code: 30502 });
  });
});

it('[AC-B3-03g#80][BR-AI-15] settle 的 quota_left 是结算时的真实剩余：两会话交错受理与结算，含中间退还', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 30 });
    const one = accepted(await a.admit(await req(user), quota));
    expect(one.quotaLeft).toBe(29);
    const two = accepted(await b.admit(await req(user), quota));
    expect(two.quotaLeft).toBe(28);
    const stop = { ending: 'stop', cardsDelivered: 1 } as const;
    expect(await a.settle(one.ticket, stop, quota)).toEqual({ refunded: false, quotaLeft: 28 });
    const three = accepted(await a.admit(await req(user), quota));
    expect(three.quotaLeft).toBe(27);
    const failed = { ending: 'server_error', cardsDelivered: 0 } as const;
    expect(await b.settle(two.ticket, failed, quota)).toEqual({ refunded: true, quotaLeft: 28 });
    expect(await a.settle(three.ticket, stop, quota)).toEqual({ refunded: false, quotaLeft: 28 });
  });
});

it('[AC-B3-03g#81][BR-AI-15] 游客结算的 quota_left = min(设备剩余, IP 剩余)：IP 剩余较小时正常结束与退还后都取 IP', async () => {
  await withGate(pg, async ({ a, req }) => {
    const ip = opaque('ik');
    const [h1, h2] = [opaque('dh'), opaque('dh')];
    const quota = limits({ guestDaily: 3, guestIpDaily: 4 });
    accepted(await a.admit(await req(guest(h2, ip)), quota));
    accepted(await a.admit(await req(guest(h2, ip)), quota));
    const one = accepted(await a.admit(await req(guest(h1, ip)), quota));
    expect(one.quotaLeft).toBe(1);
    const stop = { ending: 'stop', cardsDelivered: 0 } as const;
    expect(await a.settle(one.ticket, stop, quota)).toEqual({ refunded: false, quotaLeft: 1 });
    const two = accepted(await a.admit(await req(guest(h1, ip)), quota));
    expect(two.quotaLeft).toBe(0);
    const off = { ending: 'disabled', cardsDelivered: 0 } as const;
    expect(await a.settle(two.ticket, off, quota)).toEqual({ refunded: true, quotaLeft: 1 });
  });
});

it('[AC-B3-03g#82][BR-AI-15] 两实例并发结算同一票据只退 1 条：结算与退还在同一事务、同一 run 行锁与主体锁下', async () => {
  await withGate(pg, async ({ a, b, req }) => {
    const user = member();
    const quota = limits({ memberDaily: 3 });
    accepted(await a.admit(await req(user), quota));
    const { ticket } = accepted(await a.admit(await req(user), quota));
    const failed = { ending: 'timeout', cardsDelivered: 0 } as const;
    const both = await Promise.all([
      a.settle(ticket, failed, quota),
      b.settle(ticket, failed, quota),
    ]);
    expect(both).toEqual([
      { refunded: true, quotaLeft: 2 },
      { refunded: true, quotaLeft: 2 },
    ]);
    expect(accepted(await a.admit(await req(user), quota)).quotaLeft).toBe(1);
    expect(accepted(await b.admit(await req(user), quota)).quotaLeft).toBe(0);
    expect(await a.admit(await req(user), quota)).toMatchObject({ kind: 'rejected', code: 30502 });
  });
});
