import { expect, it, vi } from 'vitest';
import { ClientConfigService } from '../../../../apps/api/src/modules/content/application/client-config.ts';
import type {
  ContentReader,
  ConfigValue,
} from '../../../../apps/api/src/modules/content/application/content-reader.ts';
import { CLIENT_CONFIG_KEYS } from '../../../../apps/api/src/modules/content/domain/client-config.ts';

it('[AC-F1-02zze#11] 资格键和其他配置同批经 ContentReader 读取，每个键恰一次且使用同一快照', async () => {
  const key = 'growth.invite_reward.eligibility_days';
  const appId = 'f102zze_batch';
  const values: Record<string, ConfigValue> = {
    h5_base_url: 'https://h5.example.test/',
    'h5_release.stable': 'stable',
    kf: { url: 'https://kf.example.test/' },
    'legal.privacy.version': 1,
    'legal.privacy.min_version': 1,
    'legal.agreement.version': 1,
    [key]: 45,
    'growth.invite_reward.enabled': true,
    'growth.invite_reward.amount_fen': 500,
    texts: { snapshot: 'before' },
  };
  const gate = Promise.withResolvers<void>();
  const calls: { appId: string; key: string }[] = [];
  const reader: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: async (id, name) => {
      calls.push({ appId: id, key: name });
      // Capture on invocation, then hold every read pending. A second, later read sees 60.
      const row = Object.hasOwn(values, name)
        ? { value: structuredClone(values[name]!), version: 1 }
        : null;
      await gate.promise;
      return row;
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = new ClientConfigService({
    reader,
    logger,
    platformIcons: async () => ({}),
    linkPatterns: () => ({ version: 'fixture', rules: [] }),
    materialChannels: () => ({ version: 'fixture', channels: [] }),
    inviteRewardBudget: { available: async () => 1000 },
  });
  const pending = service.read({ appId, userId: null }, null);
  // Let the initial asynchronous read batch start without completing any read.
  await Promise.resolve();
  const firstBatch = [...calls];
  values[key] = 60;
  values['growth.invite_reward.amount_fen'] = 750;
  values['texts'] = { snapshot: 'after' };
  gate.resolve();
  const config = await pending;
  expect(CLIENT_CONFIG_KEYS.filter((name) => name === key)).toEqual([key]);
  expect(firstBatch).toEqual(
    expect.arrayContaining([
      { appId, key },
      { appId, key: 'growth.invite_reward.enabled' },
      { appId, key: 'growth.invite_reward.amount_fen' },
      { appId, key: 'texts' },
    ]),
  );
  expect(firstBatch.map((call) => call.key).sort()).toEqual([...CLIENT_CONFIG_KEYS].sort());
  expect(calls).toEqual(firstBatch);
  expect(calls.every((call) => call.appId === appId)).toBe(true);
  expect(config.invite).toMatchObject({
    eligibility_days: 45,
    reward_enabled: true,
    reward_amount_fen: 500,
  });
  expect(config.texts).toEqual({ snapshot: 'before' });
  expect(logger.warn).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});
