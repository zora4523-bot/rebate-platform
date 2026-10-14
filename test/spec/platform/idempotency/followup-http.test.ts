// B1-01zt 台账②④：真实 createHttpApp + Fastify inject，不连库、不监听。
// 装饰器以普通函数调用，动态导入遵循 platform/errors/kit.ts 的编译边界。
import { createRequire } from 'node:module';
import { beforeAll, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  canonicalJson,
  IdempotencyError,
} from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { envelopeValidator, type HttpApp } from '../errors/kit.ts';
import { TRACE, freshKey } from './kit.ts';

const PATH = '/__idempotency_followup';
const BODY_MARKER = 'followup-http-private-body';
const DRIVER_MARKER = 'followup-http-private-driver';
type Constructor = abstract new (...args: never[]) => unknown;
interface ProbeRequest {
  readonly id: string;
  readonly body: unknown;
}
interface NestCommon {
  Controller(prefix: string): (target: Constructor) => void;
  Post(): (target: object, key: string, descriptor: PropertyDescriptor) => void;
  Req(): (target: object, key: string, index: number) => void;
}

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
let validate: Awaited<ReturnType<typeof envelopeValidator>>;
beforeAll(async () => {
  validate = await envelopeValidator();
});

async function withProbe(
  action: (request: ProbeRequest) => unknown,
  check: (app: HttpApp, lines: string[]) => Promise<void>,
): Promise<void> {
  const common = apiRequire('@nestjs/common') as NestCommon;
  class Probe {
    post(request: ProbeRequest): unknown {
      return action(request);
    }
  }
  common.Req()(Probe.prototype, 'post', 0);
  common.Post()(Probe.prototype, 'post', Object.getOwnPropertyDescriptor(Probe.prototype, 'post')!);
  common.Controller(PATH)(Probe);
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: unknown): Record<string, unknown> } };
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: 'api', options: object): Promise<HttpApp> };
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [Probe],
  }));
  const lines: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('api', {
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2031-05-06T07:08:09.123Z'),
      logger: createRootLogger(
        { level: 'trace', entry: 'api', appEnv: 'test' },
        { write: (chunk: string) => void lines.push(chunk) },
      ),
    });
    await app.init();
    await check(app, lines);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}

function post(payload: string, key: string) {
  return {
    method: 'POST' as const,
    url: PATH,
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      'idempotency-key': key,
    },
    payload,
  };
}

it('[AC-B1-01zt#2] 超深请求返回 HTTP 400 / 20001 契约错误，随后 50 层请求仍正常', async () => {
  const reached: string[] = [];
  await withProbe(
    (request) => {
      canonicalJson(request.body);
      reached.push(request.id);
      return { code: 0, msg: '', data: { accepted: true }, trace_id: request.id };
    },
    async (app, lines) => {
      const key = freshKey('http_depth');
      // 用原始 JSON 文本避免测试进程先在 JSON.stringify 中栈溢出。
      const deep = '{"child":'.repeat(10_000) + `"${BODY_MARKER}"` + '}'.repeat(10_000);
      const response = await app.inject(post(deep, key));
      expect.soft(response.statusCode).toBe(400);
      const body: unknown = JSON.parse(response.body);
      expect(validate(body)).toBe(true);
      expect.soft(body).toMatchObject({
        code: 20001,
        msg: expect.any(String),
        data: { fields: ['body'] },
        trace_id: TRACE,
      });
      expect(response.headers['x-trace-id']).toBe(TRACE);
      expect(reached).toEqual([]);
      expect(response.body + lines.join('')).not.toContain(BODY_MARKER);
      expect(response.body + lines.join('')).not.toContain(key);
      const normal = '{"child":'.repeat(50) + '0' + '}'.repeat(50);
      const next = await app.inject(post(normal, freshKey('http_normal')));
      expect(next.statusCode).toBe(201);
      expect(JSON.parse(next.body)).toEqual({
        code: 0,
        msg: '',
        data: { accepted: true },
        trace_id: TRACE,
      });
      expect(reached).toEqual([TRACE]);
    },
  );
}, 30_000);

it('[AC-B1-01zt#4] outcome_unknown 仍断开连接，HTTP 层只记一行含 method/path 的脱敏 error', async () => {
  let uncertain = true;
  await withProbe(
    () => {
      if (uncertain) {
        // 任意附加驱动信息都不能被全局错误日志序列化。
        throw Object.assign(new IdempotencyError('outcome_unknown'), {
          cause: new Error(DRIVER_MARKER),
        });
      }
      return { ok: true };
    },
    async (app, lines) => {
      lines.length = 0;
      const key = freshKey('http_unknown');
      await expect(
        app.inject(post(JSON.stringify({ private: BODY_MARKER }), key)),
      ).rejects.toMatchObject({ code: 'LIGHT_ECONNRESET' });
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const errors = records.filter((record) => record['level'] === 50);
      expect.soft(errors).toHaveLength(1);
      expect.soft(errors[0]).toMatchObject({ method: 'POST', path: PATH });
      for (const secret of [BODY_MARKER, DRIVER_MARKER, key]) {
        expect(lines.join('')).not.toContain(secret);
      }
      uncertain = false;
      const next = await app.inject(post('{}', freshKey('http_after')));
      expect(next.statusCode).toBe(201);
      expect(JSON.parse(next.body)).toEqual({ ok: true });
    },
  );
}, 30_000);
