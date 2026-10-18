import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  unionPolicy,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedSyncAdapter,
  createUnionSyncAccess,
  UnionError,
} from '../../../../apps/api/src/modules/union/index.ts';
import { adapter, window } from '../../union/skeleton/kit.ts';
import { compileOnlyDb } from './context-kit.ts';
import { built, endpoint, NOW } from './db-kit.ts';

it.each(['online', 'order_sync'] as const)(
  '[AC-B1-08n#18] %s 的熔断与 offlineCircuitOpen 同源，离线到期自动恢复',
  async (purpose) => {
    const clock = new FixedClock(NOW);
    const scheduler: Scheduler = {
      now: () => clock.now().getTime(),
      sleep: (ms, signal) =>
        ms < 3000
          ? Promise.resolve()
          : new Promise<void>((_resolve, reject) => {
              if (signal?.aborted) reject(signal.reason);
              else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
    };
    const ep = endpoint('live');
    const raw = adapter('pdd');
    const failure = new UnionError('upstream_unavailable', 'synthetic', 'pdd');
    raw.listOrders = vi.fn().mockRejectedValue(failure);
    const governed = await built(() =>
      createGovernedSyncAdapter(raw, {
        endpoint: ep,
        scheduler,
        quota: { bucketKey: ep.quotaKey, tryAcquire: () => true },
      }),
    );
    const queries: string[] = [];
    const access = await built(() =>
      createUnionSyncAccess({
        db: compileOnlyDb(queries),
        endpoints: [ep],
        breaker: () => governed.offlineBreakerState(),
        logger: { error: vi.fn() },
      }),
    );
    expect(await access.offlineCircuitOpen('pdd')).toBe(false);
    for (let i = 0; i < 20; i++) {
      await expect(
        governed.adapter.listOrders(
          window,
          {},
          { appId: 'synthetic', requestId: 'synthetic', purpose },
        ),
      ).rejects.toBeDefined();
    }
    expect(await access.offlineCircuitOpen('pdd')).toBe(purpose === 'order_sync');
    await expect(
      governed.adapter.listOrders(
        window,
        {},
        { appId: 'synthetic', requestId: 'synthetic', purpose },
      ),
    ).rejects.toMatchObject({ code: 'circuit_open' });
    clock.advanceMs(unionPolicy('offline').breaker.openMs);
    expect(await access.offlineCircuitOpen('pdd')).toBe(false);
    expect(queries).toEqual([]);
  },
);
