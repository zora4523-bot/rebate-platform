import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  PageReader,
  type PageStore,
} from '../../../../apps/api/src/modules/content/application/page-reader.ts';

const viewer = { loggedIn: false, platform: 'ios', appVersion: '2.0.0' };

function fixture(percent = 100) {
  const appId = `f1_09p_${randomUUID()}`;
  const clock = new FixedClock('2026-10-22T00:00:00.000Z');
  const at = new Date(clock.now().getTime() + 10_000);
  // 用结构子类型保留旧 PagePointer 兼容性；冻结 pages-read 的三字段假仓储不必改。
  const row = {
    currentVersion: 1,
    grayVersion: null,
    grayPercent: 0,
    scheduledVersion: 2,
    scheduledGrayPercent: percent,
    scheduledAt: at,
    scheduledByAdminId: randomUUID(),
  };
  const pointer = vi.fn<PageStore['pointer']>().mockResolvedValue(row);
  const version = vi.fn<PageStore['version']>().mockImplementation(async (_app, _key, number) => ({
    status: number === 2 ? 'draft' : 'published',
    sections: [{ id: `version-${number}` }],
  }));
  return {
    appId,
    clock,
    at,
    row,
    pointer,
    version,
    reader: new PageReader({ pointer, version }, clock),
  };
}

it('[AC-F1-09p#22] 缓存原指针：到点前 1ms 旧版，恰等号新版；不等 60 秒也不等任务', async () => {
  const f = fixture();
  const original = structuredClone(f.row);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  f.clock.set(new Date(f.at.getTime() - 1));
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  f.clock.advanceMs(1);
  expect(await f.reader.read(f.appId, 'home', null, viewer)).toMatchObject({
    version: 2,
    sections: [{ id: 'version-2' }],
  });
  expect(f.pointer).toHaveBeenCalledTimes(1);
  expect(f.row).toEqual(original);
});

it('[AC-F1-09p#23] 定时灰度 10%：设备桶内新版，桶外及无设备旧版，同一缓存按请求选择', async () => {
  const f = fixture(10);
  // 独立计算桶，不调用被测 pickPageVersion / h5Bucket 作为期望值。
  const devices = Array.from({ length: 1_000 }, (_, i) => `device-${i}`);
  const bucket = (device: string) =>
    Number(
      createHash('sha256').update(`${f.appId}:${device}`).digest().readBigUInt64BE(0) % 10_000n,
    );
  const inside = devices.find((device) => bucket(device) < 1_000);
  const outside = devices.find((device) => bucket(device) >= 1_000);
  expect(inside).toBeDefined();
  expect(outside).toBeDefined();
  expect((await f.reader.read(f.appId, 'home', inside!, viewer))?.version).toBe(1);
  f.clock.set(f.at);
  for (const [device, expected] of [
    [inside!, 2],
    [outside!, 1],
    [null, 1],
    ['', 1],
    [inside!, 2],
  ] as const) {
    expect((await f.reader.read(f.appId, 'home', device, viewer))?.version).toBe(expected);
  }
  expect(f.pointer).toHaveBeenCalledTimes(1);
});

it('[AC-F1-09p#24] 只有到点槽位指向的草稿可出；其他草稿与已回滚版本仍不可出', async () => {
  const f = fixture();
  f.version.mockImplementation(async () => ({ status: 'draft', sections: [] }));
  expect(await f.reader.read(f.appId, 'home', null, viewer)).toBeNull();
  f.clock.set(f.at);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(2);
  f.clock.advanceMs(60_000);
  f.version.mockResolvedValue({ status: 'rolled_back', sections: [] });
  expect(await f.reader.read(f.appId, 'home', null, viewer)).toBeNull();
});

it('[AC-F1-09p#25] 到点草稿缓存不污染其他页面，同 app 的另一页面不能借槽位放行草稿', async () => {
  const f = fixture();
  f.pointer.mockImplementation(async (_app, key) =>
    key === 'home'
      ? f.row
      : {
          currentVersion: 2,
          grayVersion: null,
          grayPercent: 0,
        },
  );
  f.clock.set(f.at);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(2);
  expect(await f.reader.read(f.appId, 'custom:other', null, viewer)).toBeNull();
});

it('[AC-F1-09p#26] 撤销后读侧最迟在原行缓存 60 秒到期时回旧版，不永久保留有效结果', async () => {
  const f = fixture();
  await f.reader.read(f.appId, 'home', null, viewer);
  // 库中撤销，已缓存的旧行在 ttl 内仍可能展示定时版（P12）。
  f.pointer.mockResolvedValue({ currentVersion: 1, grayVersion: null, grayPercent: 0 });
  f.clock.set(f.at);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(2);
  f.clock.advanceMs(50_000);
  expect((await f.reader.read(f.appId, 'home', null, viewer))?.version).toBe(1);
  expect(f.pointer).toHaveBeenCalledTimes(2);
});
