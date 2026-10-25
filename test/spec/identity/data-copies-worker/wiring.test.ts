// B1-27h（brief §9 ①：照 B1-34e 的写法新增 identity 的 data-copy-worker，在 identity-worker.module.ts 装配）：
// worker 入口上，app.module 传给 IdentityWorkerModule.forWorker 的选项建出的模块，在有库、队列、
// 导出存储与字段密钥时把 data-copy 队列的处理器注册到 JOB_QUEUE；data-copy 是队列目录里的一个标准
// 业务队列（目录默认值、自己的死信队列），只有 worker 入口执行它。模块与 app.module 的选项工厂只依赖
// 平台令牌（CLOCK、ROOT_LOGGER、APP_CONFIG、DB、JOB_QUEUE、EXPORT_STORE、FIELD_CRYPTO），同 worker
// 上其他模块。不连库：DB 是只编译不连接的 Kysely。
import { afterEach, expect, it, vi } from 'vitest';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/catalog.ts';
import { compileOnlyDb, ports, type CompiledStatement } from '../deletion-processing/kit.ts';
import { QUEUE, ROOT, fieldCrypto, nestContext } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

interface WorkerModuleApi {
  IdentityWorkerModule: { forWorker(options: never): { module: unknown } };
}

it('[AC-B1-27h#8] 装配：worker 入口的 IdentityWorkerModule（app.module 传的选项）在有库、队列、存储与密钥时把 data-copy 队列的处理器注册到 JOB_QUEUE', async () => {
  const p = await ports();
  const api = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as WorkerModuleApi;
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const config = p.platform.loadConfig({ APP_ENV: 'test' });
  const forWorker = vi
    .spyOn(api.IdentityWorkerModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityWorkerModule });
  AppModule.forEntry({ entry: 'worker', config, clock: p.clock, logger: p.logger });
  expect(forWorker, 'app.module does not assemble IdentityWorkerModule').toHaveBeenCalledTimes(1);
  const options = forWorker.mock.calls[0]![0];
  forWorker.mockRestore();

  const registered: { queue: string; handler: unknown }[] = [];
  const queue = {
    register: vi.fn(
      (name: string, handler: unknown) => void registered.push({ queue: name, handler }),
    ),
    send: vi.fn(async () => 'job-id'),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const statements: CompiledStatement[] = [];
  const db = compileOnlyDb(statements);
  const store = p.platform.createExportStore({
    appEnv: 'test',
    baseUrl: undefined,
    signingKey: undefined,
    clock: p.clock,
    logger: p.logger,
  });
  const context = await nestContext(api.IdentityWorkerModule.forWorker(options), [
    { provide: p.platform.CLOCK, useValue: p.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: p.logger },
    { provide: p.platform.APP_CONFIG, useValue: config },
    { provide: p.platform.DB, useValue: db },
    { provide: p.platform.JOB_QUEUE, useValue: queue },
    { provide: p.platform.EXPORT_STORE, useValue: store },
    { provide: p.platform.FIELD_CRYPTO, useValue: await fieldCrypto() },
  ]);
  try {
    const copies = registered.filter((item) => item.queue === QUEUE);
    expect(copies, 'no handler registered for the data-copy queue').toHaveLength(1);
    expect(typeof copies[0]!.handler).toBe('function');
  } finally {
    try {
      await context.close();
    } finally {
      await db.destroy();
    }
  }
}, 30_000);

it('[AC-B1-27h#9] 队列目录：data-copy 恰有一条，标准策略与目录默认值、死信 data-copy.dead（其死信队列也在目录里）；只有 worker 入口执行它', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toEqual([
    {
      name: QUEUE,
      policy: 'standard',
      retryLimit: 5,
      retryDelaySeconds: 10,
      retryBackoff: true,
      retryDelayMaxSeconds: 600,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      deadLetter: `${QUEUE}.dead`,
    },
  ]);
  expect(QUEUE_CATALOG.filter((queue) => queue.name === `${QUEUE}.dead`)).toHaveLength(1);
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toHaveLength(1);
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    expect(
      ENTRY_PLAN[entry].some((work) => work.queue === QUEUE),
      entry,
    ).toBe(false);
  }
});
