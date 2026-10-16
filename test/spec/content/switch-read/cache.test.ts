// F1-10b: config reads of registered switch keys are cached for at most 5 s (规划/04 §10.2「10 秒
// 内生效」), every other key keeps the 60 s cache frozen by test/spec/content/read/**. A fake
// store and a FixedClock stand in for PostgreSQL and time; readings in ./kit.ts.
import { expect, it } from 'vitest';
import { CachedContentReader } from '../../../../apps/api/src/modules/content/application/content-reader.ts';
import { switchCacheTtlMs } from '../../../../apps/api/src/modules/content/domain/cache-policy.ts';
import { switchSpecOf } from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  CONFIG_CACHE_MS,
  EXPECTED,
  FakeStore,
  NOT_SWITCHES,
  START,
  SWITCH_CACHE_MAX_MS,
  SWITCH_EFFECTIVE_MS,
  type Json,
} from './kit.ts';

const APP = 'switch_read';

function setup(): { store: FakeStore; clock: FixedClock; reader: CachedContentReader } {
  const store = new FakeStore();
  const clock = new FixedClock(START);
  return { store, clock, reader: new CachedContentReader(store, clock) };
}

it('[AC-F1-10b#15] §9.2 (3)：开关缓存时长是 (0, 5000] 毫秒内的整数', () => {
  const ttl = switchCacheTtlMs();
  expect(Number.isInteger(ttl)).toBe(true);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(SWITCH_CACHE_MAX_MS);
});

it.each(EXPECTED.map((row) => [row.sample] as const))(
  '[AC-F1-10b#16] §9.2 (3) 开关键 %s：时长内命中缓存，到期（age = 时长，≤ 5 秒）必重读 store 并换入新值与版本',
  async (key) => {
    const ttl = switchCacheTtlMs();
    const { store, clock, reader } = setup();
    store.set(APP, key, true, 3);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 3 });
    expect(store.readsOf(APP, key)).toBe(1);
    store.set(APP, key, false, 4);
    clock.advanceMs(ttl - 1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 3 });
    expect(store.readsOf(APP, key)).toBe(1);
    clock.advanceMs(1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: false, version: 4 });
    expect(store.readsOf(APP, key)).toBe(2);
  },
);

it.each(EXPECTED.map((row) => [row.sample] as const))(
  '[AC-F1-10b#17] §9.2 (3) 5 秒边界：开关键 %s 载入后恰 5000 毫秒再读一定重读 store',
  async (key) => {
    const { store, clock, reader } = setup();
    store.set(APP, key, { round: 1 }, 1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: { round: 1 }, version: 1 });
    store.set(APP, key, { round: 2 }, 2);
    clock.advanceMs(SWITCH_CACHE_MAX_MS);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: { round: 2 }, version: 2 });
    expect(store.readsOf(APP, key)).toBe(2);
    expect(switchCacheTtlMs()).toBeLessThanOrEqual(SWITCH_CACHE_MAX_MS);
  },
);

it.each([0, 1, 999, 2_500, 4_999, 5_000, 5_001, 7_777])(
  '[AC-F1-10b#18] 04 §10.2「10 秒内生效」、命中不续期：每毫秒都在读，载入后第 %i 毫秒改值，改值后 5 秒内（必在 10 秒内）读到新值且不再回到旧值',
  async (changeAt) => {
    const key = 'withdraw.enabled';
    const { store, clock, reader } = setup();
    store.set(APP, key, true, 10);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 10 });
    let seenAt: number | null = null;
    if (changeAt === 0) store.set(APP, key, false, 11);
    for (let elapsed = 1; elapsed <= changeAt + SWITCH_CACHE_MAX_MS; elapsed += 1) {
      clock.advanceMs(1);
      if (elapsed === changeAt) store.set(APP, key, false, 11);
      const read = await reader.configValue(APP, key);
      if (elapsed >= changeAt && read?.version === 11) seenAt ??= elapsed;
      if (seenAt !== null) expect(read).toStrictEqual({ value: false, version: 11 });
    }
    expect(seenAt).not.toBeNull();
    expect((seenAt ?? Infinity) - changeAt).toBeLessThanOrEqual(SWITCH_CACHE_MAX_MS);
    expect((seenAt ?? Infinity) - changeAt).toBeLessThan(SWITCH_EFFECTIVE_MS);
    // Hits must not have stretched the cache to the 60 s config lifetime.
    expect(store.readsOf(APP, key)).toBeGreaterThan(1);
  },
);

