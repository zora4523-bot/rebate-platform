// Rule tests for the `X-Trace-Id` response header of the HTTP entries (B1-01r).
// Basis (原文 by SPEC_REF): 规划/02 §13 可观测表「日志 … `trace_id`、`uid`（哈希）、模块、耗时；PII
// 脱敏；响应头 `X-Trace-Id` 回传客户端」; 规划/04 §5 响应 `{ "code": 0, "msg": "", "data": {…},
// "trace_id": "…" }` and 公共请求头 `X-Trace-Id`; 规划/03 §4.2 `X-Trace-Id`（客户端生成，便于对照）.
//
// Contract (wiring in apps/api/src/bootstrap.ts and/or apps/api/src/modules/platform/tracing/**;
// resolveTraceId and its format rules of B1-01p are unchanged):
//
// 1. Every response of the three HTTP entries built by `createHttpApp` ('api', 'stream',
//    'admin') carries the response header `x-trace-id`. Header names are case-insensitive; the
//    tests read it as `x-trace-id` (Fastify inject lower-cases response header names).
// 2. Its value is the request id of that request (`request.id`, the Fastify genReqId result,
//    i.e. resolveTraceId of the `x-trace-id` request header), so it is equal to
//      - the `reqId` of both access-log lines of that request ("incoming request",
//        "request completed"), and
//      - the `trace_id` of the response body whenever the body is an envelope with `trace_id`
//        built for this request (health 200, validation 20001).
//    In particular: a well-formed request header comes back exactly as sent (same case); a
//    request header that is not adopted (a phone number, an old-format value, a duplicated
//    header) never comes back — the header carries the newly generated id, the same one as the
//    body and the log; no request header → the newly generated id.
// 3. Set once: the header value is one string (not an array, not a comma-joined list).
// 4. Cases that must all have it (each covered below for all three entries):
//      200 health (GET /healthz); HEAD /healthz (no body); 404 of an unmatched route (GET and
//      OPTIONS); 400 / 20001 of request validation; 500 of an uncaught exception in a
//      controller; errors raised before validation while reading the body (malformed JSON 400,
//      unsupported content type 415).
// 5. Out of scope: a connection the server aborts without any response (idempotency
//    outcome_unknown, BR-ID-10 细则) has no header to speak of. Whether browsers may read the
//    header cross-origin (Access-Control-Expose-Headers) is not part of this task. Declaring the
//    header in contracts/openapi.yaml belongs to the contract lane (OpenAPI allows undeclared
//    response headers).
// 6. Idempotent replay (待编排会话确认, not tested here: no HTTP route uses platform/idempotency
//    yet): a replay returns the stored body byte for byte, whose `trace_id` is the FIRST
//    request's. Suggested default: the header is still the id of the CURRENT request (rule 2's
//    log equality holds; the body equality does not apply to a replayed body).
//
// The routes beyond /healthz come from a probe controller added to AppModule for these tests
// (the decorators are applied as plain function calls, since the `test` TypeScript project has no
// decorator support); one application per entry is shared by all tests of this file.
//
// Top-level it() only (规划/11 §4.3).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterAll, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { routeSchemaOf } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { SAMPLES, capture, parseStrict } from '../masking/kit.ts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_LOWER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UUID_UPPER = 'C56A4180-65AA-42EC-A945-5FD21DEC0538';
const HEX_MIXED = '7d444840A9DC4f2e8d7b1b0c6e5f4A39';

type Entry = 'api' | 'stream' | 'admin';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin'];

type Method = 'GET' | 'HEAD' | 'OPTIONS' | 'POST';

interface InjectRequest {
  method: Method;
  url: string;
  headers: Record<string, string | string[]>;
  payload?: string;
}

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: InjectRequest): Promise<InjectResponse>;
}

type CreateHttpApp = (
  entry: Entry,
  overrides: { logger: RootLogger; config: ReturnType<typeof loadConfig> },
) => Promise<HttpApp>;

type ClassDecoratorFn = (target: abstract new (...args: never[]) => unknown) => void;
type MethodDecoratorFn = (target: object, key: string, descriptor: PropertyDescriptor) => void;

