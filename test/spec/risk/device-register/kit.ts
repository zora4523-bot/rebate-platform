import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  createDeviceRegistrationRisk,
  type DeviceRegistrationAdmission,
  type DeviceRegistrationRiskOptions,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { buildApp, type Response } from '../../identity/sms-codes/http-kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import { openKit, closeKit } from '../../identity/registration/kit.ts';
import {
  acquire,
  appId,
  apiRequire,
  keys,
  ROOT,
  withRedis,
  type Server,
} from '../rate-limit/kit.ts';
import type { HttpApp } from '../rate-limit/http-kit.ts';

export { acquire, type Server };
export const IP = '192.0.2.71';
export const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
export function admitted(result: DeviceRegistrationAdmission) {
  expect(result.code).toBe(0);
  if (result.code !== 0) throw new Error('unreachable after assertion');
  expect(result.reservation.token).toEqual(expect.any(String));
  return result.reservation;
}
export function refused(result: DeviceRegistrationAdmission, seconds: number) {
  expect(result).toEqual({ code: 42901, retryAfterSec: seconds });
}
export async function withRisk(server: Server, run: (f: RiskFixture) => Promise<void>) {
  await withRedis(server, async (base) => {
    const values = new Map<string, unknown>();
    const reads: string[] = [];
    const key = randomBytes(32);
    const options: DeviceRegistrationRiskOptions = {
      redis: base.handles[0]!,
      clock: base.clock,
      logger: base.options.logger,
      crypto: {
        blindIndex: (value, context) =>
          createHmac('sha256', key).update(`${context}\0${value}`).digest('hex'),
      },
      config: {
        async configValue(app, name) {
          reads.push(`${app}:${name}`);
          return values.has(`${app}:${name}`)
            ? { value: values.get(`${app}:${name}`), version: 1 }
            : null;
        },
      },
    };
    base.clock.set('2031-05-06T09:00:00Z');
    try {
      await run({
        ...base,
        options,
        reads,
        config: (name, value, app = base.app) => {
          values.set(`${app}:${name}`, value);
        },
        service: (overrides = {}) => createDeviceRegistrationRisk({ ...options, ...overrides }),
        keys: () => keys(base.raw, `*${base.app}*`),
      });
    } finally {
      const owned = await keys(base.raw, `*${base.app}*`);
      if (owned.length > 0) await base.raw.call('DEL', ...owned);
    }
  });
}
type Base = Parameters<Parameters<typeof withRedis>[1]>[0];
export interface RiskFixture extends Omit<Base, 'options' | 'service'> {
  options: DeviceRegistrationRiskOptions;
  service(
    overrides?: Partial<DeviceRegistrationRiskOptions>,
  ): ReturnType<typeof createDeviceRegistrationRisk>;
}
export function hotAlerts(lines: string[], app: string, deviceHash: string) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (line) =>
        line['app_id'] === app && line['device_hash'] === deviceHash && line['count'] !== undefined,
    );
}
export function flatPrivate(lines: Record<string, unknown>[], secrets: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(Object.values(line).every((value) => value === null || typeof value !== 'object')).toBe(
      true,
    );
  }
  const text = JSON.stringify(lines);
  expect(text).not.toContain('install_secret');
  for (const secret of secrets) expect(text).not.toContain(secret);
}

export async function openSuite() {
  const kit = await openKit();
  try {
    return { kit, server: await acquire() };
  } catch (error) {
    await closeKit(kit);
    throw error;
  }
}
export async function closeSuite(suite: Awaited<ReturnType<typeof openSuite>> | undefined) {
  if (!suite) return;
  try {
    await suite.server.stop();
  } finally {
    await closeKit(suite.kit);
  }
}
export async function withHttp(
  suite: Awaited<ReturnType<typeof openSuite>>,
  config: Record<string, unknown>,
  run: (f: HttpFixture) => Promise<void>,
) {
  const id = appId();
  const queries: unknown[] = [];
  const db = suite.kit.db.withPlugin({
    transformQuery({ node }) {
      if (node.kind === 'SelectQueryNode') queries.push(node);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  for (const [key, value] of Object.entries(config)) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${id}, ${key}, ${JSON.stringify(value)}::jsonb, 'device-register-rule-test')`.execute(
      db,
    );
  }
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'spec-device-register-'));
  const clock = new FixedClock('2031-05-06T09:00:00Z');
  const { logger, lines } = memoryLogger();
  let app: HttpApp | undefined;
  try {
    // Real AppModule; no replacement guard, controller or risk provider.
    app = (await buildApp(db, dir, suite.server.url, clock, logger)) as HttpApp;
    await app.init();
    const current = app;
    await run({
      app,
      id,
      clock,
      lines,
      queries,
      rows: () =>
        db.withSchema('app').selectFrom('devices').selectAll().where('app_id', '=', id).execute(),
      send: (ip = IP, deviceHash = hash(), appId = id, extra = {}) =>
        current.inject({
          method: 'POST',
          url: '/v1/devices',
          remoteAddress: ip,
          headers: {
            'content-type': 'application/json',
            'x-app-id': appId,
            'x-platform': 'ios',
            'x-app-version': '1.2.3',
            ...extra,
          },
          payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
        }),
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
export interface HttpFixture {
  app: HttpApp;
  id: string;
  clock: FixedClock;
  lines: string[];
  /** Read-only observation of real SQL query nodes, including outcome verification. */
  queries: unknown[];
  rows(): Promise<{ id: string; device_hash: string }[]>;
  send(
    ip?: string,
    deviceHash?: string,
    appId?: string,
    extra?: Record<string, string>,
  ): Promise<Response>;
}
let validators: Promise<ReturnType<typeof compileResponses>> | undefined;
function compileResponses(document: {
  paths: Record<
    string,
    { post: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> } }
  >;
}) {
  const compile = createValidatorCompiler();
  const responses = document.paths['/v1/devices']!.post.responses;
  return {
    success: compile({
      schema: responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
    limited: compile({
      schema: responses['429']!.content['application/json']!.schema,
      httpPart: 'body',
    }),
  };
}
async function validate(response: Response, kind: 'success' | 'limited') {
  validators ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(path: string): Promise<Parameters<typeof compileResponses>[0]>;
    };
    return compileResponses(
      await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT))),
    );
  })();
  const validator = (await validators)[kind];
  expect(validator(response.json())).toBe(true);
  expect(validator.errors ?? []).toEqual([]);
}
export async function registered(response: Response) {
  expect(response.statusCode).toBe(200);
  await validate(response, 'success');
  const body = response.json<{
    code: number;
    data: { device_id: string; install_secret: string };
  }>();
  expect(body.code).toBe(0);
  expect(body.data.device_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.data.install_secret.length).toBeGreaterThan(0);
  return body.data;
}
export async function limited(response: Response, seconds?: number) {
  expect(response.statusCode).toBe(429);
  await validate(response, 'limited');
  expect(response.json()).toMatchObject({ code: 42901 });
  const text = JSON.stringify(response.json());
  expect(text).not.toContain('device_id');
  expect(text).not.toContain('install_secret');
  expect(String(response.headers['retry-after'])).toMatch(/^[1-9][0-9]*$/);
  if (seconds !== undefined) expect(Number(response.headers['retry-after'])).toBe(seconds);
}
