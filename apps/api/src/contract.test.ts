// Contract conformance of the HTTP entries (规划/11 §4.1 契约行, ADR-0001 §4.2 #15, §7):
// - every implemented operationId maps to exactly one api route; planned operations have
//   no registered routes, and every registered route is declared in the contract;
// - real responses validate against the dereferenced response schema with a strict Ajv2020.
import { fileURLToPath } from 'node:url';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { dereference } from '@readme/openapi-parser';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
// openapi-types is the declared peer dependency of @readme/openapi-parser (ADR-0001 §2 契约行):
// the parser's own typings import it, so it is part of that package's baseline.
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpApp } from './bootstrap.ts';
import {
  FixedClock,
  HTTP_ENTRIES,
  type HttpEntry,
  createRootLogger,
  loadConfig,
} from './modules/platform/index.ts';

const CONTRACT_FILE = fileURLToPath(new URL('../../../contracts/openapi.yaml', import.meta.url));
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface ContractOperation {
  readonly operationId: string;
  /** `GET /v1/things/:thing_id` (Fastify path syntax). */
  readonly route: string;
  readonly operation: OpenAPIV3_1.OperationObject;
}

function operationsOf(document: OpenAPIV3_1.Document): ContractOperation[] {
  const operations: ContractOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item?.[method];
      if (operation === undefined) continue;
      operations.push({
        operationId: operation.operationId ?? `(missing operationId: ${method} ${path})`,
        route: `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`,
        operation,
      });
    }
  }
  return operations;
}

function createContractAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajvFormats.default(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value: number) =>
      Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  // JSON numbers above 2^53-1 lose precision: reject them (ADR-0001 §4.2 #3).
  ajv.addFormat('int64', {
    type: 'number',
    validate: (value: number) => Number.isSafeInteger(value),
  });
  return ajv;
}

function jsonSchemaOf(operation: OpenAPIV3_1.OperationObject, status: string): object {
  const response = operation.responses?.[status] as OpenAPIV3_1.ResponseObject | undefined;
  const schema = response?.content?.['application/json']?.schema;
  if (schema === undefined) throw new Error(`no application/json schema for status ${status}`);
  return schema;
}

/** Builds an entry and records every route Fastify registers for it. */
async function buildWithRoutes(
  entry: HttpEntry,
): Promise<{ app: NestFastifyApplication; routes: string[] }> {
  const app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-01T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  });
  const routes: string[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, routes };
}

/** Fastify adds a HEAD route for every GET route; those are not separate operations. */
function withoutImplicitHead(routes: readonly string[], declared: ReadonlySet<string>): string[] {
  return routes.filter((route) => {
    if (!route.startsWith('HEAD ') || declared.has(route)) return true;
    return !routes.includes(`GET ${route.slice('HEAD '.length)}`);
  });
}

function routeConformanceErrors(
  operations: readonly ContractOperation[],
  entries: ReadonlyMap<HttpEntry, readonly string[]>,
): string[] {
  const errors: string[] = [];
  const declared = new Set(operations.map((operation) => operation.route));
  const registered = new Set<string>();
  for (const entry of HTTP_ENTRIES) {
    const routes = withoutImplicitHead(entries.get(entry) ?? [], declared);
    if (new Set(routes).size !== routes.length) errors.push(`${entry}: duplicate routes`);
    for (const route of routes) {
      if (!declared.has(route)) errors.push(`${entry}: undeclared route ${route}`);
      registered.add(route);
    }
  }
  const apiRoutes = withoutImplicitHead(entries.get('api') ?? [], declared);
  for (const { operationId, route, operation } of operations) {
    if ('x-implementation' in operation) {
      if (operation['x-implementation'] !== 'planned') {
        errors.push(`${operationId}: x-implementation must be planned`);
      } else if (registered.has(route)) {
        errors.push(`${operationId}: planned route is registered`);
      }
    } else if (apiRoutes.filter((registeredRoute) => registeredRoute === route).length !== 1) {
      errors.push(`${operationId}: expected exactly one api route`);
    }
  }
  return errors;
}

