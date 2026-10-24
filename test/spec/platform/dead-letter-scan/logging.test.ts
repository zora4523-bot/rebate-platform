import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

it('[AC-B1-01zzg#6] loadConfig 只从注入的 COULI_DEPLOY_VERSION 读取镜像 tag，未设和空串均按缺省处理', () => {
  const config = loadConfig({ APP_ENV: 'test', COULI_DEPLOY_VERSION: 'release-2026.10.23' });
  expect(config).toHaveProperty('deployVersion', 'release-2026.10.23');
  for (const env of [{ APP_ENV: 'test' }, { APP_ENV: 'test', COULI_DEPLOY_VERSION: '' }]) {
    const unset: unknown = loadConfig(env);
    expect(unset).not.toHaveProperty('deployVersion', '');
    expect((unset as { deployVersion?: string }).deployVersion).toBeUndefined();
  }
});

it('[AC-B1-01zzg#7] pino 根 base 与子日志均带部署 tag；缺省时 bindings 与 JSON 都没有该键', () => {
  for (const deployVersion of ['release-2026.10.23', undefined, '']) {
    const lines: Record<string, unknown>[] = [];
    const options = { level: 'info' as const, entry: 'worker', appEnv: 'test', deployVersion };
    const logger = createRootLogger(options, {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    logger.info('root');
    logger.child({ queue: 'notify.dead' }).error({ count: 2 }, 'child');
    expect(lines).toHaveLength(2);
    for (const record of [logger.bindings(), ...lines]) {
      if (deployVersion) {
        expect(record).toHaveProperty('deployVersion', deployVersion);
      } else {
        expect(Object.hasOwn(record, 'deployVersion')).toBe(false);
      }
    }
  }
});
