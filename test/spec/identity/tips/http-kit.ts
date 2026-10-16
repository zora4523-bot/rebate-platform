import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { seedUser } from '../registration/kit.ts';
import { openSuite, closeSuite, type Suite } from '../session/kit.ts';
import { buildApp, type HttpApp, type Response } from '../sms-codes/http-kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
export const NOW = '2031-05-06T07:08:09.123Z';
export const TIPS = '/v1/me/tips';
export const READ = '/v1/me/tips/{tip_key}/read';
export const RESET = '/v1/me/tips/{tip_key}';
export type Method = 'GET' | 'POST' | 'DELETE';
type App = Omit<HttpApp, 'inject'> & {
  inject(options: {
    method: Method;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
};
type ClockModule = typeof import('../../../../apps/api/src/modules/platform/clock/index.ts');
type ValidatorModule =
  typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type Contract = {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
      }
    >
  >;
};
export interface Kit {
  suite: Suite;
  app: App;
  dir: string;
  clock: InstanceType<ClockModule['FixedClock']>;
  document: Contract;
  compile: ReturnType<ValidatorModule['createValidatorCompiler']>;
}

export async function openKit(): Promise<Kit> {
  // openSuite -> createTestDatabase reads TEST_PG_ADMIN_URL; no hard-coded database address.
  const suite = await openSuite();
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02s-'));
  let app: App | undefined;
  try {
    const { FixedClock } = (await import(
      new URL('apps/api/src/modules/platform/clock/index.ts', ROOT).href
    )) as ClockModule;
    const { createValidatorCompiler } = (await import(
      new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
    )) as ValidatorModule;
    const clock = new FixedClock(NOW);
    app = (await buildApp(suite.db, dir, suite.server.url, clock, memoryLogger().logger)) as App;
    await app.init();
    const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
    const parser = requireApi('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return { suite, app, dir, clock, document, compile: createValidatorCompiler() };
  } catch (error) {
    await app?.close();
    await closeSuite(suite);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeKit(kit: Kit | undefined): Promise<void> {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    try {
      await closeSuite(kit.suite);
    } finally {
      rmSync(kit.dir, { recursive: true, force: true });
    }
  }
}

export async function client(kit: Kit, appId: string, uid: string) {
  const headers = {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const { device_id } = created.json<{ data: { device_id: string } }>().data;
  const { TOKEN_SERVICE } = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as { TOKEN_SERVICE: symbol };
  const { createSession } = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  const tokens = kit.app.get<Parameters<typeof createSession>[2]['tokens']>(TOKEN_SERVICE);
  const session = await kit.suite.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: appId, device_id, scp: 'full' },
        { clock: kit.clock, tokens },
      ),
    );
  return {
    deviceId: device_id,
    sid: session.sid,
    async request(
      method: Method,
      url: string,
      body?: unknown,
      options: { guest?: boolean; headers?: Record<string, string> } = {},
    ) {
      return kit.app.inject({
        method,
        url,
        headers: {
          ...headers,
          'x-device-id': device_id,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.guest ? {} : { authorization: `Bearer ${session.access_token}` }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    },
  };
}

export async function fixture(kit: Kit, existingApp?: string) {
  kit.clock.set(NOW);
  const appId = existingApp ?? `tips_${randomBytes(12).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  if (existingApp === undefined) {
    await db
      .insertInto('app_versions')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform: 'ios',
        channel: 'appstore',
        latest_version: '2.0.0',
        min_supported_version: '2.0.0',
        update_title: 'test',
        update_notes: 'test',
        store_url: 'https://example.test/app',
        default_store: 'appstore',
        store_listings: JSON.stringify([]),
      })
      .execute();
  }
  const uid = await seedUser(db, appId);
  const device = await client(kit, appId, uid);
  return {
    appId,
    uid,
    db,
    device,
    rows: () =>
      db
        .selectFrom('user_tip_reads')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', uid)
        .orderBy('tip_key')
        .orderBy('platform')
        .execute(),
    get: () => device.request('GET', TIPS),
    mark: (tip: string, body?: unknown) => device.request('POST', `${TIPS}/${tip}/read`, body),
    reset: (tip = 'jump_tip') => device.request('DELETE', `${TIPS}/${tip}`),
  };
}

export function envelope(
  kit: Kit,
  method: Method,
  path: string,
  response: Response,
  code = 0,
): unknown {
  expect(response.statusCode).toBe(
    code === 0 ? 200 : code === 10001 ? 401 : code === 10405 ? 403 : 400,
  );
  const body = response.json<{ code: number; data: unknown }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const schema =
    kit.document.paths[path]![method.toLowerCase()]!.responses[code === 0 ? '200' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}

export function accepted(kit: Kit, method: 'POST' | 'DELETE', response: Response): void {
  expect(envelope(kit, method, method === 'POST' ? READ : RESET, response)).toEqual({});
}

export function states(kit: Kit, response: Response): Schema<'TipsData'> {
  return envelope(kit, 'GET', TIPS, response) as Schema<'TipsData'>;
}

export function at(value: string | null | undefined, instant = NOW): void {
  expect(typeof value).toBe('string');
  expect(Date.parse(value!)).toBe(Date.parse(instant));
}
