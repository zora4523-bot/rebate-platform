import { expect, it } from 'vitest';
import {
  APP,
  BASIS,
  COUPON,
  CUSTOM,
  DEFAULTS,
  KEYS,
  UNKNOWN,
  effective,
  failingConfig,
  fakeLogger,
  readFailedEvent,
  settings,
  settle,
  syntheticError,
} from './kit.ts';

it('[AC-B1-22w-REREAD#1] 读成功 → 读失败 → 读成功：失败那次用 08 默认（不沿用上次的值），恢复后即用配置值', async () => {
  const config = failingConfig();
  config.setAll(CUSTOM);
  const { logger, warns } = fakeLogger();
  const reader = settings(config, logger);
  expect(effective(await reader.read(APP))).toEqual(CUSTOM);
  expect(warns).toEqual([]);
  config.fail(UNKNOWN, syntheticError('SyntheticStoreError'));
  config.fail(COUPON, syntheticError('SyntheticDeadlineError'), 'throw');
  const failed = await settle(reader.read(APP), 'read()');
  expect(effective(failed)).toEqual({
    ...CUSTOM,
    [UNKNOWN]: DEFAULTS[UNKNOWN],
    [COUPON]: DEFAULTS[COUPON],
  });
  expect(warns).toHaveLength(2);
  config.healAll();
  const start = config.calls.length;
  const healed = await settle(reader.read(APP), 'read()');
  expect(effective(healed)).toEqual(CUSTOM);
  expect(new Set(config.calls.slice(start).map((call) => call.key))).toEqual(new Set(KEYS));
  // A successful read warns nothing more.
  expect(warns).toHaveLength(2);
});

it('[AC-B1-22w-REREAD#2] 不缓存失败：持续失败时每次 read 都重新读五个键并各告警一次', async () => {
  const config = failingConfig();
  config.fail(BASIS, syntheticError('SyntheticDeadlineError'));
  const { logger, warns } = fakeLogger();
  const reader = settings(config, logger);
  for (let round = 1; round <= 3; round++) {
    const start = config.calls.length;
    const options = await settle(reader.read(APP), 'read()');
    expect(effective(options)).toEqual(DEFAULTS);
    const calls = config.calls.slice(start);
    expect(new Set(calls.map((call) => call.key))).toEqual(new Set(KEYS));
    expect(calls.every((call) => call.appId === APP)).toBe(true);
    expect(warns).toHaveLength(round);
    readFailedEvent(warns[round - 1], BASIS, 'SyntheticDeadlineError');
  }
});

it('[AC-B1-22w-REREAD#3] 失败期间改了配置：恢复后的下一次 read 用改后的新值', async () => {
  const config = failingConfig();
  config.set(BASIS, 'promotion_path');
  config.set(UNKNOWN, 'unavailable');
  const { logger, warns } = fakeLogger();
  const reader = settings(config, logger);
  config.failAll(syntheticError('SyntheticStoreError'), 'throw');
  expect(effective(await settle(reader.read(APP), 'read()'))).toEqual(DEFAULTS);
  expect(warns).toHaveLength(KEYS.length);
  config.set(BASIS, 'coupon_only');
  config.set(UNKNOWN, 'add_back');
  config.heal(BASIS);
  const partly = await settle(reader.read(APP), 'read()');
  expect(effective(partly)).toEqual({ ...DEFAULTS, [BASIS]: 'coupon_only' });
  expect(warns).toHaveLength(KEYS.length + KEYS.length - 1);
  config.healAll();
  const healed = await settle(reader.read(APP), 'read()');
  expect(effective(healed)).toEqual({ ...DEFAULTS, [BASIS]: 'coupon_only', [UNKNOWN]: 'add_back' });
  expect(warns).toHaveLength(KEYS.length + KEYS.length - 1);
});