interface NestCommon {
  Controller(prefix: string): ClassDecoratorFn;
  Get(path: string): MethodDecoratorFn;
  Post(path: string): MethodDecoratorFn;
}

interface NestFastify {
  RouteSchema(schema: unknown): MethodDecoratorFn;
}

interface AppModuleClass {
  forEntry(options: unknown): Record<string, unknown>;
}

const BOOTSTRAP = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;
const APP_MODULE = new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href;
const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));

async function importFromApi<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(apiRequire.resolve(name)).href)) as T;
}

/** A controller with an uncaught exception, a validated query and a JSON body route. */
async function probeController(): Promise<abstract new (...args: never[]) => unknown> {
  const common = await importFromApi<NestCommon>('@nestjs/common');
  const fastify = await importFromApi<NestFastify>('@nestjs/platform-fastify');
  class TraceProbe {
    crash(): never {
      throw new Error('trace probe failure');
    }

    checked(): unknown {
      return { ok: true };
    }

    echo(): unknown {
      return { ok: true };
    }
  }
  const method = (name: keyof TraceProbe, ...decorators: MethodDecoratorFn[]): void => {
    const descriptor = Object.getOwnPropertyDescriptor(TraceProbe.prototype, name);
    if (descriptor === undefined) throw new Error(`no method ${name}`);
    for (const decorate of decorators) decorate(TraceProbe.prototype, name, descriptor);
  };
  const checkedSchema = routeSchemaOf({
    operationId: 'traceProbeChecked',
    parameters: [
      { in: 'query', name: 'limit', required: true, schema: { type: 'integer', minimum: 1 } },
    ],
  });
  method('crash', common.Get('crash'));
  method('checked', fastify.RouteSchema(checkedSchema), common.Get('checked'));
  method('echo', common.Post('echo'));
  common.Controller('__trace')(TraceProbe);
  return TraceProbe;
}

interface Shared {
  readonly app: HttpApp;
  readonly lines: string[];
}

const apps = new Map<Entry, Promise<Shared>>();
let building: Promise<unknown> = Promise.resolve();

function sharedApp(entry: Entry): Promise<Shared> {
  let found = apps.get(entry);
  if (found === undefined) {
    // Built one after another: each build swaps AppModule.forEntry once.
    found = building.then(async () => {
      const { AppModule } = (await import(APP_MODULE)) as { AppModule: AppModuleClass };
      const { createHttpApp } = (await import(BOOTSTRAP)) as { createHttpApp: CreateHttpApp };
      const controller = await probeController();
      const original = AppModule.forEntry.bind(AppModule);
      const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
        const module = original(options);
        const controllers = (module['controllers'] ?? []) as unknown[];
        return { ...module, controllers: [...controllers, controller] };
      });
      const { logger, lines } = capture();
      try {
        const app = await createHttpApp(entry, {
          logger,
          config: loadConfig({ APP_ENV: 'test' }),
        });
        await app.init();
        return { app, lines };
      } finally {
        spy.mockRestore();
      }
    });
    building = found.catch(() => undefined);
    apps.set(entry, found);
  }
  return found;
}

afterAll(async () => {
  for (const app of apps.values()) await (await app).app.close();
});

interface Exchange {
  readonly entry: Entry;
  readonly statusCode: number;
  readonly body: string;
  /** The response header as received: undefined when missing. */
  readonly header: unknown;
  readonly headers: Record<string, unknown>;
  /** reqId of the "incoming request" and "request completed" lines of this request. */
  readonly reqId: string;
}

