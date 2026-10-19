import { expect, it } from 'vitest';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { NOW, ROOT, newAppId, read, validate, type CreateHttpApp } from './kit.ts';

it('[AC-F1-02ze#12] 无数据库仍注册版本路由并返回 50001', async () => {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp: CreateHttpApp;
  };
  const app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock(NOW),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  try {
    await app.init();
    expect(
      app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: '/v1/agreements/:type' }),
    ).toBe(true);
    const response = await read(app, newAppId(), 'privacy');
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe(50001);
    await validate(response);
  } finally {
    await app.close();
  }
}, 30_000);
