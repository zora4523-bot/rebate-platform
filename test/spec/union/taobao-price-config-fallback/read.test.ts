import { expect, it } from 'vitest';
import { mapTaobaoPrice } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  BASIS,
  COUPON,
  CREDENTIAL_MARKER,
  CUSTOM,
  DEFAULTS,
  DETAIL_MARKER,
  DISCOUNT,
  KEYS,
  MEMBER,
  OTHER_APP,
  UNKNOWN,
  effective,
  example,
  expectAnomaly,
  expectNoErrorDetail,
  expectPrice,
  failingConfig,
  fakeLogger,
  invalidValueEvent,
  keyWarnEvent,
  loggedText,
  now,
  readFailedEvent,
  settings,
  settle,
  syntheticError,
  warnNaming,
  withUnknown,
  type ErrorKind,
  type FailMode,
  type PriceKey,
} from './kit.ts';

const KINDS: readonly ErrorKind[] = ['SyntheticStoreError', 'SyntheticDeadlineError'];
const MODES: readonly FailMode[] = ['reject', 'throw'];
const cases: readonly (readonly [PriceKey, FailMode, ErrorKind])[] = KEYS.flatMap((key) =>
  MODES.flatMap((mode) => KINDS.map((kind) => [key, mode, kind] as const)),
);

it.each(cases)(
  '[AC-B1-22w-READ#1] %s 读取抛错（%s，%s）：read 正常返回，该键用 08 默认，其他四键照常用配置值，告警一条',
  async (key, mode, kind) => {
    const config = failingConfig();
    config.setAll(CUSTOM);
    config.fail(key, syntheticError(kind), mode);
    const { logger, warns } = fakeLogger();
    const options = await settle(settings(config, logger).read(APP), 'read()');
    expect(effective(options)).toEqual({ ...CUSTOM, [key]: DEFAULTS[key] });
    // The other four keys are still read (one failed key never stops the others).
    expect(new Set(config.calls.map((call) => call.key))).toEqual(new Set(KEYS));
    expect(config.calls.every((call) => call.appId === APP)).toBe(true);
    expect(warns).toHaveLength(1);
    readFailedEvent(warns[0], key, kind);
    expectNoErrorDetail(warns);
  },
);

it.each(MODES)(
  '[AC-B1-22w-READ#2] 五个键全部读取抛错（%s）：全部用 08 默认，各键告警一条，read 正常返回',
  async (mode) => {
    const config = failingConfig();
    config.setAll(CUSTOM);
    config.failAll(syntheticError('SyntheticStoreError'), mode);
    const { logger, warns } = fakeLogger();
    const options = await settle(settings(config, logger).read(APP), 'read()');
    expect(effective(options)).toEqual(DEFAULTS);
    expect(warns).toHaveLength(KEYS.length);
    const events = new Set<string>();
    for (const key of KEYS) {
      events.add(readFailedEvent(warnNaming(warns, key), key, 'SyntheticStoreError'));
    }
    expect(events.size).toBe(1);
    expectNoErrorDetail(warns);
  },
);

it('[AC-B1-22w-READ#3] 读取失败的事件名固定，且不同于取值不合法的事件名', async () => {
  const invalid = await invalidValueEvent();
  const events = new Set<string>();
  for (const key of KEYS) {
    for (const kind of KINDS) {
      const config = failingConfig();
      config.fail(key, syntheticError(kind));
      const { logger, warns } = fakeLogger();
      await settle(settings(config, logger).read(APP), 'read()');
      expect(warns).toHaveLength(1);
      events.add(readFailedEvent(warns[0], key, kind));
    }
  }
  expect(events.size).toBe(1);
  expect(events.has(invalid)).toBe(false);
});

it('[AC-B1-22w-READ#4] 一键读取抛错、另一键不合法：各自回落默认，各告警一条，事件各归其类', async () => {
  const invalid = await invalidValueEvent();
  const config = failingConfig();
  config.setAll(CUSTOM);
  config.fail(MEMBER, syntheticError('SyntheticDeadlineError'));
  config.set(BASIS, 'COUPON_ONLY');
  const { logger, warns } = fakeLogger();
  const options = await settle(settings(config, logger).read(APP), 'read()');
  expect(effective(options)).toEqual({
    ...CUSTOM,
    [MEMBER]: DEFAULTS[MEMBER],
    [BASIS]: DEFAULTS[BASIS],
  });
  expect(warns).toHaveLength(2);
  const failed = readFailedEvent(warnNaming(warns, MEMBER), MEMBER, 'SyntheticDeadlineError');
  expect(keyWarnEvent(warnNaming(warns, BASIS), BASIS)).toBe(invalid);
  expect(failed).not.toBe(invalid);
  expectNoErrorDetail(warns);
});

