// BR-ID-36 细则「规则清单的启停」: the read port risk exports from index.ts (D10-536 §9.2 1).
// The reader is created inside each test body (a NotImplemented factory fails that test only).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRiskRuleStatusReader } from '../../../../apps/api/src/modules/risk/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { closeKit, openKit, type Kit } from '../../identity/registration/kit.ts';
import { AT, TTL_MS, newAppId, rules, setRuleStatus } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-03zh#1][BR-ID-36] disabled 不生效；enabled、写入方登记的 active 与无行均生效；只读不登记', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  await setRuleStatus(kit.db, appId, 'DEVICE_REGISTER_LIMIT', 'disabled', clock.now());
  await setRuleStatus(kit.db, appId, 'SMS_BLOCKED_PREFIX', 'enabled', clock.now());
  await setRuleStatus(kit.db, appId, 'BLACKLIST_PHONE', 'active', clock.now());
  const before = await rules(kit.db, appId);
  const reader = createRiskRuleStatusReader({ db: kit.db, clock });
  expect(await reader.isEnabled({ app_id: appId, rule_id: 'DEVICE_REGISTER_LIMIT' })).toBe(false);
  expect(await reader.isEnabled({ app_id: appId, rule_id: 'SMS_BLOCKED_PREFIX' })).toBe(true);
  expect(await reader.isEnabled({ app_id: appId, rule_id: 'BLACKLIST_PHONE' })).toBe(true);
  expect(await reader.isEnabled({ app_id: appId, rule_id: 'inv_09_same_device' })).toBe(true);
  // A read registers nothing and changes nothing.
  expect(await rules(kit.db, appId)).toEqual(before);
});

it('[AC-B1-03zh#2][BR-ID-36] 按 app 隔离：A app 停用不影响 B app 同名规则', async () => {
  const a = newAppId();
  const b = newAppId();
  const c = newAppId();
  const clock = new FixedClock(AT);
  await setRuleStatus(kit.db, a, 'inv_09_same_device', 'disabled', clock.now());
  await setRuleStatus(kit.db, b, 'inv_09_same_device', 'enabled', clock.now());
  const reader = createRiskRuleStatusReader({ db: kit.db, clock });
  expect(await reader.isEnabled({ app_id: a, rule_id: 'inv_09_same_device' })).toBe(false);
  expect(await reader.isEnabled({ app_id: b, rule_id: 'inv_09_same_device' })).toBe(true);
  expect(await reader.isEnabled({ app_id: c, rule_id: 'inv_09_same_device' })).toBe(true);
  // Read in the other order on a fresh reader: no answer leaks between apps through the cache.
  const fresh = createRiskRuleStatusReader({ db: kit.db, clock });
  expect(await fresh.isEnabled({ app_id: b, rule_id: 'inv_09_same_device' })).toBe(true);
  expect(await fresh.isEnabled({ app_id: a, rule_id: 'inv_09_same_device' })).toBe(false);
});

it('[AC-B1-03zh#3][BR-ID-36][04 §10.2] 与配置项同口径缓存：周期内状态变更不生效，满一个周期后生效', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  const key = { app_id: appId, rule_id: 'DEVICE_REGISTER_LIMIT' };
  await setRuleStatus(kit.db, appId, 'DEVICE_REGISTER_LIMIT', 'disabled', clock.now());
  const reader = createRiskRuleStatusReader({ db: kit.db, clock });
  expect(await reader.isEnabled(key)).toBe(false);

  // Enabled: not seen until the period since the read ends (no wall-clock wait, injected Clock).
  await setRuleStatus(kit.db, appId, 'DEVICE_REGISTER_LIMIT', 'enabled', clock.now());
  expect(await reader.isEnabled(key)).toBe(false);
  clock.advanceMs(TTL_MS - 1);
  expect(await reader.isEnabled(key)).toBe(false);
  clock.advanceMs(1);
  expect(await reader.isEnabled(key)).toBe(true);

  // Disabled again: the same holds the other way.
  await setRuleStatus(kit.db, appId, 'DEVICE_REGISTER_LIMIT', 'disabled', clock.now());
  expect(await reader.isEnabled(key)).toBe(true);
  clock.advanceMs(TTL_MS - 1);
  expect(await reader.isEnabled(key)).toBe(true);
  clock.advanceMs(1);
  expect(await reader.isEnabled(key)).toBe(false);
});

it('[AC-B1-03zh#4][BR-ID-36] 无行时读到生效；之后登记为 disabled，周期内仍生效、周期后不生效', async () => {
  const appId = newAppId();
  const clock = new FixedClock(AT);
  const key = { app_id: appId, rule_id: 'SMS_BLOCKED_PREFIX' };
  const reader = createRiskRuleStatusReader({ db: kit.db, clock });
  expect(await reader.isEnabled(key)).toBe(true);
  expect(await rules(kit.db, appId)).toEqual([]);
  await setRuleStatus(kit.db, appId, 'SMS_BLOCKED_PREFIX', 'disabled', clock.now());
  clock.advanceMs(TTL_MS - 1);
  expect(await reader.isEnabled(key)).toBe(true);
  clock.advanceMs(1);
  expect(await reader.isEnabled(key)).toBe(false);
});
