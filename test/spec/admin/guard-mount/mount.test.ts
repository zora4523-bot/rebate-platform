import { expect, it } from 'vitest';
import type { AdminOperationGuard } from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { apiRequire, NOW, type HttpApp } from '../auth/kit.ts';
import { ROOT } from '../permissions/expected.ts';
import { exportedGuard, guardOf, rejected, TRACE, type ProbeServer } from './kit.ts';

it('[AC-F1-06u#1] platform 类令牌全局注入到独立业务模块，仅 admin 入口提供', async () => {
  const token = await exportedGuard();
  // The consumer is a sibling of the production entry module; it never imports admin.
  // Optional injection lets the skeleton produce an assertion failure instead of a DI crash.
  const { Module } = (await import(apiRequire.resolve('@nestjs/common'))) as {
    Module(metadata: object): (target: object) => void;
  };
  const { NestFactory } = (await import(apiRequire.resolve('@nestjs/core'))) as {
    NestFactory: {
      createApplicationContext(
        module: object,
        options: object,
      ): Promise<{
        get<T>(token: symbol): T;
        close(): Promise<void>;
      }>;
    };
  };
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): object };
  };
  for (const entry of ['api', 'stream', 'admin'] as const) {
    const consumer = Symbol('test-only-admin-guard-consumer');
    class BusinessProbeModule {}
    Module({
      providers: [
        {
          provide: consumer,
          inject: [{ token, optional: true }],
          useFactory: (guard: AdminOperationGuard | undefined) => ({ guard }),
        },
      ],
      exports: [consumer],
    })(BusinessProbeModule);
    class ProbeRootModule {}
    Module({
      imports: [
        AppModule.forEntry({
          entry,
          config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
          clock: new FixedClock(NOW),
          logger: memoryLogger().logger,
        }),
        BusinessProbeModule,
      ],
    })(ProbeRootModule);
    const context = await NestFactory.createApplicationContext(ProbeRootModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const result = context.get<{ guard: AdminOperationGuard | undefined }>(consumer);
      if (entry === 'admin') expect(result.guard).toBeInstanceOf(token);
      else expect(result.guard).toBeUndefined();
    } finally {
      await context.close();
    }
  }
});

it('[AC-F1-06u#19] 没有数据库和 Redis 也能启动 admin，但依赖它们的请求返回 50001', async () => {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'admin', options: object): Promise<HttpApp>;
  };
  const app = await createHttpApp('admin', {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    clock: new FixedClock(NOW),
    logger: memoryLogger().logger,
  });
  try {
    await app.init();
    const guard = await guardOf(app);
    const server = app.getHttpAdapter().getInstance() as unknown as ProbeServer;
    let calls = 0;
    // Synthetic route deliberately bypasses login to isolate absent guard dependencies.
    server.get('/__guard_without_backends', async (request, reply) => {
      request.adminPrincipal = {
        adminId: 'f42c9e39-248c-4b85-a018-9a578cfaf464',
        appId: 'couli',
        sessionId: '8abc2f42-4e40-40b2-ae38-df9ed48835bf',
        isSuper: false,
      };
      const result = await guard.run({ request, permission: 'content.platform_icon' }, async () => {
        calls += 1;
        return { statusCode: 200, body: { code: 0 } };
      });
      return reply.code(result.statusCode).send(result.body);
    });
    await rejected(
      await app.inject({
        method: 'GET',
        url: '/__guard_without_backends',
        headers: { 'x-trace-id': TRACE },
      }),
      50001,
    );
    expect(calls).toBe(0);
  } finally {
    await app.close();
  }
});