it('[AC-B1-22w-READ#5] 告警不带错误全文、凭据、堆栈或错误对象本身', async () => {
  const config = failingConfig();
  const error = syntheticError('SyntheticStoreError');
  config.fail(COUPON, error);
  config.fail(UNKNOWN, error, 'throw');
  const { logger, warns } = fakeLogger();
  await settle(settings(config, logger).read(APP), 'read()');
  expect(warns).toHaveLength(2);
  readFailedEvent(warnNaming(warns, COUPON), COUPON, 'SyntheticStoreError');
  readFailedEvent(warnNaming(warns, UNKNOWN), UNKNOWN, 'SyntheticStoreError');
  const text = loggedText(warns);
  expect(text).not.toContain(error.message);
  expect(text).not.toContain(DETAIL_MARKER);
  expect(text).not.toContain(CREDENTIAL_MARKER);
  for (const call of warns) for (const arg of call) expect(arg).not.toBe(error);
  expectNoErrorDetail(warns);
});

it('[AC-B1-22w-READ#6] 抛出的不是 Error（字符串）也不上抛：该键用默认，告警一条且不带抛出的文本', async () => {
  const config = failingConfig();
  config.setAll(CUSTOM);
  config.fail(DISCOUNT, `plain failure ${DETAIL_MARKER} ${CREDENTIAL_MARKER}`, 'throw');
  const { logger, warns } = fakeLogger();
  const options = await settle(settings(config, logger).read(APP), 'read()');
  expect(effective(options)).toEqual({ ...CUSTOM, [DISCOUNT]: DEFAULTS[DISCOUNT] });
  expect(warns).toHaveLength(1);
  readFailedEvent(warns[0], DISCOUNT);
  expectNoErrorDetail(warns);
});

it('[AC-B1-22w-READ#7] 只影响读失败的那个应用：另一应用照常用自己的配置、不告警', async () => {
  const config = failingConfig();
  config.setAll(CUSTOM, APP);
  config.setAll(CUSTOM, OTHER_APP);
  config.failAll(syntheticError('SyntheticStoreError'), 'reject', APP);
  const theirs = fakeLogger();
  const other = await settle(settings(config, theirs.logger).read(OTHER_APP), 'read()');
  expect(effective(other)).toEqual(CUSTOM);
  expect(theirs.warns).toEqual([]);
  const mine = fakeLogger();
  const options = await settle(settings(config, mine.logger).read(APP), 'read()');
  expect(effective(options)).toEqual(DEFAULTS);
  expect(mine.warns).toHaveLength(KEYS.length);
});

it('[AC-B1-22w-READ#8] 读失败的 basis 不会切到降级口径：配置为 coupon_only 时按默认 promotion_path 映射', async () => {
  const config = failingConfig();
  config.set(BASIS, 'coupon_only');
  // Baseline: the configured coupon_only takes effect when the read succeeds.
  const configured = await settings(config).read(APP);
  expect(effective(configured)[BASIS]).toBe('coupon_only');
  config.fail(BASIS, syntheticError('SyntheticDeadlineError'));
  const options = await settle(settings(config).read(APP), 'read()');
  expectPrice(mapTaobaoPrice(example, now, options), 2990n, 500n, 2490n);
});

it('[AC-B1-22w-READ#9] 读失败的 unknown_promo 按默认 unavailable：配置为 add_back 时清单外名称仍不出价', async () => {
  const config = failingConfig();
  config.set(UNKNOWN, 'add_back');
  const configured = await settings(config).read(APP);
  expectPrice(mapTaobaoPrice(withUnknown, now, configured), 3990n, 300n, 3690n);
  config.fail(UNKNOWN, syntheticError('SyntheticStoreError'), 'throw');
  const options = await settle(settings(config).read(APP), 'read()');
  expectAnomaly(mapTaobaoPrice(withUnknown, now, options), 'unknown_promo');
});

it('[AC-B1-22w-READ#10] 读失败的名称清单按默认清单归类：自定义券名不再生效，默认券名照常计券', async () => {
  const config = failingConfig();
  config.set(COUPON, ['演示券']);
  config.set(MEMBER, ['演示会员']);
  config.fail(COUPON, syntheticError('SyntheticStoreError'));
  config.fail(MEMBER, syntheticError('SyntheticStoreError'));
  const options = await settle(settings(config).read(APP), 'read()');
  // Default lists: 商品券 counts as a coupon, 88VIP9.5折 is added back as a member item.
  expectPrice(mapTaobaoPrice(example, now, options), 2990n, 500n, 2490n);
});
