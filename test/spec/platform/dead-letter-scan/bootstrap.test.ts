import { expect, it } from 'vitest';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import { ROOT_LOGGER } from '../../../../apps/api/src/modules/platform/platform.module.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';

interface Context {
  get<T>(key: unknown): T;
  close(): Promise<void>;
}

// The test tsconfig deliberately excludes Nest decorator syntax. Load the application at
// runtime through a nonliteral path, as other entry rule tests do, without compiling controllers
// as part of the test project. Vitest still loads the real bootstrap via its API transformer.
interface Bootstrap {
  createHttpApp(
    entry: 'api' | 'stream' | 'admin',
    options: { config: AppConfig },
  ): Promise<Context>;
  createWorkerContext(entry: 'worker' | 'payout', options: { config: AppConfig }): Promise<Context>;
}

it('[AC-B1-01zzg#8] 五入口 bootstrap 默认根日志传递配置里的部署 tag，无须调用者另传 logger', async () => {
  const bootstrapPath = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;
  const { createHttpApp, createWorkerContext } = (await import(bootstrapPath)) as Bootstrap;
  const config = {
    ...loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    deployVersion: 'release-bootstrap',
  };
  for (const entry of ['api', 'stream', 'admin', 'worker', 'payout'] as const) {
    const context =
      entry === 'worker' || entry === 'payout'
        ? await createWorkerContext(entry, { config })
        : await createHttpApp(entry, { config });
    try {
      expect(context.get<RootLogger>(ROOT_LOGGER).bindings()).toHaveProperty(
        'deployVersion',
        'release-bootstrap',
      );
    } finally {
      await context.close();
    }
  }
});
