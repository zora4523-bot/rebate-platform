import { expect, it } from 'vitest';
import { queryClient, occupyQueries } from './query-kit.ts';

it.each(['success', 'throw', 'malformed'] as const)(
  '[AC-B1-06za#1] 查询在途上限恰为 8；满额立即失败，%s 后名额可复用',
  async (completion) => {
    const load = await occupyQueries(7);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const eighth = queryClient(async () => {
      entered.resolve();
      await release.promise;
      if (completion === 'throw') throw new Error('synthetic query failure');
      if (completion === 'malformed') {
        return { authorized: 'synthetic malformed' as unknown as boolean };
      }
      return { authorized: true };
    });
    const running = eighth.call();
    const excess = queryClient(async () => ({ authorized: true }));
    try {
      expect(load.client.query).toHaveBeenCalledTimes(7);
      await Promise.race([entered.promise, running]);
      expect(eighth.query).toHaveBeenCalledTimes(1);
      const value = await excess.call();
      expect(value).toBeNull();
      expect(excess.query).not.toHaveBeenCalled();
      release.resolve();
      expect(await running).toBe(completion === 'success' ? true : null);
      // Seven remain held: only the completed/failed eighth slot can admit this query.
      expect(await excess.call()).toBe(true);
      expect(excess.query).toHaveBeenCalledTimes(1);
      expect(load.client.query).toHaveBeenCalledTimes(7);
    } finally {
      release.resolve();
      await running;
      await load.close();
    }
  },
  10_000,
);
