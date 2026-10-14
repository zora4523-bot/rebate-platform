import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { getBindingAdmission } from '../../../../apps/api/src/modules/linking/application/upstream-limits.ts';
import { suite, RELATION, type WireResponse } from '../bindings/kit.ts';
import { web } from '../bindings/client.ts';
import { scenario, snapshot, state, states } from '../bindings/records.ts';
import { accepted } from '../bindings/assertions.ts';
import { outcome } from '../open-pdd-auth/kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it('[AC-B1-06za#9] HTTP 排队者取得名额前不消费 state，释放后按 FIFO 换凭证', async () => {
  const gate = getBindingAdmission();
  const f = use();
  const holder = await scenario(f);
  const a = await scenario(f);
  const b = await scenario(f);
  const hs = await state(f, holder.c);
  const as = await state(f, a.c);
  const bs = await state(f, b.c);
  const beforeA = await snapshot(f, a.c);
  const beforeB = await snapshot(f, b.c);
  const releaseSynthetic = Promise.withResolvers<void>();
  const releaseHolder = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const holderEntered = Promise.withResolvers<void>();
  const aEntered = Promise.withResolvers<void>();
  const queued = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const order: string[] = [];
  const pending: Promise<unknown>[] = Array.from({ length: 3 }, () =>
    gate.run(async () => {
      await releaseSynthetic.promise;
    }),
  );
  f.exchange.mockImplementation(async (input) => {
    order.push(input.appId);
    if (input.appId === holder.c.appId) {
      holderEntered.resolve();
      await releaseHolder.promise;
    }
    if (input.appId === a.c.appId) {
      aEntered.resolve();
      await releaseA.promise;
    }
    return { kind: 'bound', relationId: RELATION };
  });
  const first = outcome(() => holder.c.post(web(hs.state)));
  pending.push(first);
  let timerSpy: { mockRestore(): void } | undefined;
  try {
    await Promise.race([holderEntered.promise, first]);
    expect([gate.running, gate.waiting]).toEqual([4, 0]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timer = globalThis.setTimeout;
    let arrivals = 0;
    timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay, ...args) => {
      const handle = timer(handler, delay, ...args);
      if (delay === 2000) queued[arrivals++]?.resolve();
      return handle;
    });
    const second = outcome(() => a.c.post(web(as.state)));
    pending.push(second);
    await Promise.race([queued[0]!.promise, second]);
    expect(gate.waiting).toBe(1);
    const third = outcome(() => b.c.post(web(bs.state)));
    pending.push(third);
    await Promise.race([queued[1]!.promise, third]);
    expect(gate.waiting).toBe(2);
    expect(order).toEqual([holder.c.appId]);
    expect(await snapshot(f, a.c)).toEqual(beforeA);
    expect(await snapshot(f, b.c)).toEqual(beforeB);
    releaseHolder.resolve();
    await Promise.race([aEntered.promise, second]);
    expect(order).toEqual([holder.c.appId, a.c.appId]);
    expect(gate.waiting).toBe(1);
    expect(await states(f, a.c)).toEqual([{ ...as, used_at: f.clock.now() }]);
    expect(await snapshot(f, b.c)).toEqual(beforeB);
    releaseA.resolve();
    for (const request of [first, second, third]) {
      const value = await request;
      expect(value).toMatchObject({ statusCode: 200 });
      await accepted(value as WireResponse);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual([holder.c.appId, a.c.appId, b.c.appId]);
    expect(await states(f, b.c)).toEqual([{ ...bs, used_at: f.clock.now() }]);
    expect([gate.running, gate.waiting]).toEqual([3, 0]);
  } finally {
    releaseHolder.resolve();
    releaseA.resolve();
    releaseSynthetic.resolve();
    await Promise.allSettled(pending);
    timerSpy?.mockRestore();
    vi.useRealTimers();
  }
}, 60_000);
