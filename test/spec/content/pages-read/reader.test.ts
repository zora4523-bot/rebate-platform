// F1-09d §9.2 R3/R8/R11: observable store calls and injected-clock boundaries.
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  PageReader,
  type PageStore,
} from '../../../../apps/api/src/modules/content/application/page-reader.ts';

const viewer = { loggedIn: false, platform: 'ios', appVersion: '2.0.0' };
function fixture() {
  const clock = new FixedClock('2026-10-17T00:00:00.000Z');
  const pointer = vi
    .fn<PageStore['pointer']>()
    .mockResolvedValue({ currentVersion: 1, grayVersion: 2, grayPercent: 99 });
  const version = vi.fn<PageStore['version']>().mockImplementation(async (_app, _key, number) => ({
    status: 'published',
    sections: [{ id: `version-${number}` }],
  }));
  return { clock, pointer, version, reader: new PageReader({ pointer, version }, clock) };
}

it('[AC-F1-09d#16] 空设备字符串等同缺省设备，仍取全量版', async () => {
  const f = fixture();
  expect(await f.reader.read('pages_test', 'home', '', viewer)).toEqual({
    page_key: 'home',
    version: 1,
    ttl_sec: 300,
    sections: [{ id: 'version-1' }],
  });
  expect(f.version).toHaveBeenCalledWith('pages_test', 'home', 1);
});

it('[AC-F1-09d#17] 指针与版本内容都缓存 60000ms，命中不延长有效期', async () => {
  const f = fixture();
  expect((await f.reader.read('pages_test', 'home', null, viewer))?.sections).toEqual([
    { id: 'version-1' },
  ]);
  f.version.mockResolvedValue({ status: 'published', sections: [{ id: 'refreshed' }] });
  f.clock.advanceMs(59_999);
  expect((await f.reader.read('pages_test', 'home', null, viewer))?.sections).toEqual([
    { id: 'version-1' },
  ]);
  expect(f.pointer).toHaveBeenCalledTimes(1);
  expect(f.version).toHaveBeenCalledTimes(1);
  f.clock.advanceMs(1);
  expect((await f.reader.read('pages_test', 'home', null, viewer))?.sections).toEqual([
    { id: 'refreshed' },
  ]);
  expect(f.pointer).toHaveBeenCalledTimes(2);
  expect(f.version).toHaveBeenCalledTimes(2);
});

it('[AC-F1-09d#18] 缓存保存原 sections，每次同时按版本门槛和登录态重新筛选', async () => {
  const f = fixture();
  const section = { id: 'member', condition: { login: 'yes' }, min_app_version: { ios: '2.0.0' } };
  f.version.mockResolvedValue({ status: 'published', sections: [section] });
  for (const [loggedIn, appVersion, expected] of [
    [true, '2.0.0', [section]],
    [false, '2.0.0', []],
    [true, '1.9.9', []],
    [true, '2.0.0', [section]],
  ] as const) {
    expect(
      (await f.reader.read('pages_test', 'home', null, { ...viewer, loggedIn, appVersion }))
        ?.sections,
    ).toEqual(expected);
  }
  expect(f.version).toHaveBeenCalledTimes(1);
});

it('[AC-F1-09d#19] 指针存在但版本存储无该行时不可下发', async () => {
  const f = fixture();
  f.version.mockResolvedValue(null);
  expect(await f.reader.read('pages_test', 'home', null, viewer)).toBeNull();
  expect(f.version).toHaveBeenCalledWith('pages_test', 'home', 1);
});