it('[AC-CT-02a#1] accepts implemented or planned operations and rejects registered planned routes and invalid markers', () => {
  const document = (extension: { 'x-implementation'?: unknown } = {}): OpenAPIV3_1.Document => ({
    openapi: '3.1.0',
    info: { title: 'Route conformance fixture', version: '1.0.0' },
    paths: {
      '/v1/things/{thing_id}': {
        get: {
          operationId: 'getThing',
          responses: { '200': { description: 'OK' } },
          ...extension,
        },
      },
    },
  });
  const implemented = operationsOf(document());
  const planned = operationsOf(document({ 'x-implementation': 'planned' }));
  const routes = ['GET /v1/things/:thing_id', 'HEAD /v1/things/:thing_id'] as const;
  expect(routeConformanceErrors(implemented, new Map([['api', routes]]))).toEqual([]);
  expect(routeConformanceErrors(planned, new Map())).toEqual([]);
  for (const entry of HTTP_ENTRIES) {
    expect(routeConformanceErrors(planned, new Map([[entry, routes]]))).toEqual([
      'getThing: planned route is registered',
    ]);
  }
  for (const value of ['implemented', '', null, undefined, true, 1, [], {}]) {
    const invalid = operationsOf(document({ 'x-implementation': value }));
    expect(routeConformanceErrors(invalid, new Map([['api', routes]]))).toEqual([
      'getThing: x-implementation must be planned',
    ]);
  }
  expect(routeConformanceErrors(implemented, new Map([['admin', routes]]))).toEqual([
    'getThing: expected exactly one api route',
  ]);
  expect(routeConformanceErrors(implemented, new Map([['api', [...routes, routes[0]]]]))).toEqual([
    'api: duplicate routes',
    'getThing: expected exactly one api route',
  ]);
  expect(routeConformanceErrors(planned, new Map([['stream', ['POST /undeclared']]]))).toEqual([
    'stream: undeclared route POST /undeclared',
  ]);
});

describe('contracts/openapi.yaml', () => {
  let document: OpenAPIV3_1.Document;
  let operations: ContractOperation[];
  const apps = new Map<HttpEntry, { app: NestFastifyApplication; routes: string[] }>();

  beforeAll(async () => {
    document = await dereference<OpenAPIV3_1.Document>(CONTRACT_FILE);
    operations = operationsOf(document);
    for (const entry of HTTP_ENTRIES) apps.set(entry, await buildWithRoutes(entry));
  });

  afterAll(async () => {
    for (const { app } of apps.values()) await app.close();
  });

  it('is an OAS 3.1 document whose operations all have unique operationIds', () => {
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(operations.length).toBeGreaterThan(0);
    const ids = operations.map((operation) => operation.operationId);
    expect(ids.filter((id) => id.startsWith('(missing'))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('[AC-CT-02a#2] maps implemented operations to exactly one api route, forbids planned routes and rejects undeclared routes', () => {
    const entries = new Map([...apps].map(([entry, { routes }]) => [entry, routes] as const));
    expect(routeConformanceErrors(operations, entries)).toEqual([]);
  });

  it.each(HTTP_ENTRIES)(
    'getHealthz response of the %s entry validates against the contract',
    async (entry) => {
      const operation = operations.find((candidate) => candidate.operationId === 'getHealthz');
      if (operation === undefined) throw new Error('getHealthz is missing from the contract');
      const validate = createContractAjv().compile(jsonSchemaOf(operation.operation, '200'));
      const app = apps.get(entry)?.app;
      if (app === undefined) throw new Error(`entry ${entry} was not built`);

      const response = await app.inject({ method: 'GET', url: '/healthz' });
      const valid = validate(response.json());
      expect(validate.errors ?? []).toEqual([]);
      expect(valid).toBe(true);
      expect(response.statusCode).toBe(200);
    },
  );

  it('the validator is strict: extra fields, wrong enums and unsafe integers are rejected', () => {
    const operation = operations.find((candidate) => candidate.operationId === 'getHealthz');
    if (operation === undefined) throw new Error('getHealthz is missing from the contract');
    const ajv = createContractAjv();
    const validate = ajv.compile(jsonSchemaOf(operation.operation, '200'));
    const good = {
      code: 0,
      msg: '',
      data: { status: 'ok', entry: 'worker', now: '2026-10-01T12:00:00+08:00' },
      trace_id: 'abc',
    };
    expect(validate(good)).toBe(true);
    expect(validate({ ...good, extra: 1 })).toBe(false);
    expect(validate({ ...good, code: 1 })).toBe(false);
    expect(validate({ ...good, data: { ...good.data, entry: 'cron' } })).toBe(false);
    expect(validate({ ...good, data: { ...good.data, now: '2026-10-01 12:00:00' } })).toBe(false);
    expect(validate({ ...good, data: { ...good.data, extra: true } })).toBe(false);
    expect(validate({ ...good, trace_id: 'has space' })).toBe(false);

    const amount = ajv.compile({ type: 'integer', format: 'int64' });
    expect(amount(2 ** 53 - 1)).toBe(true);
    expect(amount(2 ** 53)).toBe(false);
    const small = ajv.compile({ type: 'integer', format: 'int32' });
    expect(small(2 ** 31 - 1)).toBe(true);
    expect(small(-(2 ** 31))).toBe(true);
    expect(small(2 ** 31)).toBe(false);
    // Strict mode refuses schemas with unknown keywords or formats instead of ignoring them.
    expect(() => ajv.compile({ type: 'string', format: 'no-such-format' })).toThrow(/format/);
    expect(() => ajv.compile({ type: 'object', 'x-unknown': true })).toThrow(/strict mode/);
  });
});
