import { expect, it, vi } from 'vitest';
import {
  createExportStore,
  ExportStoreUnavailableError,
  MemoryExportStore,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { CSV, EXPIRES, KEY, SIGNING_KEY, fixture } from './kit.ts';

async function expectUnavailable(operation: () => unknown, logger: RootLogger): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ExportStoreUnavailableError);
  // Real global error filter; an in-memory HTTP host, no listener or external service.
  const { GlobalErrorFilter } = (await import(
    new URL('../../../../apps/api/src/modules/platform/http/global-errors.ts', import.meta.url).href
  )) as {
    GlobalErrorFilter: new (
      adapter: object,
      logger: RootLogger,
    ) => {
      catch(error: unknown, host: object): void;
    };
  };
  const response = {};
  const request = { id: 'export-store-trace' };
  const reply = vi.fn();
  const filter = new GlobalErrorFilter({ reply, isHeadersSent: () => false, end: vi.fn() }, logger);
  filter.catch(failure, {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getArgByIndex: (index: number) => [request, response][index],
  });
  expect(reply).toHaveBeenCalledExactlyOnceWith(
    response,
    expect.objectContaining({ code: 50001, trace_id: request.id }),
    500,
  );
}

function expectNoSecrets(logs: string): void {
  for (const secret of [
    'private-export-marker',
    SIGNING_KEY,
    Buffer.from(CSV).toString('base64'),
    Buffer.from(CSV).toString('hex'),
    Array.from(CSV).join(','),
  ])
    expect(logs).not.toContain(secret);
  for (const line of logs.split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as Record<string, unknown>;
    for (const field of ['bytes', 'content', 'body', 'url', 'signature', 'signingKey']) {
      expect(record).not.toHaveProperty(field);
    }
  }
}

it.each(['local', 'test'] as const)(
  '[AC-B1-34d#16] %s 工厂选择内存替身，写入、签发和删除日志不泄露内容或签名',
  async (appEnv) => {
    const options = fixture(appEnv);
    const store = createExportStore(options);
    expect(store).toBeInstanceOf(MemoryExportStore);
    await store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' });
    expect((store as MemoryExportStore).get(KEY)?.bytes).toEqual(CSV);
    const result = await store.signedUrl({ key: KEY, expiresAt: new Date(EXPIRES) });
    expect((store as MemoryExportStore).verify(result.url, options.clock.now())).toBe(true);
    await store.delete(KEY);
    expect((store as MemoryExportStore).get(KEY)).toBeUndefined();
    const signature = new URL(result.url).searchParams.get('signature');
    expect(signature).toBeTruthy();
    const logs = options.lines.join('');
    expectNoSecrets(logs);
    expect(logs).not.toContain(result.url);
    expect(logs).not.toContain(signature as string);
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-34d#17] %s 缺 OSS 时构造成功；有无配置每次 put 和 signedUrl 都按请求失败 50001',
  async (appEnv) => {
    for (const configured of [false, true]) {
      const options = fixture(appEnv);
      const store = createExportStore({
        ...options,
        baseUrl: configured ? options.baseUrl : undefined,
        signingKey: configured ? options.signingKey : undefined,
      });
      expect(store).not.toBeInstanceOf(MemoryExportStore);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expectUnavailable(
          () => store.put({ key: KEY, bytes: CSV, contentType: 'text/csv' }),
          options.logger,
        );
        await expectUnavailable(
          () => store.signedUrl({ key: KEY, expiresAt: new Date(EXPIRES) }),
          options.logger,
        );
      }
      const records = options.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.some((record) => record['key'] === KEY)).toBe(true);
      expectNoSecrets(options.lines.join(''));
    }
  },
);
