import { expect, it } from 'vitest';
import { CLIENT_CONFIG_KEYS } from './client-config.ts';
import { configItemSpecOf, configRegistry } from './config-registry.ts';
import { dedicatedConfigKeys, isDedicatedConfigKey } from './dedicated-config-keys.ts';
import { switchRegistry, switchSpecOf } from './switch-registry.ts';

it('[AC-F1-02zzj-unit#10] 专用端口键集合只有 union.auth_alert_phones，判定函数与之一致', () => {
  expect(dedicatedConfigKeys()).toStrictEqual(['union.auth_alert_phones']);
  expect(isDedicatedConfigKey('union.auth_alert_phones')).toBe(true);
  expect(isDedicatedConfigKey('union.auth_alert_days')).toBe(false);
  expect(isDedicatedConfigKey('union.auth_alert_phones ')).toBe(false);
});

it('[AC-F1-02zzj-unit#11] 专用端口键不得登记进配置注册表、开关注册表或客户端配置读取键', () => {
  for (const key of dedicatedConfigKeys()) {
    expect(configRegistry().map((spec) => spec.key)).not.toContain(key);
    expect(configItemSpecOf(key)).toBeNull();
    expect(switchRegistry().map((spec) => spec.pattern)).not.toContain(key);
    expect(switchSpecOf(key)).toBeNull();
    expect(CLIENT_CONFIG_KEYS).not.toContain(key);
  }
});
