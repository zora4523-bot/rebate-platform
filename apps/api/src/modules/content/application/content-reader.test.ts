import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { CONTENT_CACHE_TTL_MS } from '../domain/cache-policy.ts';
import { CachedContentReader, type ContentConfig, type ContentStore } from './content-reader.ts';

const START = '2031-05-06T07:08:09.000Z';

// In-memory store: records every read, can fail, and can hold reads until released.
function fakeStore() {
  const calls: string[] = [];
  const versions = new Map<string, ReadonlyMap<string, string | null>>();
  const configs = new Map<string, ContentConfig>();
  const control: { failure: Error | null; hold: Promise<void> | null } = {
    failure: null,
    hold: null,
  };
  const store: ContentStore = {
    async minSupportedVersionsByChannel(appId, platform) {
      calls.push(`versions ${appId} ${platform}`);
      if (control.hold !== null) await control.hold;
      if (control.failure !== null) throw control.failure;
      return new Map(versions.get(`${appId} ${platform}`) ?? []);
    },
    async configItem(appId, key) {
      calls.push(`config ${appId} ${key}`);
      if (control.hold !== null) await control.hold;
      if (control.failure !== null) throw control.failure;
      const found = configs.get(`${appId} ${key}`);
      return found === undefined ? null : structuredClone(found);
    },
  };
  return { store, calls, versions, configs, control };
}

it('[AC-F1-02b] h5 and admin are not judged: null without reading the store', async () => {
  const f = fakeStore();
  f.versions.set('app h5', new Map([['official', '7.0.0']]));
  f.versions.set('app admin', new Map([['official', '8.0.0']]));
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  expect(await reader.minSupportedVersion('app', 'h5', 'official')).toBeNull();
  expect(await reader.minSupportedVersion('app', 'admin', 'official')).toBeNull();
  expect(f.calls).toEqual([]);
});

it('[AC-F1-02b] one read per (app, platform) serves every channel, including absent ones', async () => {
  const f = fakeStore();
  f.versions.set(
    'app android',
    new Map([
      ['official', '2.0.0'],
      ['huawei', null],
    ]),
  );
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  expect(await reader.minSupportedVersion('app', 'android', 'official')).toBe('2.0.0');
  expect(await reader.minSupportedVersion('app', 'android', 'huawei')).toBeNull();
  expect(await reader.minSupportedVersion('app', 'android', 'xiaomi')).toBeNull();
  expect(await reader.minSupportedVersion('app', 'ios', 'official')).toBeNull();
  expect(f.calls).toEqual(['versions app android', 'versions app ios']);
});

it('[AC-F1-02b] cache keys of distinct (app, key) pairs never collide', async () => {
  // The fake joins app and key with a space, so ('a b', 'c') and ('a', 'b c') read the same
  // fake row; the reader must still keep them as separate cache entries.
  const f = fakeStore();
  f.configs.set('a b c', { value: 'first', version: 1 });
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  expect(await reader.configValue('a b', 'c')).toStrictEqual({ value: 'first', version: 1 });
  f.configs.set('a b c', { value: 'second', version: 2 });
  expect(await reader.configValue('a', 'b c')).toStrictEqual({ value: 'second', version: 2 });
  expect(await reader.configValue('a b', 'c')).toStrictEqual({ value: 'first', version: 1 });
  expect(f.calls).toEqual(['config a b c', 'config a b c']);
});

it('[AC-F1-02b] concurrent misses of one key share a single read', async () => {
  const f = fakeStore();
  f.configs.set('app shared', { value: { on: true }, version: 3 });
  const release = Promise.withResolvers<void>();
  f.control.hold = release.promise;
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  const first = reader.configValue('app', 'shared');
  const second = reader.configValue('app', 'shared');
  release.resolve();
  expect(await first).toStrictEqual({ value: { on: true }, version: 3 });
  expect(await second).toStrictEqual({ value: { on: true }, version: 3 });
  expect(f.calls).toEqual(['config app shared']);
});

