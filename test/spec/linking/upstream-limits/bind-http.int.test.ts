import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { getBindingAdmission } from '../../../../apps/api/src/modules/linking/application/upstream-limits.ts';
import { suite, RELATION, type WireResponse } from '../bindings/kit.ts';
import { web } from '../bindings/client.ts';
import { scenario, snapshot, state, states } from '../bindings/records.ts';
import { accepted, validate } from '../bindings/assertions.ts';
import { outcome } from '../open-pdd-auth/kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['full', 'timeout'] as const)(
  '[AC-B1-06za#7] bind %s 回 42901 + Retry-After；同 state/幂等键之后仍可成功',
  async (mode) => {
    const gate = getBindingAdmission();
    const f = use();
    const holder = await scenario(f);
    const target = await scenario(f);
    const holderState = await state(f, holder.c);
    const targetState = await state(f, target.c);
    const before = await snapshot(f, target.c);
    const key = randomUUID();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    const syntheticWork = vi.fn(async () => {
      await release.promise;
    });
    pending.push(...Array.from({ length: 3 }, () => gate.run(syntheticWork)));
    f.exchange.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { kind: 'bound', relationId: RELATION };
    });
    const first = outcome(() => holder.c.post(web(holderState.state)));
    pending.push(first);
    let timerSpy: { mockRestore(): void } | undefined;
    try {
      await Promise.race([entered.promise, first]);
      expect(f.exchange).toHaveBeenCalledTimes(1);
      // A real HTTP bind must occupy the same process queue as the three held callbacks.
      expect([gate.running, gate.waiting]).toEqual([4, 0]);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      if (mode === 'full') {
        pending.push(...Array.from({ length: 16 }, () => gate.run(syntheticWork)));
        expect(gate.waiting).toBe(16);
      }
      const enqueued = Promise.withResolvers<void>();
      const timer = globalThis.setTimeout;
      timerSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, delay, ...args) => {
          const handle = timer(handler, delay, ...args);
          if (delay === 2000) enqueued.resolve();
          return handle;
        });
      let settled = false;
      const refused = outcome(() => target.c.post(web(targetState.state), { key })).then(
        (value) => {
          settled = true;
          return value;
        },
      );
      pending.push(refused);
      if (mode === 'timeout') {
        // Observe actual queue-timer registration, never infer arrival from a sleep.
        await Promise.race([enqueued.promise, refused]);
        expect(gate.waiting).toBe(1);
        await vi.advanceTimersByTimeAsync(1999);
        expect(settled).toBe(false);
        expect(await snapshot(f, target.c)).toEqual(before);
        expect(f.exchange).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
      }
      const value = await refused;
      expect(value).toMatchObject({ statusCode: 429 });
      const http = value as WireResponse;
      const body = http.json<{ code: number; data?: unknown }>();
      expect(body.code).toBe(42901);
      expect(body.data ?? {}).toEqual({});
      expect(String(http.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);
      await validate(body, 'ErrorEnvelope');
      expect(await snapshot(f, target.c)).toEqual(before);
      expect(f.exchange).toHaveBeenCalledTimes(1);
      expect(syntheticWork).toHaveBeenCalledTimes(3);
      expect(
        await f.db
          .selectFrom('idempotency_keys')
          .selectAll()
          .where('app_id', '=', target.c.appId)
          .where('key', '=', key)
          .execute(),
      ).toEqual([]);
      expect(gate.waiting).toBe(mode === 'full' ? 16 : 0);
      release.resolve();
      await Promise.all(pending);
      timerSpy.mockRestore();
      timerSpy = undefined;
      vi.useRealTimers();
      await accepted((await first) as WireResponse);
      expect([gate.running, gate.waiting]).toEqual([0, 0]);
      const success = await target.c.post(web(targetState.state), { key });
      await accepted(success);
      expect(await states(f, target.c)).toEqual([{ ...targetState, used_at: f.clock.now() }]);
      expect(f.exchange).toHaveBeenCalledTimes(2);
      const replay = await target.c.post(web(targetState.state), { key });
      await accepted(replay);
      expect(replay.json()).toEqual(success.json());
      expect(f.exchange).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      timerSpy?.mockRestore();
      vi.useRealTimers();
    }
  },
  60_000,
);