async function exchange(
  entry: Entry,
  method: Method,
  url: string,
  options: { traceHeader?: string | string[]; contentType?: string; payload?: string } = {},
): Promise<Exchange> {
  const { app, lines } = await sharedApp(entry);
  const start = lines.length;
  const headers: Record<string, string | string[]> = {};
  if (options.traceHeader !== undefined) headers['x-trace-id'] = options.traceHeader;
  if (options.contentType !== undefined) headers['content-type'] = options.contentType;
  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  const access = lines
    .slice(start)
    .map((line) => parseStrict(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === 'incoming request' || line['msg'] === 'request completed');
  const reqIds = access.map((line) => line['reqId']);
  expect({ entry, method, url, msgs: access.map((line) => line['msg']) }).toEqual({
    entry,
    method,
    url,
    msgs: ['incoming request', 'request completed'],
  });
  expect({ entry, method, url, same: reqIds[0] === reqIds[1] }).toEqual({
    entry,
    method,
    url,
    same: true,
  });
  return {
    entry,
    statusCode: response.statusCode,
    body: response.body,
    header: response.headers['x-trace-id'],
    headers: response.headers,
    reqId: String(reqIds[0]),
  };
}

/** The header is present once and equals the request id (the access-log reqId). */
function expectHeaderIsRequestId(result: Exchange, label: string): void {
  expect({ entry: result.entry, label, header: result.header }).toStrictEqual({
    entry: result.entry,
    label,
    header: result.reqId,
  });
}

function traceIdOf(result: Exchange): unknown {
  return (parseStrict(result.body) as { trace_id?: unknown }).trace_id;
}

it('[规划/02 §13][规划/04 §5][规划/03 §4.2] api、stream、admin 三个入口的健康检查 200：响应头 x-trace-id 只有一个值，等于响应体 trace_id 与访问日志两行的 reqId；合格的请求头（小写、大写 UUID，32 位大小写混合十六进制）原样回传，不改大小写', async () => {
  for (const entry of ENTRIES) {
    for (const sent of [UUID_LOWER, UUID_UPPER, HEX_MIXED]) {
      const result = await exchange(entry, 'GET', '/healthz', { traceHeader: sent });
      expect(result.statusCode).toBe(200);
      expectHeaderIsRequestId(result, sent);
      expect({ entry, sent, header: result.header, body: traceIdOf(result) }).toStrictEqual({
        entry,
        sent,
        header: sent,
        body: sent,
      });
    }
  }
}, 30_000);

it('[规划/02 §13][规划/04 §5] 三个入口：不带 x-trace-id、或带不被采用的值（手机号、旧格式示例 trace-abc_123、重复的两个合格头）时，响应头是新生成的那个 v4 UUID，与响应体 trace_id、访问日志 reqId 相同，每次请求不同，且不回传请求头里的原值', async () => {
  const seen: string[] = [];
  for (const entry of ENTRIES) {
    const cases: Record<string, string | string[] | undefined> = {
      missing: undefined,
      missingAgain: undefined,
      phone: SAMPLES.phone,
      oldFormat: 'trace-abc_123',
      doubled: [UUID_LOWER, UUID_UPPER],
    };
    for (const [label, sent] of Object.entries(cases)) {
      const result = await exchange(
        entry,
        'GET',
        '/healthz',
        sent === undefined ? {} : { traceHeader: sent },
      );
      expect(result.statusCode).toBe(200);
      expectHeaderIsRequestId(result, label);
      const header = String(result.header);
      expect({ entry, label, v4: V4.test(header), body: traceIdOf(result) }).toStrictEqual({
        entry,
        label,
        v4: true,
        body: header,
      });
      const sentValues = sent === undefined ? [] : [sent].flat();
      const echoed = Object.values(result.headers)
        .flat()
        .map(String)
        .filter((value) =>
          sentValues.some((one) => value.toLowerCase().includes(one.toLowerCase())),
        );
      expect({ entry, label, echoed }).toEqual({ entry, label, echoed: [] });
      seen.push(header);
    }
  }
  expect(new Set(seen).size).toBe(seen.length);
}, 30_000);

it('[规划/02 §13][规划/04 §5] 三个入口：未匹配路由的 404（GET 与 OPTIONS）也带响应头 x-trace-id，等于访问日志 reqId；合格请求头原样、不合格的换成新 UUID', async () => {
  for (const entry of ENTRIES) {
    const requests: [Method, string, string | undefined][] = [
      ['GET', '/no-such-route', UUID_UPPER],
      ['GET', `/${SAMPLES.cardNo}`, SAMPLES.phone],
      ['GET', '/no-such-route', undefined],
      ['OPTIONS', '/healthz', HEX_MIXED],
      ['OPTIONS', '/healthz', undefined],
    ];
    for (const [method, url, sent] of requests) {
      const result = await exchange(
        entry,
        method,
        url,
        sent === undefined ? {} : { traceHeader: sent },
      );
      const label = `${method} ${url} ${String(sent)}`;
      expect({ label, status: result.statusCode }).toEqual({ label, status: 404 });
      expectHeaderIsRequestId(result, label);
      if (sent === UUID_UPPER || sent === HEX_MIXED) {
        expect({ label, header: result.header }).toEqual({ label, header: sent });
      } else {
        expect({ label, v4: V4.test(String(result.header)) }).toEqual({ label, v4: true });
      }
    }
  }
}, 30_000);

it('[规划/02 §13][规划/04 §5 §7 20001] 三个入口：请求校验失败（HTTP 400、code 20001）的响应头 x-trace-id 等于响应体 trace_id 与访问日志 reqId；合格请求头原样、不合格的换成新 UUID', async () => {
  for (const entry of ENTRIES) {
    for (const sent of [UUID_LOWER, 'trace-abc_123', undefined]) {
      const result = await exchange(
        entry,
        'GET',
        '/__trace/checked?limit=0',
        sent === undefined ? {} : { traceHeader: sent },
      );
      const label = String(sent);
      expect({ label, status: result.statusCode }).toEqual({ label, status: 400 });
      expectHeaderIsRequestId(result, label);
      expect({ label, body: parseStrict(result.body) }).toStrictEqual({
        label,
        body: {
          code: 20001,
          msg: '参数校验失败',
          data: { fields: ['limit'] },
          trace_id: result.header,
        },
      });
      if (sent === UUID_LOWER) {
        expect(result.header).toBe(sent);
      } else {
        expect({ label, v4: V4.test(String(result.header)) }).toEqual({ label, v4: true });
      }
    }
  }
}, 30_000);

it('[规划/02 §13][规划/04 §5] 三个入口：控制器抛出未捕获异常（HTTP 500）的响应也带响应头 x-trace-id，等于访问日志 reqId；合格请求头原样', async () => {
  for (const entry of ENTRIES) {
    for (const sent of [UUID_UPPER, SAMPLES.phone, undefined]) {
      const result = await exchange(
        entry,
        'GET',
        '/__trace/crash',
        sent === undefined ? {} : { traceHeader: sent },
      );
      const label = String(sent);
      expect({ label, status: result.statusCode }).toEqual({ label, status: 500 });
      expectHeaderIsRequestId(result, label);
      if (sent === UUID_UPPER) {
        expect(result.header).toBe(sent);
      } else {
        expect({ label, v4: V4.test(String(result.header)) }).toEqual({ label, v4: true });
      }
    }
  }
}, 30_000);

it('[规划/02 §13][规划/04 §5] 三个入口：读请求体时就失败的请求（JSON 格式错误 400、不支持的 Content-Type 415）与没有响应体的 HEAD /healthz 也带响应头 x-trace-id，等于访问日志 reqId', async () => {
  for (const entry of ENTRIES) {
    const malformed = await exchange(entry, 'POST', '/__trace/echo', {
      traceHeader: UUID_LOWER,
      contentType: 'application/json',
      payload: '{"broken":',
    });
    expect({ entry, status: malformed.statusCode }).toEqual({ entry, status: 400 });
    expectHeaderIsRequestId(malformed, 'malformed json');
    expect(malformed.header).toBe(UUID_LOWER);

    const unsupported = await exchange(entry, 'POST', '/__trace/echo', {
      contentType: 'text/x-trace-probe',
      payload: 'plain words',
    });
    expect({ entry, status: unsupported.statusCode }).toEqual({ entry, status: 415 });
    expectHeaderIsRequestId(unsupported, 'unsupported media type');
    expect({ entry, v4: V4.test(String(unsupported.header)) }).toEqual({ entry, v4: true });

    for (const sent of [HEX_MIXED, undefined]) {
      const head = await exchange(
        entry,
        'HEAD',
        '/healthz',
        sent === undefined ? {} : { traceHeader: sent },
      );
      const label = `HEAD ${String(sent)}`;
      expect({ label, status: head.statusCode, body: head.body }).toEqual({
        label,
        status: 200,
        body: '',
      });
      expectHeaderIsRequestId(head, label);
      if (sent !== undefined) expect(head.header).toBe(sent);
    }
  }
}, 30_000);
