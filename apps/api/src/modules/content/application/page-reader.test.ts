import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { h5Bucket } from '../domain/client-config.ts';
import { PAGE_TTL_SEC, PageReader, type PageStore, type PageVersion } from './page-reader.ts';

const START = '2031-05-06T07:08:09.000Z';
const guest = { loggedIn: false, platform: 'h5', appVersion: undefined };

function deviceIn(appId: string, inGray: boolean, percent: number): string {
  for (let i = 0; ; i += 1) {
    const device = `device-${i}`;
    if (h5Bucket(appId, device) < percent * 100 === inGray) return device;
  }
}

function fixture(
  pointers: Record<string, Awaited<ReturnType<PageStore['pointer']>>>,
  versions: Record<string, PageVersion | null>,
) {
  const pointer = vi.fn<PageStore['pointer']>(
    async (appId, key) => pointers[`${appId}|${key}`] ?? null,
  );
  const version = vi.fn<PageStore['version']>(
    async (appId, key, number) => versions[`${appId}|${key}|${number}`] ?? null,
  );
  const clock = new FixedClock(START);
  return { pointer, version, clock, reader: new PageReader({ pointer, version }, clock) };
}

const published = (id: string): PageVersion => ({ status: 'published', sections: [{ id }] });

it('[AC-F1-09d#u1] 无指针、指针为空或选中版本非 published 时返回 null', async () => {
  const f = fixture(
    {
      'a|home': { currentVersion: null, grayVersion: null, grayPercent: 0 },
      'a|custom:x': { currentVersion: 1, grayVersion: null, grayPercent: 0 },
    },
    { 'a|custom:x|1': { status: 'rolled_back', sections: [{ id: 'x' }] } },
  );
  expect(await f.reader.read('a', 'missing', null, guest)).toBeNull();
  expect(await f.reader.read('a', 'home', null, guest)).toBeNull();
  expect(await f.reader.read('a', 'custom:x', null, guest)).toBeNull();
  expect(f.version).toHaveBeenCalledTimes(1);
});

it('[AC-F1-09d#u2] 设备桶低于 gray_percent×100 取灰度版，其余与无设备取全量版', async () => {
  const f = fixture(
    { 'a|home': { currentVersion: 1, grayVersion: 2, grayPercent: 37 } },
    { 'a|home|1': published('full'), 'a|home|2': published('gray') },
  );
  const inGray = deviceIn('a', true, 37);
  const outGray = deviceIn('a', false, 37);
  expect(await f.reader.read('a', 'home', inGray, guest)).toEqual({
    page_key: 'home',
    version: 2,
    ttl_sec: PAGE_TTL_SEC,
    sections: [{ id: 'gray' }],
  });
  expect((await f.reader.read('a', 'home', outGray, guest))?.version).toBe(1);
  expect((await f.reader.read('a', 'home', null, guest))?.version).toBe(1);
  expect(PAGE_TTL_SEC).toBe(300);
});

it('[AC-F1-09d#u3] 缓存按 app_id 与 page_key 隔离', async () => {
  const f = fixture(
    {
      'a|home': { currentVersion: 1, grayVersion: null, grayPercent: 0 },
      'b|home': { currentVersion: 1, grayVersion: null, grayPercent: 0 },
      'a|custom:x': { currentVersion: 1, grayVersion: null, grayPercent: 0 },
    },
    {
      'a|home|1': published('a-home'),
      'b|home|1': published('b-home'),
      'a|custom:x|1': published('a-x'),
    },
  );
  expect((await f.reader.read('a', 'home', null, guest))?.sections).toEqual([{ id: 'a-home' }]);
  expect((await f.reader.read('b', 'home', null, guest))?.sections).toEqual([{ id: 'b-home' }]);
  expect((await f.reader.read('a', 'custom:x', null, guest))?.sections).toEqual([{ id: 'a-x' }]);
  expect(await f.reader.read('b', 'custom:x', null, guest)).toBeNull();
});

it('[AC-F1-09d#u4] 过滤后为空仍返回页面，sections 为空数组', async () => {
  const f = fixture(
    { 'a|home': { currentVersion: 3, grayVersion: null, grayPercent: 0 } },
    { 'a|home|3': { status: 'published', sections: [{ condition: { has_order: 'yes' } }] } },
  );
  expect(await f.reader.read('a', 'home', null, { ...guest, loggedIn: true })).toEqual({
    page_key: 'home',
    version: 3,
    ttl_sec: 300,
    sections: [],
  });
});

it('[AC-F1-09d#u5] 没有库句柄时每次拒绝', async () => {
  const reader = new PageReader(null, new FixedClock(START));
  await expect(reader.read('a', 'home', null, guest)).rejects.toThrow(/database/);
  await expect(reader.read('a', 'home', null, guest)).rejects.toThrow(/database/);
});