it('[AC-F1-10b#19] BR-INV-21 例：20:00 关闭 growth.invite_bind.enabled，此前刚读过开着的值，20:00:10 前读到 off；重新打开同样 10 秒内生效', async () => {
  const key = 'growth.invite_bind.enabled';
  const store = new FakeStore();
  const clock = new FixedClock('2031-10-10T19:59:59.999+08:00');
  const reader = new CachedContentReader(store, clock);
  store.set(APP, key, true, 1);
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 1 });
  clock.set('2031-10-10T20:00:00.000+08:00');
  store.set(APP, key, false, 2);
  clock.set('2031-10-10T20:00:05.000+08:00');
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: false, version: 2 });
  clock.set('2031-10-11T09:00:00.000+08:00');
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: false, version: 2 });
  store.set(APP, key, true, 3);
  clock.set('2031-10-11T09:00:05.000+08:00');
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 3 });
  expect(switchSpecOf(key)?.defaultValue).toBe(true);
});

it('[AC-F1-10b#20] §9.2 (3)：开关键先前不存在（缓存 null）新增后、存在后被移走，都在 5 秒内反映', async () => {
  const key = 'convert.enabled.taobao';
  const { store, clock, reader } = setup();
  expect(await reader.configValue(APP, key)).toBeNull();
  store.set(APP, key, true, 1);
  clock.advanceMs(SWITCH_CACHE_MAX_MS);
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 1 });
  store.remove(APP, key);
  clock.advanceMs(SWITCH_CACHE_MAX_MS);
  expect(await reader.configValue(APP, key)).toBeNull();
  expect(store.readsOf(APP, key)).toBe(3);
  expect(switchSpecOf(key)).not.toBeNull();
});

it.each(NOT_SWITCHES.filter(([key]) => key.trim() !== '' && !key.includes('\n')))(
  '[AC-F1-10b#21] §9.2 (3)、F1-02b 冻结口径：非开关键 %j 仍按 60 秒缓存，5 秒、59.999 秒命中，60 秒重读',
  async (key) => {
    expect(switchSpecOf(key)).toBeNull();
    const { store, clock, reader } = setup();
    store.set(APP, key, 'old', 1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: 'old', version: 1 });
    store.set(APP, key, 'new', 2);
    clock.advanceMs(SWITCH_CACHE_MAX_MS);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: 'old', version: 1 });
    clock.advanceMs(CONFIG_CACHE_MS - SWITCH_CACHE_MAX_MS - 1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: 'old', version: 1 });
    expect(store.readsOf(APP, key)).toBe(1);
    clock.advanceMs(1);
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: 'new', version: 2 });
    expect(store.readsOf(APP, key)).toBe(2);
  },
);

it('[AC-F1-10b#22] §9.2 (3)：同一读取器里开关键的重读不带动非开关键，不同应用的同一开关互不串用', async () => {
  const { store, clock, reader } = setup();
  const values: [string, string, Json, Json][] = [
    ['app_a', 'payout.enabled', true, false],
    ['app_b', 'payout.enabled', false, true],
    ['app_a', 'agent.page_guide.routes', ['old'], ['new']],
  ];
  for (const [appId, key, before] of values) store.set(appId, key, before, 1);
  for (const [appId, key, before] of values) {
    expect(await reader.configValue(appId, key)).toStrictEqual({ value: before, version: 1 });
  }
  for (const [appId, key, , after] of values) store.set(appId, key, after, 2);
  clock.advanceMs(SWITCH_CACHE_MAX_MS);
  expect(await reader.configValue('app_a', 'payout.enabled')).toStrictEqual({
    value: false,
    version: 2,
  });
  expect(await reader.configValue('app_b', 'payout.enabled')).toStrictEqual({
    value: true,
    version: 2,
  });
  expect(await reader.configValue('app_a', 'agent.page_guide.routes')).toStrictEqual({
    value: ['old'],
    version: 1,
  });
  expect(store.readsOf('app_a', 'agent.page_guide.routes')).toBe(1);
  expect(switchSpecOf('agent.page_guide.routes')).toBeNull();
});

it('[AC-F1-10b#23] F1-02b 失败口径对开关同样成立：到期重读失败时报错、不返回旧值，恢复后立即读到新值', async () => {
  const key = 'pay.enabled';
  const { store, clock, reader } = setup();
  store.set(APP, key, true, 5);
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: true, version: 5 });
  store.set(APP, key, false, 6);
  clock.advanceMs(switchCacheTtlMs());
  store.failure = new Error('database unavailable for this read');
  await expect(reader.configValue(APP, key)).rejects.toBeInstanceOf(Error);
  await expect(reader.configValue(APP, key)).rejects.toBeInstanceOf(Error);
  store.failure = null;
  expect(await reader.configValue(APP, key)).toStrictEqual({ value: false, version: 6 });
});

it('[AC-F1-10b#24] §9.2 (3) 时钟只用注入的 Clock：时钟不动时开关键反复读只查一次 store', async () => {
  const key = 'payout.queue_paused';
  const { store, reader } = setup();
  store.set(APP, key, false, 1);
  for (let index = 0; index < 50; index += 1) {
    expect(await reader.configValue(APP, key)).toStrictEqual({ value: false, version: 1 });
  }
  expect(store.readsOf(APP, key)).toBe(1);
  expect(switchSpecOf(key)?.systemWritten).toBe(true);
});
