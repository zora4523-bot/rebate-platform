import { afterEach, expect, it, vi } from 'vitest';
import { api, growth } from './kit.ts';
type Logging = typeof import('../../../../apps/api/src/modules/platform/logging/logger.ts');

afterEach(() => {
  vi.useRealTimers();
});
async function logger() {
  const logging = await api<Logging>('platform/logging/logger.ts');
  return logging.createRootLogger(
    { level: 'silent', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
}

it('[AC-B1-35#100] worker 首轮扫描，每 60 秒继续，stop 后不再调度', async () => {
  vi.useFakeTimers();
  const tick = vi.fn(async () => undefined);
  const worker = (await growth()).startInviteRewardWorker({
    scanner: { tick },
    logger: await logger(),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    await worker.stop();
  }
  await vi.advanceTimersByTimeAsync(120000);
  expect(tick).toHaveBeenCalledTimes(2);
});

it('[AC-B1-35#101] worker 慢扫描不重叠，stop 等待在途扫描完成', async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tick = vi.fn(() => blocked);
  const worker = (await growth()).startInviteRewardWorker({
    scanner: { tick },
    logger: await logger(),
  });
  await vi.advanceTimersByTimeAsync(120000);
  expect(tick).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(stopped).toBe(true);
});
