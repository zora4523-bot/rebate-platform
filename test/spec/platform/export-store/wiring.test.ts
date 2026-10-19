import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  EXPORT_STORE,
  ExportStoreUnavailableError,
  MemoryExportStore,
  type ExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { BASE_URL, CSV, EXPIRES, KEY, SIGNING_KEY, configEnv, fixture } from './kit.ts';

interface TestContext {
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

// Computed imports keep decorated Nest source outside the erasable-only spec TS project.
it.each(['local', 'test', 'staging', 'prod'] as const)(
  '[AC-B1-34d#18] %s 的五个入口全局提供同一 EXPORT_STORE，配置和 Clock 传入适配器',
  async (appEnv) => {
    const platform = (await import(
      new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
    )) as {
      EXPORT_STORE: unknown;
      PlatformModule: { forRoot(options: object): { global?: boolean; exports?: unknown[] } };
    };
    expect(platform.EXPORT_STORE).toBe(EXPORT_STORE);
    const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
    const { Test } = (await import(pathToFileURL(requireApi.resolve('@nestjs/testing')).href)) as {
      Test: { createTestingModule(metadata: object): { compile(): Promise<TestContext> } };
    };
    for (const entry of ['api', 'stream', 'admin', 'worker', 'payout']) {
      const options = fixture(appEnv);
      const config = {
        ...loadConfig({
          ...configEnv(appEnv),
          EXPORT_STORE_BASE_URL: BASE_URL,
          EXPORT_STORE_SIGNING_KEY: SIGNING_KEY,
        }),
        // Isolate export provisioning from KMS; no database/Redis handles are supplied.
        keyring: null,
      };
      const module = platform.PlatformModule.forRoot({ ...options, config, entry });
      expect(module.global).toBe(true);
      expect(module.exports).toContain(EXPORT_STORE);
      const context = await Test.createTestingModule({ imports: [module] }).compile();
      try {
        const store = context.get<ExportStore>(EXPORT_STORE);
        expect(context.get(EXPORT_STORE)).toBe(store);
        const input = { key: KEY, bytes: CSV, contentType: 'text/csv' as const };
        const signing = { key: KEY, expiresAt: new Date(EXPIRES) };
        if (appEnv === 'local' || appEnv === 'test') {
          expect(store).toBeInstanceOf(MemoryExportStore);
          await store.put(input);
          const result = await store.signedUrl(signing);
          expect(result.url.startsWith(`${BASE_URL}/${KEY}?`)).toBe(true);
          const verifier = new MemoryExportStore(options);
          expect(verifier.verify(result.url, options.clock.now())).toBe(true);
          options.clock.set(signing.expiresAt);
          await expect(
            Promise.resolve().then(() => store.signedUrl(signing)),
          ).rejects.toBeInstanceOf(Error);
        } else {
          await expect(store.put(input)).rejects.toBeInstanceOf(ExportStoreUnavailableError);
          await expect(store.signedUrl(signing)).rejects.toBeInstanceOf(
            ExportStoreUnavailableError,
          );
        }
      } finally {
        await context.close();
      }
    }
  },
);
