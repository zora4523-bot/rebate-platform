import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  MEDIA_STORE,
  mediaUrlOf,
  MemoryMediaStore,
  MediaStoreUnavailableError,
  type MediaStore,
} from '../../../../apps/api/src/modules/platform/media/index.ts';
import { BASE_URL, SVG, digest, memoryLogger } from './kit.ts';
import { expectRequestFailure } from './error-response.ts';

// Computed imports keep Nest's decorators outside the spec project's erasable-only TS build.
interface DynamicModule {
  global?: boolean;
  exports?: unknown[];
}
interface PlatformExports {
  MEDIA_STORE: unknown;
  mediaUrlOf: typeof mediaUrlOf;
  PlatformModule: { forRoot(options: object): DynamicModule };
}
interface TestContext {
  get<T>(token: unknown): T;
  close(): Promise<void>;
}
interface NestTesting {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): {
      compile(): Promise<TestContext>;
    };
  };
}

async function platformExports(): Promise<PlatformExports> {
  return (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as PlatformExports;
}

it('[AC-F1-06z#13] platform 公共出口导出 Symbol 令牌及不需写入即可调用的 URL 函数', async () => {
  const platform = await platformExports();
  expect(typeof platform.MEDIA_STORE).toBe('symbol');
  expect(platform.MEDIA_STORE).toBe(MEDIA_STORE);
  expect(platform.mediaUrlOf).toBe(mediaUrlOf);
  expect(platform.mediaUrlOf(BASE_URL, digest(SVG), 'svg')).toBe(`${BASE_URL}/${digest(SVG)}.svg`);
});

it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-F1-06z#14] %s 在三个 HTTP 入口全局提供并导出按环境选择的 MEDIA_STORE',
  async (appEnv) => {
    const platform = await platformExports();
    expect(typeof platform.MEDIA_STORE).toBe('symbol');
    const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
    const testing = (await import(
      pathToFileURL(requireApi.resolve('@nestjs/testing')).href
    )) as NestTesting;
    for (const entry of ['api', 'stream', 'admin']) {
      const { logger } = memoryLogger(appEnv);
      // Isolate media provisioning from KMS/database/identity startup. loadConfig's cloud
      // requirements are tested separately; PlatformModule itself only needs these values.
      const config = {
        ...loadConfig({ APP_ENV: 'test' }),
        appEnv,
        mediaPublicBaseUrl: BASE_URL,
        keyring: null,
      };
      const module = platform.PlatformModule.forRoot({
        entry,
        config,
        logger,
        clock: new FixedClock('2026-10-10T00:00:00Z'),
      });
      expect(module.global).toBe(true);
      expect(module.exports).toContain(platform.MEDIA_STORE);
      const context = await testing.Test.createTestingModule({ imports: [module] }).compile();
      try {
        const store = context.get<MediaStore>(platform.MEDIA_STORE);
        expect(store).toBeDefined();
        expect(context.get(platform.MEDIA_STORE)).toBe(store);
        const input = { sha256: digest(SVG), bytes: SVG, contentType: 'image/svg+xml' as const };
        if (appEnv === 'local' || appEnv === 'test') {
          expect(store).toBeInstanceOf(MemoryMediaStore);
          expect(await store.put(input)).toEqual({ url: `${BASE_URL}/${input.sha256}.svg` });
          expect((store as MemoryMediaStore).get(input.sha256)).toEqual(SVG);
        } else {
          expect(store).not.toBeInstanceOf(MemoryMediaStore);
          await expect(store.put(input)).rejects.toBeInstanceOf(MediaStoreUnavailableError);
          await expect(store.put(input)).rejects.toBeInstanceOf(MediaStoreUnavailableError);
          await expectRequestFailure(() => store.put(input), logger);
        }
      } finally {
        await context.close();
      }
    }
  },
);
