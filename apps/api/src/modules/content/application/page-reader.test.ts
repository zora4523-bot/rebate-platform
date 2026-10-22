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

it('[AC-F1-09g#u8] 游客事实全 false 不查；登录用户每请求查一次、只在有条件时查', async () => {
  const pointer = vi.fn<PageStore['pointer']>(async () => ({
    currentVersion: 1,
    grayVersion: null,
    grayPercent: 0,
  }));
  const sections = [
    { id: 'p' },
    { id: 'no', condition: { has_order: 'no' } },
    { id: 'yes', condition: { has_order: 'yes' } },
  ];
  const version = vi.fn<PageStore['version']>(async () => ({ status: 'published', sections }));
  let count = 0;
  const facts = vi.fn(async () => ({
    hasParent: null,
    unionAuthorized: null,
    hasOrder: count > 0,
  }));
  const reader = new PageReader({ pointer, version }, new FixedClock(START), { facts });
  const ids = async (user: string | null) =>
    (
      await reader.read('a', 'home', null, { ...guest, loggedIn: user !== null }, user)
    )?.sections.map((s) => s['id']);
  expect(await ids(null)).toEqual(['p', 'no']);
  expect(facts).not.toHaveBeenCalled();
  expect(await ids('u')).toEqual(['p', 'no']);
  count = 1;
  expect(await ids('u')).toEqual(['p', 'yes']);
  expect(facts).toHaveBeenCalledTimes(2);
  expect(facts).toHaveBeenLastCalledWith('a', 'u', new Set(['hasOrder']));
});

it('[AC-F1-09g#u9] 无人群条件的页面不查事实；无事实端口时登录用户只命中 any', async () => {
  const facts = vi.fn();
  const plain = fixture(
    { 'a|home': { currentVersion: 1, grayVersion: null, grayPercent: 0 } },
    { 'a|home|1': published('x') },
  );
  const reader = new PageReader({ pointer: plain.pointer, version: plain.version }, plain.clock, {
    facts,
  });
  expect(
    (await reader.read('a', 'home', null, { ...guest, loggedIn: true }, 'u'))?.sections,
  ).toEqual([{ id: 'x' }]);
  expect(facts).not.toHaveBeenCalled();
  const f = fixture(
    { 'a|home': { currentVersion: 1, grayVersion: null, grayPercent: 0 } },
    {
      'a|home|1': {
        status: 'published',
        sections: [
          { id: 'any', condition: { has_order: 'any' } },
          { condition: { has_order: 'no' } },
        ],
      },
    },
  );
  expect(
    (await f.reader.read('a', 'home', null, { ...guest, loggedIn: true }, 'u'))?.sections,
  ).toEqual([{ id: 'any', condition: { has_order: 'any' } }]);
});

it('[AC-F1-09p#u8] 物化前缓存的草稿在指针切换后重读：指针过期后仍返回 V2，不报 30701', async () => {
  const at = new Date(Date.parse(START) + 30_000);
  const row: Awaited<ReturnType<PageStore['pointer']>> = {
    currentVersion: 1,
    grayVersion: null,
    grayPercent: 0,
    scheduledVersion: 2,
    scheduledGrayPercent: 100,
    scheduledAt: at,
    scheduledByAdminId: 'planner',
  };
  const versions: Record<string, PageVersion | null> = {
    'a|home|1': published('v1'),
    'a|home|2': { status: 'draft', sections: [{ id: 'v2' }] },
  };
  const f = fixture({ 'a|home': row }, versions);
  // t=0: the pointer row with the pending slot is cached.
  expect((await f.reader.read('a', 'home', null, guest))?.version).toBe(1);
  // t=30: due, the job has not run: V2 is read (and cached) as a draft and served by time.
  f.clock.set(at);
  expect((await f.reader.read('a', 'home', null, guest))?.version).toBe(2);
  // t=31: the job publishes V2 and clears the slot in the database.
  f.pointer.mockResolvedValue({ currentVersion: 2, grayVersion: null, grayPercent: 0 });
  versions['a|home|2'] = published('v2');
  // t=60: the pointer entry expired and is reloaded (no slot); the draft entry is still fresh.
  f.clock.set(new Date(Date.parse(START) + 60_000));
  expect(await f.reader.read('a', 'home', null, guest)).toMatchObject({
    version: 2,
    sections: [{ id: 'v2' }],
  });
  expect(f.pointer).toHaveBeenCalledTimes(2);
  expect(f.version.mock.calls.filter(([, , n]) => n === 2)).toHaveLength(2);
});

it('[AC-F1-09p#u9] 指针指向真草稿时重读一次后仍不出', async () => {
  const f = fixture(
    { 'a|home': { currentVersion: 3, grayVersion: null, grayPercent: 0 } },
    { 'a|home|3': { status: 'draft', sections: [{ id: 'x' }] } },
  );
  expect(await f.reader.read('a', 'home', null, guest)).toBeNull();
  expect(f.version).toHaveBeenCalledTimes(2);
});
