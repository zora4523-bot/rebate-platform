import { afterEach, expect, it, vi } from 'vitest';
import { createOrderRescanScheduler } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import {
  HOUR_MS,
  JD_CAP_MS,
  JD_DAYS,
  JD_ENABLED,
  PDD_ENABLED,
  account,
  fixture,
  mentioning,
  pddAccount,
} from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([
  { days: undefined, seconds: 120 },
  { days: 1, seconds: 3600 },
])(
  '[AC-B1-04zm#49] 启动零投递，days=$days 时第一轮在 $seconds 秒，停止后不再调度',
  async ({ days, seconds }) => {
    vi.useFakeTimers();
    const f = fixture({ config: { [JD_DAYS]: days } });
    const scheduler = createOrderRescanScheduler(f.scheduler, ['jd']);
    expect(f.send).not.toHaveBeenCalled();
    const loop = scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(f.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await loop.stop();
    }
    await vi.advanceTimersByTimeAsync(seconds * 3000);
    expect(f.send).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zm#50] 各平台按自己的窗口数定节奏', async () => {
  vi.useFakeTimers();
  const f = fixture({ accounts: [account, pddAccount], config: { [PDD_ENABLED]: true } });
  const deps = { ...f.scheduler, capsMs: { jd: JD_CAP_MS, pdd: 1_800_000 } };
  const loop = createOrderRescanScheduler(deps, ['jd', 'pdd']).start();
  const sentFor = (platform: string) =>
    f.sent().filter((win) => win['platform'] === platform).length;
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect([sentFor('jd'), sentFor('pdd')]).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect([sentFor('jd'), sentFor('pdd')]).toEqual([1, 2]);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zm#51] 开关每轮重读：关着不投递，打开后不用重启就开始', async () => {
  vi.useFakeTimers();
  const f = fixture({ config: { [JD_ENABLED]: false } });
  const loop = createOrderRescanScheduler(f.scheduler, ['jd']).start();
  try {
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(f.send).not.toHaveBeenCalled();
    f.config.get.mockImplementation(async (key) => (key === JD_ENABLED ? true : undefined));
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(f.send).toHaveBeenCalled();
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zm#52] 一轮失败只记日志，后面的轮次照常', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.listEnabledAccounts.mockRejectedValueOnce(new Error('synthetic round failure'));
  const loop = createOrderRescanScheduler(f.scheduler, ['jd']).start();
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.send).toHaveBeenCalledTimes(1);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zm#53] 启动时读配置失败不影响起循环，恢复后照常投递', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.config.get.mockRejectedValue(new Error('synthetic config outage'));
  const loop = createOrderRescanScheduler(f.scheduler, ['jd']).start();
  try {
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(f.send).not.toHaveBeenCalled();
    f.config.get.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(f.send).toHaveBeenCalled();
  } finally {
    await loop.stop();
  }
});

it.each([0, -1, 1.5, 91, '45', 'abc'])(
  '[AC-B1-04zm#84] days=%j 不合法：按默认 120 秒一轮，不会空转，每轮只 warn 一次',
  async (days) => {
    vi.useFakeTimers();
    const f = fixture({ config: { [JD_DAYS]: days } });
    const warned = () => mentioning(f.logger.warn, JD_DAYS).length;
    const loop = createOrderRescanScheduler(f.scheduler, ['jd']).start();
    try {
      await vi.advanceTimersByTimeAsync(119_999);
      expect(f.send).not.toHaveBeenCalled();
      expect(warned()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(warned()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(warned()).toBe(2);
    } finally {
      await loop.stop();
    }
  },
);
