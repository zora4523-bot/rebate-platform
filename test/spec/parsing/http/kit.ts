import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/inputs/parse';
export const TRACE = '0000000000000000000000000000b07b';
export const HEADERS = {
  'content-type': 'application/json',
  'x-app-id': 'couli',
  'x-platform': 'h5',
  'x-app-version': '1.0.0',
  'x-device-id': 'synthetic-device',
  'x-trace-id': TRACE,
  'x-timestamp': '1791248460',
  'x-nonce': '0'.repeat(32),
  'x-sign': '0'.repeat(64),
};

export interface Response {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  json<T = Record<string, unknown>>(): T;
}

export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<Response>;
}

export async function buildApp(lines: string[]): Promise<HttpApp> {
  const options = {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T01:01:00.000Z'),
    logger: createRootLogger(
      { level: 'info', entry: 'api', appEnv: 'test' },
      {
        write: (line: string) => {
          lines.push(line);
        },
      },
    ),
  };
  // Dynamic URL keeps Nest's decorated controllers out of the spec project's TS compilation.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', overrides: typeof options): Promise<HttpApp>;
  };
  const app = await createHttpApp('api', options);
  await app.init();
  return app;
}

export async function contract() {
  const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{
      paths: Record<
        string,
        {
          post: {
            operationId: string;
            'x-auth': string;
            'x-implementation'?: string;
            requestBody: { content: Record<string, { schema: JsonSchema }> };
            responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
          };
        }
      >;
    }>;
  };
  const document = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)));
  const operation = document.paths[PATH]!.post;
  const compile = createValidatorCompiler();
  return {
    operation,
    validate: compile({
      schema: operation.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
    validateError: compile({
      schema: operation.responses['4XX']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
  };
}

export function validResponse(response: Response, schemas: Awaited<ReturnType<typeof contract>>) {
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    code: number;
    trace_id: string;
    data: {
      results: {
        hit: { platform: string; kind: string; raw: string };
        card?: Record<string, unknown>;
        error_code?: number;
      }[];
    };
  }>();
  expect(schemas.validate(body), JSON.stringify(schemas.validate.errors)).toBe(true);
  expect(body.code).toBe(0);
  expect(body.trace_id).toBe(TRACE);
  expect(response.headers['x-trace-id']).toBe(TRACE);
  return body.data.results;
}
