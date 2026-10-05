// HTTP fixtures only: decorators are ordinary calls, as in tracing/trace-id-response-header.
// Dynamic imports keep Nest's decorated application sources out of test/tsconfig.json.
// Error log contract: trace_id, error_class and stack (when an Error has a stack).
// error_class is the constructor name for Error, typeof for other values, and 'null' for null.
// Never log request bodies or arbitrary properties of thrown values.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { IdempotencyError } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  routeSchemaOf,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';
// Fastify 5.12.5 reports FST_ERR_CTP_INVALID_JSON_BODY without input excerpts;
// this sentinel keeps non-disclosure covered as a regression requirement.
export const BODY_MARKER = 'ZaRawQ';
export const ERROR_MARKER = 'private-error-property-za';
export type Entry = 'api' | 'stream' | 'admin';
export const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin'];

interface Request {
  readonly id: string;
  readonly params: { readonly kind: string };
}

type Constructor = abstract new (...args: never[]) => unknown;
type MethodDecoratorFn = (target: object, key: string, descriptor: PropertyDescriptor) => void;
interface NestCommon {
  Controller(prefix: string): (target: Constructor) => void;
  Post(path: string): MethodDecoratorFn;
  Req(): (target: object, key: string, index: number) => void;
  UseGuards(guard: {
    canActivate(context: { switchToHttp(): { getRequest(): Request } }): boolean;
  }): MethodDecoratorFn;
  HttpException: new (body: unknown, status: number) => Error;
}

export interface Response {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}
export interface InjectRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: string;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: InjectRequest): Promise<Response>;
}
interface AppModuleClass {
  forEntry(options: unknown): Record<string, unknown>;
}
type CreateHttpApp = (
  entry: Entry,
  overrides: { logger: RootLogger; config: ReturnType<typeof loadConfig>; clock: FixedClock },
) => Promise<HttpApp>;

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
async function importFromApi<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(apiRequire.resolve(name)).href)) as T;
}

export function businessBody(traceId: string): object {
  return {
    code: 20001,
    msg: '业务校验原文',
    data: { fields: ['device_hash'] },
    trace_id: traceId,
  };
}

async function probeController(): Promise<Constructor> {
  const common = await importFromApi<NestCommon>('@nestjs/common');
  const fastify = await importFromApi<{ RouteSchema(schema: unknown): MethodDecoratorFn }>(
    '@nestjs/platform-fastify',
  );
  function fail(request: Request): never {
    switch (request.params.kind) {
      case 'error':
        throw Object.assign(new TypeError('probe failure'), { privateDetail: ERROR_MARKER });
      case 'text':
        throw ERROR_MARKER;
      case 'object':
        throw { privateDetail: ERROR_MARKER };
      case 'status-object':
        // A statusCode/message object is not a business HttpException either.
        throw { statusCode: 404, message: ERROR_MARKER };
      case 'null':
        throw null;
      case 'status':
        // An ordinary Error is not an HttpException, even when shaped like http-errors.
        throw Object.assign(new Error('probe status failure'), {
          statusCode: 418,
          status: 418,
          expose: true,
          privateDetail: ERROR_MARKER,
        });
      case 'business':
        throw new common.HttpException(businessBody(request.id), 400);
      case 'uncertain':
        throw new IdempotencyError('outcome_unknown');
      case 'internal':
        throw new IdempotencyError('invalid_result');
      default:
        throw new Error('unknown probe kind');
    }
  }
  class ErrorProbe {
    parse(): object {
      return { reached: true };
    }
    checked(): object {
      return { reached: true };
    }
    controller(request: Request): never {
      return fail(request);
    }
    guarded(): object {
      return { guardWasBypassed: true };
    }
    serialize(): object {
      return { cannotSerialize: 1n };
    }
  }
  function method(name: keyof ErrorProbe, ...decorators: MethodDecoratorFn[]): void {
    const descriptor = Object.getOwnPropertyDescriptor(ErrorProbe.prototype, name);
    if (descriptor === undefined) throw new Error(`missing probe method ${name}`);
    for (const decorate of decorators) decorate(ErrorProbe.prototype, name, descriptor);
  }
  method('parse', common.Post('parse'));
  method(
    'checked',
    fastify.RouteSchema(
      routeSchemaOf({
        operationId: 'errorProbeChecked',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['device_hash'],
                additionalProperties: false,
                properties: { device_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
              },
            },
          },
        },
      }),
    ),
    common.Post('checked'),
  );
  common.Req()(ErrorProbe.prototype, 'controller', 0);
  method('controller', common.Post('controller/:kind'));
  method(
    'guarded',
    common.UseGuards({
      canActivate(context): boolean {
        return fail(context.switchToHttp().getRequest());
      },
    }),
    common.Post('guard/:kind'),
  );
  method('serialize', common.Post('serialize'));
  common.Controller('__errors_za')(ErrorProbe);
  return ErrorProbe;
}

export async function withApp(
  entry: Entry,
  check: (app: HttpApp, lines: string[]) => Promise<void>,
): Promise<void> {
  const moduleUrl = new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href;
  const bootstrapUrl = new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href;
  const { AppModule } = (await import(moduleUrl)) as { AppModule: AppModuleClass };
  const { createHttpApp } = (await import(bootstrapUrl)) as { createHttpApp: CreateHttpApp };
  const controller = await probeController();
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return {
      ...module,
      controllers: [...((module['controllers'] ?? []) as unknown[]), controller],
    };
  });
  const lines: string[] = [];
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp(entry, {
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2026-10-05T04:00:00Z'),
      logger: createRootLogger(
        { level: 'trace', entry, appEnv: 'test' },
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

export function request(
  path: string,
  payload = '{}',
  contentType = 'application/json',
): InjectRequest {
  return {
    method: 'POST',
    url: `/__errors_za/${path}`,
    headers: { 'x-trace-id': TRACE, 'content-type': contentType },
    payload,
  };
}

// Independent response validator: load the actual contract, never the implementation's envelope
// factory/validator. No coercion, defaults or removeAdditional: extra keys must fail.
type Validate = ((value: unknown) => boolean) & { errors?: unknown };
interface Ajv {
  addFormat(name: string, format: { type: string; validate(value: number): boolean }): void;
  compile(schema: JsonSchema): Validate;
}
export async function envelopeValidator(): Promise<Validate> {
  const parser = await importFromApi<{
    dereference(
      path: string,
      options: object,
    ): Promise<{
      components: { schemas: { ErrorEnvelope: JsonSchema } };
    }>;
  }>('@readme/openapi-parser');
  const document = await parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
    Ajv2020: new (options: object) => Ajv;
  };
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31,
  });
  return ajv.compile(document.components.schemas.ErrorEnvelope);
}

export function expectEnvelope(
  response: Response,
  validate: Validate,
  code: 20001 | 50001,
  label: string,
  fields?: readonly string[],
  statusCode?: number,
): unknown {
  // Soft assertions let the regression matrix finish even while a new boundary is still red.
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    expect.soft(false, `${label}: response body must be valid JSON`).toBe(true);
  }
  expect.soft(response.statusCode, label).toBe(statusCode ?? (code === 20001 ? 400 : 500));
  expect
    .soft(validate(body), `${label}: ErrorEnvelope ${JSON.stringify(validate.errors)}`)
    .toBe(true);
  expect.soft(body, label).toMatchObject({ code, msg: expect.any(String), trace_id: TRACE });
  expect.soft(response.headers['x-trace-id'], label).toBe(TRACE);
  if (fields !== undefined) expect.soft(body, label).toMatchObject({ data: { fields } });
  return body;
}
