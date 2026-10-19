import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { Idempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { ROOT, apiRequire } from './http-kit.ts';
import { CONTEXT, JSON_BODY, RESULT, cryptoFixture, fixture, keyed, request } from './kit.ts';

it('[AC-B1-01zzf#11] PlatformModule 提供的幂等实例实际使用容器内的 FieldCrypto', async () => {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/platform.module.ts', ROOT).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers: unknown[] } };
    IDEMPOTENCY: symbol;
    FIELD_CRYPTO: symbol;
  };
  interface Context {
    get<T>(key: symbol): T;
    close(): Promise<void>;
  }
  const { NestFactory } = apiRequire('@nestjs/core') as {
    NestFactory: {
      createApplicationContext(module: object, options: object): Promise<Context>;
    };
  };
  const crypto = cryptoFixture();
  const f = fixture();
  let app: Context | undefined;
  try {
    const module = platform.PlatformModule.forRoot({
      entry: 'api',
      config: loadConfig({ APP_ENV: 'test' }),
      clock: f.clock,
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
    });
    // 仅替换已解封的字段加密 provider；幂等 provider 和 Nest 注入过程均为真实装配。
    app = await NestFactory.createApplicationContext(
      {
        ...module,
        providers: [
          ...module.providers,
          { provide: platform.FIELD_CRYPTO, useValue: crypto.fieldCrypto },
        ],
      },
      { logger: false, abortOnError: false },
    );
    const idem = app.get<Idempotency>(platform.IDEMPOTENCY);
    await idem.execute(request('execute'), async () => RESULT);
    expect(f.hashWrites()).toEqual([keyed(JSON_BODY)]);
    expect(crypto.blindIndex).toHaveBeenCalledWith(JSON_BODY, CONTEXT);
  } finally {
    await app?.close();
    await f.db.destroy();
  }
});
