// 沿用 platform/idempotency/followup-http.test.ts 的真实 Fastify inject 装配。
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { IdempotentResponse } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type { HttpApp } from '../errors/kit.ts';
import { NOW } from './kit.ts';

export const PATH = '/__keyed_digest_probe';
export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
type Constructor = abstract new (...args: never[]) => unknown;
interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

export async function withProbe(
  action: (body: unknown) => Promise<IdempotentResponse>,
  check: (app: HttpApp) => Promise<void>,
): Promise<void> {
  const common = apiRequire('@nestjs/common') as {
    Controller(prefix: string): (target: Constructor) => void;
    Post(): (target: object, key: string, descriptor: PropertyDescriptor) => void;
    Req(): (target: object, key: string, index: number) => void;
    Res(): (target: object, key: string, index: number) => void;
  };
  class Probe {
    async post(request: { body: unknown }, reply: RawReply): Promise<void> {
      const response = await action(request.body);
      reply.code(response.status).type('application/json').send(response.body);
    }
  }
  common.Req()(Probe.prototype, 'post', 0);
  common.Res()(Probe.prototype, 'post', 1);
  common.Post()(Probe.prototype, 'post', Object.getOwnPropertyDescriptor(Probe.prototype, 'post')!);
  common.Controller(PATH)(Probe);
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: unknown): Record<string, unknown> };
  };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', options: object): Promise<HttpApp>;
  };
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [Probe],
  }));
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock(NOW),
      logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    });
    await app.init();
    await check(app);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}
