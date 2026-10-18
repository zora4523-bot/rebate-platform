// Real Nest assembly with an in-memory queue; never starts queue polling or a server.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import type {
  Clock,
  JobHandler,
  QueueRuntime,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';

export async function assembled(entry: string, db: Kysely<DB>, clock: Clock) {
  // URL imports keep parameter decorators in API controllers out of test's erasable TS project.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ close(): Promise<void> }>;
    };
  };
  const registrations: Array<{ name: string; handler: JobHandler }> = [];
  const sends = vi.fn<QueueRuntime['send']>(async () => 'fixture-job');
  const queue: QueueRuntime = {
    register(name, handler) {
      registrations.push({ name, handler });
    },
    send: sends,
    async start() {},
    async stop() {},
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === JOB_QUEUE
          ? { provide: JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  try {
    const context = await NestFactory.createApplicationContext(
      AppModule.forEntry({
        entry,
        config: loadConfig({ APP_ENV: 'test' }),
        clock,
        logger: createRootLogger(
          { level: 'silent', entry: 'worker', appEnv: 'test' },
          { write() {} },
        ),
        dbHandles: { db, dbRead: null, close: async () => undefined },
      }),
      { logger: false, abortOnError: false },
    );
    return { registrations, sends, close: () => context.close() };
  } finally {
    spy.mockRestore();
  }
}
