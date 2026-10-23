// F1-02zzj §9.2 ⑤ / §9.3 ⑤ (no database): the dedicated-port key set and its absence from every
// general configuration outlet: config-registry (admin config center), the switch registry and
// the keys GET /v1/config reads. The oracle is the key name itself, never the registry.
import { expect, it, vi } from 'vitest';
import {
  ConfigItemFieldsError,
  configBatchPermission,
  requireConfigItem,
} from '../../../../apps/api/src/modules/content/application/config-item-admin.ts';
import {
  CLIENT_CONFIG_KEYS,
  buildClientConfig,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import {
  configItemSpecOf,
  configRegistry,
} from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { dedicatedConfigKeys } from '../../../../apps/api/src/modules/content/domain/dedicated-config-keys.ts';
import {
  switchRegistry,
  switchSpecOf,
} from '../../../../apps/api/src/modules/content/domain/switch-registry.ts';

const KEY = 'union.auth_alert_phones';
const MARK = 'f102zzjOpaqueCipherMark';

it('[AC-F1-02zzj#13] 专用端口键集合恰为 union.auth_alert_phones', () => {
  expect(dedicatedConfigKeys()).toStrictEqual([KEY]);
});

it('[AC-F1-02zzj#14] 专用端口键不在配置注册表、开关注册表与客户端配置读取键中', () => {
  const keys = dedicatedConfigKeys();
  expect(keys.length).toBeGreaterThan(0);
  const registered = configRegistry().map((spec) => spec.key);
  const switches = switchRegistry().map((spec) => spec.pattern);
  for (const key of keys) {
    expect(registered, key).not.toContain(key);
    expect(configItemSpecOf(key), key).toBeNull();
    expect(switches, key).not.toContain(key);
    expect(switchSpecOf(key), key).toBeNull();
    expect(CLIENT_CONFIG_KEYS, key).not.toContain(key);
  }
});

it('[AC-F1-02zzj#15] 通用配置用例对专用端口键按未登记键拒收：读、改、回滚 [key]，批量列出该键', () => {
  const keys = dedicatedConfigKeys();
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    for (const writable of [false, true]) {
      let thrown: unknown;
      try {
        requireConfigItem(key, writable);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${key} writable=${writable}`).toBeInstanceOf(ConfigItemFieldsError);
      expect((thrown as ConfigItemFieldsError).fields).toStrictEqual(['key']);
    }
    const entries = [
      { key: 'order.user_query_months', value: 3, expected_version: 0 },
      { key, value: { cipher: `v1.${MARK}` }, expected_version: 0 },
    ] as unknown as Parameters<typeof configBatchPermission>[0];
    let thrown: unknown;
    try {
      configBatchPermission(entries);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, key).toBeInstanceOf(ConfigItemFieldsError);
    expect((thrown as ConfigItemFieldsError).fields).toStrictEqual([key]);
  }
});

it('[AC-F1-02zzj#16] 客户端配置不带出专用端口键：库里有值时 /v1/config 结果与无此行时相同，且不含其值', () => {
  const keys = dedicatedConfigKeys();
  expect(keys.length).toBeGreaterThan(0);
  const base: [string, unknown][] = [
    ['h5_base_url', 'https://h5.example.test/'],
    ['h5_release.stable', 'stable'],
    ['kf', { url: 'https://kf.example.test/' }],
    ['legal.privacy.version', 1],
    ['legal.privacy.min_version', 1],
    ['legal.agreement.version', 1],
  ];
  const assemble = (values: ReadonlyMap<string, unknown>) => {
    const report = { invalid: vi.fn(), missing: vi.fn() };
    const config = buildClientConfig({
      values,
      viewer: { appId: 'f102zzj_domain', userId: null },
      deviceId: null,
      linkPatterns: { version: 'fixture', rules: [] },
      rankPlatforms: [],
      report,
    });
    return { config, report };
  };
  const without = assemble(new Map(base));
  const withKeys = assemble(
    new Map([...base, ...keys.map((key): [string, unknown] => [key, { cipher: `v1.${MARK}` }])]),
  );
  expect(withKeys.config).toBeDefined();
  expect(withKeys.config).toStrictEqual(without.config);
  expect(JSON.stringify(withKeys.config)).not.toContain(MARK);
  expect(withKeys.report.invalid).not.toHaveBeenCalled();
  expect(withKeys.report.missing).not.toHaveBeenCalled();
});
