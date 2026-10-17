// B1-08g D10-29: incremental PDD only; no rescans, manual filters or invented TB/JD windows.
import { expect, it } from 'vitest';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import { ACCOUNT, END, NOW, START, account, fixture, stream, window } from './kit.ts';

it('[AC-B1-08g#1] 无水位从账号 sync_start_at 起算，固定 30 分钟窗口和完整 singletonKey', async () => {
  const f = fixture();
  await scheduleOrderSync(f.scheduler);
  expect(f.read).toHaveBeenCalledExactlyOnceWith(stream);
  expect(f.send).toHaveBeenCalledExactlyOnceWith('order-sync', expect.any(String), window, {
    trx: null,
    singletonKey: `pdd:${ACCOUNT}:increment:-:${START}`,
  });
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#2] 已有水位优先于 sync_start_at，每轮只投当前连续窗口', async () => {
  const f = fixture();
  f.read.mockResolvedValue(END);
  await scheduleOrderSync(f.scheduler);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.[2]).toEqual({
    ...window,
    window_start: END,
    window_end: '2026-10-17T01:00:00.000Z',
  });
  expect(f.send.mock.calls[0]?.[3].singletonKey).toBe(`pdd:${ACCOUNT}:increment:-:${END}`);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#3] 尾窗截到注入时钟 now，保留 ISO 毫秒', async () => {
  const f = fixture();
  const now = '2026-10-17T00:11:12.345Z';
  f.clock.set(now);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([
    { ...window, window_end: now },
  ]);
});

it.each([NOW, '2026-10-17T02:00:00.001Z'])(
  '[AC-B1-08g#4] 水位 %s 不早于 now，零长与负长窗口都不投',
  async (cursor) => {
    const f = fixture();
    f.read.mockResolvedValue(cursor);
    await scheduleOrderSync(f.scheduler);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.advance).not.toHaveBeenCalled();
  },
);

it('[AC-B1-08g#5] 离线熔断打开不投递，关闭后从原水位补拉', async () => {
  const f = fixture();
  f.offlineCircuitOpen.mockResolvedValue(true);
  await scheduleOrderSync(f.scheduler);
  expect(f.offlineCircuitOpen).toHaveBeenCalledWith('pdd');
  expect(f.send).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  f.offlineCircuitOpen.mockResolvedValue(false);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([window]);
});

it('[AC-B1-08g#6] 授权不可用暂停，恢复后仍从持久水位补拉', async () => {
  const f = fixture();
  f.read.mockResolvedValue(END);
  f.siteAuthAvailable.mockResolvedValue(false);
  await scheduleOrderSync(f.scheduler);
  expect(f.siteAuthAvailable).toHaveBeenCalledWith(
    expect.objectContaining({
      app_id: account.app_id,
      platform: 'pdd',
      union_account_id: ACCOUNT,
    }),
  );
  expect(f.send).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  f.clock.advanceMs(86_400_000);
  f.siteAuthAvailable.mockResolvedValue(true);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls[0]?.[2]).toEqual({
    ...window,
    window_start: END,
    window_end: '2026-10-17T01:00:00.000Z',
  });
});

it('[AC-B1-08g#7] 同平台不同账号 / app 独立读水位，授权失效只暂停对应账号', async () => {
  const f = fixture();
  const otherId = '10000000-0000-4000-8000-000000000002';
  f.listEnabledAccounts.mockResolvedValue([
    account,
    { ...account, app_id: 'other-app', union_account_id: otherId },
  ]);
  f.siteAuthAvailable.mockImplementation(async (a) => a.union_account_id === otherId);
  f.read.mockImplementation(async (s) => (s.app_id === 'other-app' ? END : START));
  await scheduleOrderSync(f.scheduler);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledWith({
    ...stream,
    app_id: 'other-app',
    union_account_id: otherId,
  });
  expect(f.send.mock.calls[0]?.[2]).toEqual({
    ...window,
    app_id: 'other-app',
    union_account_id: otherId,
    window_start: END,
    window_end: '2026-10-17T01:00:00.000Z',
  });
  expect(f.send.mock.calls[0]?.[3].singletonKey).toBe(`pdd:${otherId}:increment:-:${END}`);
});

it('[AC-B1-08g#8] 队列返回 null 是去重，下一次调度仍从未推进的水位起算', async () => {
  const f = fixture();
  f.send.mockResolvedValue(null);
  await scheduleOrderSync(f.scheduler);
  f.clock.advanceMs(60_000);
  await scheduleOrderSync(f.scheduler);
  expect(f.send.mock.calls.map(([, , payload]) => payload)).toEqual([window, window]);
  expect(f.send.mock.calls.map(([, , , opt]) => opt.singletonKey)).toEqual([
    `pdd:${ACCOUNT}:increment:-:${START}`,
    `pdd:${ACCOUNT}:increment:-:${START}`,
  ]);
  expect(f.send.mock.calls.every(([, , , opt]) => opt.id === undefined)).toBe(true);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-08g#9] 无启用账号不投任务、不初始化任何水位', async () => {
  const f = fixture();
  f.listEnabledAccounts.mockResolvedValue([]);
  await scheduleOrderSync(f.scheduler);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
});
