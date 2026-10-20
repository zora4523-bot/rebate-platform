import { afterEach, expect, it, vi } from 'vitest';
import { deferred, fields, identity, manualSchedule, ports } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-13g#20] 周期固定 60 秒，不立即执行，逐周期驱动且 stop 幂等取消', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi.fn(async () => ({ scanned: 0 }));
  const control = api.startPayoutVerifyRecheck(
    () => ({ runOnce }),
    p.logger,
    () => false,
    timer.schedule,
  );
  try {
    expect(api.PAYOUT_VERIFY_RECHECK_INTERVAL_MS).toBe(60_000);
    expect(timer.schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60_000);
    expect(runOnce).not.toHaveBeenCalled();
    await timer.fire();
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(2);
    await control.stop();
    await control.stop();
    expect(timer.cancel).toHaveBeenCalledTimes(1);
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(2);
  } finally {
    await control.stop();
  }
});

it('[AC-B1-13g#21] 上轮挂起时多个 tick 不重叠，结束后下一轮恢复，stop 等待在途工作', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const held = deferred<{ scanned: number }>();
  const runOnce = vi.fn(async () => ({ scanned: 0 })).mockImplementationOnce(() => held.promise);
  const control = api.startPayoutVerifyRecheck(
    () => ({ runOnce }),
    p.logger,
    () => false,
    timer.schedule,
  );
  const pending = timer.fire();
  try {
    await Promise.resolve();
    await timer.fire();
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(1);
    held.resolve({ scanned: 1 });
    await pending;
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(2);
    const ending = deferred<{ scanned: number }>();
    runOnce.mockImplementationOnce(() => ending.promise);
    const last = timer.fire();
    let finished = false;
    const stop = control.stop().then(() => {
      finished = true;
    });
    try {
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(timer.cancel).toHaveBeenCalledTimes(1);
    } finally {
      ending.resolve({ scanned: 1 });
      await last;
      await stop;
    }
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(3);
  } finally {
    held.resolve({ scanned: 0 });
    await pending;
    await control.stop();
  }
});

it('[AC-B1-13g#22] 一轮拒绝只告警错误名并恢复后续周期，不能留下进行中标记', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi
    .fn(async () => ({ scanned: 0 }))
    .mockRejectedValueOnce(new TypeError('synthetic-card-secret'));
  const control = api.startPayoutVerifyRecheck(
    () => ({ runOnce }),
    p.logger,
    () => false,
    timer.schedule,
  );
  try {
    await expect(timer.fire()).resolves.toBeUndefined();
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(2);
    const warnings = p.logs().filter((line) => line['level'] === 40);
    expect(warnings).toHaveLength(1);
    expect(fields(warnings[0]!)).toEqual({ error_name: 'TypeError' });
    expect(p.lines.join('')).not.toContain('synthetic-card-secret');
  } finally {
    await control.stop();
  }
});

it.each(['stopping', 'null', 'throws'] as const)(
  '[AC-B1-13g#23] 启动状态 %s 时不创建定时器也不崩溃',
  async (condition) => {
    const api = await identity();
    const p = await ports();
    const timer = manualSchedule();
    const resolve = vi.fn(() => {
      if (condition === 'throws') throw new Error('synthetic-private-error');
      return null;
    });
    const control = api.startPayoutVerifyRecheck(
      resolve,
      p.logger,
      () => condition === 'stopping',
      timer.schedule,
    );
    await control.stop();
    expect(timer.schedule).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(condition === 'stopping' ? 0 : 1);
    if (condition === 'throws') {
      const warnings = p.logs().filter((line) => line['level'] === 40);
      expect(warnings).toHaveLength(1);
      expect(fields(warnings[0]!)).toEqual({ error_name: 'Error' });
    }
    expect(p.logs().filter((line) => line['level'] === 50)).toEqual([]);
    expect(p.lines.join('')).not.toContain('synthetic-private-error');
  },
);

it('[AC-B1-13g#24] 外部 stopping 为真后排队的 tick 不再驱动', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi.fn(async () => ({ scanned: 0 }));
  let stopping = false;
  const control = api.startPayoutVerifyRecheck(
    () => ({ runOnce }),
    p.logger,
    () => stopping,
    timer.schedule,
  );
  try {
    await timer.fire();
    stopping = true;
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(1);
  } finally {
    await control.stop();
  }
});

it('[AC-B1-13g#25] 默认 setInterval unref，不立即执行，到 60 秒驱动，stop 清理定时器', async () => {
  const api = await identity();
  const p = await ports();
  vi.useFakeTimers();
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const runOnce = vi.fn(async () => ({ scanned: 0 }));
  const control = api.startPayoutVerifyRecheck(
    () => ({ runOnce }),
    p.logger,
    () => false,
  );
  try {
    expect(intervals).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60_000);
    const handle = intervals.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runOnce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await control.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  } finally {
    await control.stop();
  }
});