it('[AC-F1-02b] a failed shared read rejects every waiter and the next call reads again', async () => {
  const f = fakeStore();
  f.versions.set('app ios', new Map([['appstore', '1.2.3']]));
  const release = Promise.withResolvers<void>();
  f.control.hold = release.promise;
  f.control.failure = new Error('database unavailable');
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  const first = reader.minSupportedVersion('app', 'ios', 'appstore');
  const second = reader.minSupportedVersion('app', 'ios', 'appstore');
  release.resolve();
  await expect(first).rejects.toThrow('database unavailable');
  await expect(second).rejects.toThrow('database unavailable');
  f.control.hold = null;
  f.control.failure = null;
  expect(await reader.minSupportedVersion('app', 'ios', 'appstore')).toBe('1.2.3');
  expect(f.calls).toHaveLength(2);
});

it('[AC-F1-02b] a store that throws synchronously still rejects and leaves nothing pending', async () => {
  const f = fakeStore();
  let calls = 0;
  const store: ContentStore = {
    ...f.store,
    configItem() {
      calls += 1;
      if (calls === 1) throw new Error('thrown before any promise');
      return Promise.resolve({ value: 'ok', version: 1 });
    },
  };
  const reader = new CachedContentReader(store, new FixedClock(START));
  await expect(reader.configValue('app', 'key')).rejects.toThrow('thrown before any promise');
  expect(await reader.configValue('app', 'key')).toStrictEqual({ value: 'ok', version: 1 });
  expect(calls).toBe(2);
});

it('[AC-F1-02b] the lifetime starts when the read starts, not when it returns', async () => {
  const f = fakeStore();
  f.configs.set('app slow', { value: 'v1', version: 1 });
  const clock = new FixedClock(START);
  const release = Promise.withResolvers<void>();
  f.control.hold = release.promise;
  const reader = new CachedContentReader(f.store, clock);
  const pending = reader.configValue('app', 'slow');
  clock.advanceMs(10_000);
  release.resolve();
  expect(await pending).toStrictEqual({ value: 'v1', version: 1 });
  f.control.hold = null;
  clock.advanceMs(CONTENT_CACHE_TTL_MS - 10_000 - 1);
  expect(await reader.configValue('app', 'slow')).toStrictEqual({ value: 'v1', version: 1 });
  expect(f.calls).toHaveLength(1);
  clock.advanceMs(1);
  expect(await reader.configValue('app', 'slow')).toStrictEqual({ value: 'v1', version: 1 });
  expect(f.calls).toHaveLength(2);
});

it('[AC-F1-02b] a clock stepped back before the load expires the entry instead of keeping it', async () => {
  const f = fakeStore();
  f.configs.set('app stepped', { value: 'old', version: 1 });
  const clock = new FixedClock(START);
  const reader = new CachedContentReader(f.store, clock);
  expect(await reader.configValue('app', 'stepped')).toStrictEqual({ value: 'old', version: 1 });
  f.configs.set('app stepped', { value: 'new', version: 2 });
  clock.advanceMs(-1);
  expect(await reader.configValue('app', 'stepped')).toStrictEqual({ value: 'new', version: 2 });
  expect(f.calls).toHaveLength(2);
});

it('[AC-F1-02b] callers get their own copy: mutating a result does not change later reads', async () => {
  const f = fakeStore();
  f.configs.set('app domains', { value: { hosts: ['a.example.test'] }, version: 4 });
  const reader = new CachedContentReader(f.store, new FixedClock(START));
  const first = await reader.configValue('app', 'domains');
  expect(first).not.toBeNull();
  (first?.value as { hosts: string[] }).hosts.push('injected.example.test');
  expect(await reader.configValue('app', 'domains')).toStrictEqual({
    value: { hosts: ['a.example.test'] },
    version: 4,
  });
  expect(f.calls).toHaveLength(1);
});
