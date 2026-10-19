import { afterEach, expect, it, vi } from 'vitest';
import { built } from '../wiring/db-kit.ts';
import { wired } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('[AC-B1-08q#1] 真实 worker 向归因和更新注入同一 sources 与 pids，装配无副作用', async () => {
  vi.useFakeTimers();
  const f = await wired();
  try {
    expect(f.updateDeps.sources).toBe(f.deps.sources);
    expect(f.updateDeps.pids).toBe(f.deps.pids);
    expect(f.deps.pids).toMatchObject({ find: expect.any(Function) });
    expect(f.queries).toEqual([]);
    expect(f.queue.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // 当前无 lk 列：不提供读口，或明确返回 null，均符合接线任务的范围。
    if (f.sources.linkByCode !== undefined) {
      for (const lk of ['a1b2c3', '0', 'zzzzzzzzzzzzzzzz']) {
        expect(
          await built(() => f.sources.linkByCode!({ appId: 'n', platform: 'pdd', lk })),
        ).toBeNull();
      }
    }
  } finally {
    await f.context.close();
  }
});
