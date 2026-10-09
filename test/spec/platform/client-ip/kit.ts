import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { HttpApp } from '../../risk/rate-limit/http-kit.ts';

export const GATEWAY = '198.51.100.10';
export const CLIENT_A = '203.0.113.5';
export const CLIENT_B = '203.0.113.6';
export const TRUSTED = '198.51.100.0/24';

type Entry = 'api' | 'stream' | 'admin';
interface Bootstrap {
  createHttpApp(
    entry: Entry,
    options: { config: AppConfig; [key: string]: unknown },
  ): Promise<HttpApp>;
}

// Computed import keeps Nest decorators in the API project's compiler context.
async function bootstrap(): Promise<Bootstrap> {
  return (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as Bootstrap;
}

export function proxyConfig(value?: string): AppConfig {
  return loadConfig({ APP_ENV: 'test', TRUSTED_PROXIES: value });
}

/** Only inject deployment config; never replace Fastify, request.ip or a business consumer. */
export async function withProxyConfig(value: string | undefined, run: () => Promise<void>) {
  const boot = await bootstrap();
  // Optional structural field lets these tests compile before the new config field exists.
  const configured: AppConfig & { readonly trustedProxies?: readonly string[] } =
    proxyConfig(value);
  const original = boot.createHttpApp;
  const spy = vi.spyOn(boot, 'createHttpApp').mockImplementation((entry, options) =>
    original(entry, {
      ...options,
      config: {
        ...options.config,
        ...(configured.trustedProxies === undefined
          ? {}
          : { trustedProxies: configured.trustedProxies }),
      },
    }),
  );
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

/** Correlate the incoming request log, not another request or a response-completion line. */
export function loggedIp(lines: readonly string[], traceId: string, expected: string) {
  const requests = lines
    .map((line) => JSON.parse(line) as { reqId?: string; req?: { remoteAddress?: string } })
    .filter((line) => line.reqId === traceId && line.req !== undefined);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.req?.remoteAddress).toBe(expected);
}

interface ContractDocument {
  paths: Record<
    string,
    Record<
      string,
      { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> }
    >
  >;
}
let contract: Promise<ContractDocument> | undefined;
export async function validateResponse(
  path: string,
  method: 'get' | 'post',
  response: Awaited<ReturnType<HttpApp['inject']>>,
) {
  const root = new URL('../../../../', import.meta.url);
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<ContractDocument>;
  };
  contract ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const responses = (await contract).paths[path]?.[method]?.responses;
  const match =
    responses?.[String(response.statusCode)] ??
    responses?.[`${Math.floor(response.statusCode / 100)}XX`];
  const schema = match?.content['application/json']?.schema;
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

export async function withEntry(
  entry: Entry,
  config: AppConfig,
  run: (app: HttpApp, lines: string[]) => Promise<void>,
) {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'info', entry, appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const boot = await bootstrap();
  const app = await boot.createHttpApp(entry, {
    config,
    logger,
    clock: new FixedClock('2031-05-06T09:00:00Z'),
  });
  try {
    await app.init();
    await run(app, lines);
  } finally {
    await app.close();
  }
}
