// B1-15f: the expiry timer (brief §9.2 #1, «已定» 调度: identity 内 60 秒定时器, B1-13g 先例; rule-test
// list item 11): 60 s, no immediate round, no overlap, stop waits for the current round, a stop
// already requested / a resolve answering null or throwing → no timer. No database, no listen.
import { afterEach, expect, it, vi } from 'vitest';
import { INTERVAL_MS, deferred, fields, identity, manualSchedule, ports } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-15f#20] 周期 60 秒、不立即执行首轮，逐周期驱动，stop 幂等且只取消一次', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi.fn(async () => ({ scanned: 0 }));
  const control = api.startDeletionExpiry(
    () => ({ runOnce }),
    p.logger,
    () => false,
    timer.schedule,
  );
  try {
    expect(timer.schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), INTERVAL_MS);
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

it('[AC-B1-15f#21] 上一轮未结束时 tick 不重叠；stop 等当前轮结束才返回', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const held = deferred<{ scanned: number }>();
  const runOnce = vi.fn(async () => ({ scanned: 0 })).mockImplementationOnce(() => held.promise);
  const control = api.startDeletionExpiry(
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
    let stopped = false;
    const stop = control.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(timer.cancel).toHaveBeenCalledTimes(1);
    held.resolve({ scanned: 1 });
    await pending;
    await stop;
    expect(stopped).toBe(true);
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve({ scanned: 0 });
    await pending;
    await control.stop();
  }
});

it('[AC-B1-15f#22] 定时器把停止判定传给 runOnce：stop 之后判定为真', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const held = deferred<{ scanned: number }>();
  let seen: (() => boolean) | undefined;
  const runOnce = vi.fn((stopping?: () => boolean) => {
    seen = stopping;
    return held.promise;
  });
  const control = api.startDeletionExpiry(
    () => ({ runOnce }),
    p.logger,
    () => false,
    timer.schedule,
  );
  const pending = timer.fire();
  try {
    await Promise.resolve();
    expect(seen).toEqual(expect.any(Function));
    expect(seen!()).toBe(false);
    const stop = control.stop();
    expect(seen!()).toBe(true);
    held.resolve({ scanned: 0 });
    await pending;
    await stop;
  } finally {
    held.resolve({ scanned: 0 });
    await pending;
    await control.stop();
  }
});

it('[AC-B1-15f#23] 一轮抛错只 warn 错误名，不泄露消息，后续周期照常', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi
    .fn(async () => ({ scanned: 0 }))
    .mockRejectedValueOnce(new TypeError('synthetic-private-detail'));
  const control = api.startDeletionExpiry(
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
    expect(p.lines.join('')).not.toContain('synthetic-private-detail');
  } finally {
    await control.stop();
  }
});

it.each(['stopping', 'null', 'throws', 'no-runner'] as const)(
  '[AC-B1-15f#24] 启动状态 %s：不建定时器、不崩溃、不记日志',
  async (condition) => {
    const api = await identity();
    const p = await ports();
    const timer = manualSchedule();
    const resolve = vi.fn((): unknown => {
      if (condition === 'throws') throw new Error('synthetic-private-error');
      return condition === 'no-runner' ? { start: () => undefined } : null;
    });
    const control = api.startDeletionExpiry(
      resolve,
      p.logger,
      () => condition === 'stopping',
      timer.schedule,
    );
    await expect(control.stop()).resolves.toBeUndefined();
    expect(timer.schedule).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(condition === 'stopping' ? 0 : 1);
    expect(p.logs().filter((line) => Number(line['level']) >= 40)).toEqual([]);
    expect(p.lines.join('')).not.toContain('synthetic-private-error');
  },
);

it('[AC-B1-15f#25] 外部 stopping 为真后，排队的 tick 不再驱动', async () => {
  const api = await identity();
  const p = await ports();
  const timer = manualSchedule();
  const runOnce = vi.fn(async () => ({ scanned: 0 }));
  let stopping = false;
  const control = api.startDeletionExpiry(
    () => ({ runOnce }),
    p.logger,
    () => stopping,
    timer.schedule,
  );
  try {
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(1);
    stopping = true;
    await timer.fire();
    expect(runOnce).toHaveBeenCalledTimes(1);
  } finally {
    await control.stop();
  }
});
