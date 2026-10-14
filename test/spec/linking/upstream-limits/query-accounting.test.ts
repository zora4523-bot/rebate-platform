import { expect, it } from 'vitest';
import { queryClient } from './query-kit.ts';

interface HeldQuery {
  readonly client: ReturnType<typeof queryClient>;
  readonly release: PromiseWithResolvers<void>;
  readonly entered: PromiseWithResolvers<void>;
  readonly pending: ReturnType<ReturnType<typeof queryClient>['call']>;
}

it('[AC-B1-06za#14] 连续拒绝不释放名额；成功、抛错、畸形答案各恰好释放一个查询名额', async () => {
  const held: HeldQuery[] = [];
  let active = 0;
  let peak = 0;

  function startHeld(completion: 'success' | 'throw' | 'malformed'): HeldQuery {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const client = queryClient(async () => {
      active += 1;
      peak = Math.max(peak, active);
      entered.resolve();
      try {
        await release.promise;
        if (completion === 'throw') throw new Error('synthetic query failure');
        if (completion === 'malformed') {
          return { authorized: 'synthetic malformed' as unknown as boolean };
        }
        return { authorized: true };
      } finally {
        active -= 1;
      }
    });
    const pending = client.call();
    const call = { client, release, entered, pending };
    held.push(call);
    return call;
  }

  const excess = queryClient(async () => ({ authorized: true }));
  async function assertStillFull() {
    // Every attempt must refuse: a refusal must never decrement another query's count.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await excess.call()).toBeNull();
      expect(excess.query).not.toHaveBeenCalled();
      expect(active).toBe(8);
    }
  }

  try {
    const endings = ['success', 'throw', 'malformed'] as const;
    const completing = endings.map(startHeld);
    for (let index = 0; index < 5; index += 1) startHeld('success');
    await Promise.all(held.map((call) => Promise.race([call.entered.promise, call.pending])));
    expect(active).toBe(8);
    for (const call of held) expect(call.client.query).toHaveBeenCalledTimes(1);
    await assertStillFull();

    for (const [index, call] of completing.entries()) {
      call.release.resolve();
      expect(await call.pending).toBe(endings[index] === 'success' ? true : null);
      expect(active).toBe(7);

      // Hold the replacement in the adapter; an extra released slot becomes observable.
      const replacement = startHeld('success');
      await Promise.race([replacement.entered.promise, replacement.pending]);
      expect(replacement.client.query).toHaveBeenCalledTimes(1);
      expect(active).toBe(8);
      await assertStillFull();
      expect(peak).toBe(8);
    }
  } finally {
    for (const call of held) call.release.resolve();
    await Promise.all(held.map((call) => call.pending));
  }
  expect(active).toBe(0);
}, 10_000);
