// B1-04zr (D10-543): the rescan goes live in production. Every port here comes off the real
// assembly (kit.ts productionPorts), rescanConfig included; no test passes one of its own.
import { afterEach, expect, it, vi } from 'vitest';
import type {
  OrderRescanWindow,
  OrderSyncWindow,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import {
  ACCOUNT,
  HOUR_MS,
  JD_DAYS,
  JD_ENABLED,
  MINUTE_MS,
  NOW,
  PDD_ACCOUNT,
  PDD_ENABLED,
  roundStart,
} from '../rescan/kit.ts';
import { productionPorts, storedDb, withCredentials, workerOf } from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const spanOf = (win: { window_start: string; window_end: string }): number =>
  Date.parse(win.window_end) - Date.parse(win.window_start);

it('[AC-B1-04zr#8] 生产 orderSyncPorts 注入 rescanConfig：造端口不查库，读键才查 config_items，存的值原样返回', async () => {
  const ports = await productionPorts();
  expect(typeof ports.rescanConfig).toBe('function');
  const { db, queries } = storedDb({ [JD_ENABLED]: false, [JD_DAYS]: 45 });
  const config = ports.rescanConfig!(db, new FixedClock(NOW));
  expect(queries).toEqual([]);
  expect(await config.get(JD_ENABLED)).toBe(false);
  expect(await config.get(JD_DAYS)).toBe(45);
  expect((await config.get(PDD_ENABLED)) ?? null).toBeNull();
  expect(queries.some((query) => query.includes('config_items'))).toBe(true);
});

it('[AC-B1-04zr#9] 带 snapshots 的生产装配：start() 后 jd 第 120 秒发一个 60 分钟回扫窗并过 jdOrderWindow，pdd 默认关，停止后不留定时器', async () => {
  const ports = await productionPorts();
  expect(typeof ports.rescanConfig).toBe('function');
  vi.useFakeTimers();
  const { db } = storedDb();
  const w = workerOf(ports, db);
  withCredentials(w.runtime);
  const running = w.runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(w.sent('rescan.window')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const rescans = w.sent('rescan.window') as OrderRescanWindow[];
    expect(rescans).toHaveLength(1);
    expect(rescans[0]).toMatchObject({
      platform: 'jd',
      union_account_id: ACCOUNT,
      query_kind: 'rescan',
      window_start: roundStart(30),
    });
    expect(spanOf(rescans[0]!)).toBe(HOUR_MS);
    const range = { from: rescans[0]!.window_start, to: rescans[0]!.window_end };
    expect(() => jdOrderWindow(range, w.clock.now())).not.toThrow();
    // The increment of the same worker: jd's own 60-minute window, next to pdd's 30.
    const increments = w.sent('window') as OrderSyncWindow[];
    const jd = increments.filter((win) => win.platform === 'jd');
    expect(jd.length).toBeGreaterThan(0);
    expect(jd.every((win) => spanOf(win) === HOUR_MS)).toBe(true);
  } finally {
    await running.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
  const sent = w.sent('rescan.window').length;
  await vi.advanceTimersByTimeAsync(240_000);
  expect(w.sent('rescan.window')).toHaveLength(sent);
});

it('[AC-B1-04zr#10] 开关经生产端口读 config_items 生效：jd 关不发，pdd 开发 30 分钟窗', async () => {
  const ports = await productionPorts();
  expect(typeof ports.rescanConfig).toBe('function');
  vi.useFakeTimers();
  const { db } = storedDb({ [JD_ENABLED]: false, [PDD_ENABLED]: true });
  const w = workerOf(ports, db);
  withCredentials(w.runtime);
  const running = w.runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    const rescans = w.sent('rescan.window') as OrderRescanWindow[];
    expect(rescans.length).toBeGreaterThan(0);
    expect(rescans.every((win) => win.platform === 'pdd')).toBe(true);
    expect(rescans[0]).toMatchObject({
      union_account_id: PDD_ACCOUNT,
      window_start: roundStart(90),
    });
    expect(spanOf(rescans[0]!)).toBe(30 * MINUTE_MS);
  } finally {
    await running.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B1-04zr#11] jd 没配凭据（queryableAccount 为空）：能启动，增量与回扫都不发窗、只记跳过，不报错', async () => {
  const ports = await productionPorts();
  vi.useFakeTimers();
  const { db } = storedDb();
  const w = workerOf(ports, db);
  expect(() => w.runtime.statusMaps('jd')).not.toThrow();
  const running = w.runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(w.sent('window')).toEqual([]);
    expect(w.sent('rescan.window')).toEqual([]);
    const skipped = { platform: 'jd', reason: 'no_queryable_account' };
    expect(w.lines()).toContainEqual(
      expect.objectContaining({ msg: 'order_sync_account_skipped', ...skipped }),
    );
    expect(w.lines()).toContainEqual(
      expect.objectContaining({ msg: 'order_sync_rescan_account_skipped', ...skipped }),
    );
    expect(w.lines().filter((line) => line.level >= 50)).toEqual([]);
  } finally {
    await running.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});
