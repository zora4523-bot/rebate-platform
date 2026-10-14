import { afterEach, expect, it, vi } from 'vitest';
import { ports } from '../freeze-expiry/kit.ts';
import { HEAL_INTERVAL_MS, healModule, manualSchedule } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('[AC-B1-03u#6] 导出的固定间隔为五分钟；只在周期到达时补投，连续多个周期都工作', async () => {
  const module = await healModule();
  expect(module.RISK_SCAN_HEAL_INTERVAL_MS).toBe(HEAL_INTERVAL_MS);
  const p = await ports();
  const heal = vi.fn(async () => undefined);
  const timer = manualSchedule();
  const control = module.startRiskScanHeal(
    () => ({ heal }),
    p.logger,
    () => false,
    timer.schedule,
  );
  try {
    expect(timer.schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), HEAL_INTERVAL_MS);
    expect(heal).not.toHaveBeenCalled();
    await timer.fire();
    await timer.fire();
    expect(heal).toHaveBeenCalledTimes(2);
  } finally {
    control.stop();
  }
});

it('[AC-B1-03u#7] 补投拒绝不会丢掉后续周期，记录 warn 后下一周期仍调用 heal', async () => {
  const module = await healModule();
  const p = await ports();
  const heal = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('fixture-unavailable'));
  const timer = manualSchedule();
  const control = module.startRiskScanHeal(
    () => ({ heal }),
    p.logger,
    () => false,
    timer.schedule,
  );
  try {
    await expect(timer.fire()).resolves.toBeUndefined();
    await timer.fire();
    expect(heal).toHaveBeenCalledTimes(2);
    expect(p.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'risk_scan_heal_failed',
        queue: 'risk-scan',
        error_name: 'Error',
      }),
    );
  } finally {
    control.stop();
  }
});

it('[AC-B1-03u#8] 收到停止信号后不再补投；stop 清理定时器，已排进事件循环的回调也不能补投', async () => {
  const module = await healModule();
  const p = await ports();
  const timer = manualSchedule();
  const heal = vi.fn(async () => undefined);
  let stopping = false;
  const control = module.startRiskScanHeal(
    () => ({ heal }),
    p.logger,
    () => stopping,
    timer.schedule,
  );
  try {
    await timer.fire();
    stopping = true;
    await timer.fire();
    expect(heal).toHaveBeenCalledTimes(1);
    control.stop();
    expect(timer.cancel).toHaveBeenCalledTimes(1);
    stopping = false;
    await timer.fire();
    expect(heal).toHaveBeenCalledTimes(1);
  } finally {
    control.stop();
  }
});

it('[AC-B1-03u#9] 启动前已停止或没有扫描服务时不装定时器', async () => {
  const module = await healModule();
  const p = await ports();
  const timer = manualSchedule();
  const resolve = vi.fn(() => ({ heal: vi.fn(async () => undefined) }));
  const stopped = module.startRiskScanHeal(resolve, p.logger, () => true, timer.schedule);
  stopped.stop();
  expect(resolve).not.toHaveBeenCalled();
  for (const absent of [null, undefined, {}]) {
    module
      .startRiskScanHeal(
        () => absent,
        p.logger,
        () => false,
        timer.schedule,
      )
      .stop();
  }
  expect(timer.schedule).not.toHaveBeenCalled();
});

it('[AC-B1-03u#10] 默认调度实际每五分钟触发；停止后无悬挂定时器', async () => {
  const module = await healModule();
  const p = await ports();
  vi.useFakeTimers();
  const heal = vi.fn(async () => undefined);
  const control = module.startRiskScanHeal(
    () => ({ heal }),
    p.logger,
    () => false,
  );
  try {
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS - 1);
    expect(heal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(heal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEAL_INTERVAL_MS);
    expect(heal).toHaveBeenCalledTimes(2);
    control.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HEAL_INTERVAL_MS);
    expect(heal).toHaveBeenCalledTimes(2);
  } finally {
    control.stop();
  }
});
