// Real stream assembly; URL imports keep decorated Nest sources out of test/tsconfig.json.
// No test installs a deletion guard. The spy records RiskModule's options and calls the original.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Access from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type { DeletionStageChecks } from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import { NOW, ROOT, user } from '../deletion-guard/kit.ts';
import { envelopeValidator } from '../../platform/errors/kit.ts';

export const WRITE = '/v1/agent/sessions';
export const READ = '/v1/agent/sessions/current';
export interface AssemblyOptions {
  beforeRateLimit?: {
    inject?: unknown[];
    useFactory: (...args: DeletionStageChecks[]) => unknown[];
  };
  beforeRateLimitGuards?: {
    inject?: unknown[];
    useFactory: (...args: DeletionStageChecks[]) => DeletionStageChecks['guard'][];
  };
}
export interface Response {
  statusCode: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}

export async function modules() {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as {
    RiskModule: { forRoot(options: AssemblyOptions): unknown };
  };
  const identity = (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as {
    DELETION_STAGE_CHECKS: symbol;
  };
  return { platform, risk, identity };
}

export async function openStream(db: Kysely<DB>) {
  const { platform, risk, identity } = await modules();
  const validateEnvelope = await envelopeValidator();
  const clock = new platform.FixedClock(NOW);
  const logger = platform.createRootLogger({ level: 'silent', entry: 'stream', appEnv: 'test' });
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'stream', overrides: object): Promise<App>;
  };
  const tokenModule = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as { TOKEN_SERVICE: symbol };
  const spy = vi.spyOn(risk.RiskModule, 'forRoot');
  let app: App | undefined;
  try {
    app = await boot.createHttpApp('stream', {
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      startQueue: false,
    });
    await app.init();
    return {
      app,
      clock,
      db,
      options: spy.mock.calls[0]?.[0],
      deletionToken: identity.DELETION_STAGE_CHECKS,
      tokens: app.get<Access.TokenService>(tokenModule.TOKEN_SERVICE),
      validateEnvelope,
    };
  } catch (error) {
    await app?.close();
    throw error;
  } finally {
    spy.mockRestore();
  }
}
export type Fixture = Awaited<ReturnType<typeof openStream>>;

/** Synthetic DB fixtures, but access-token signing and stream token verification are real. */
export async function member(f: Fixture) {
  const appId = `ds_${randomBytes(10).toString('hex')}`;
  const uid = await user(f.db, appId);
  const deviceId = randomUUID();
  await f.db
    .withSchema('app')
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      user_id: uid,
      device_hash: randomBytes(32).toString('hex'),
      id_source: 'idfv',
      platform: 'ios',
      app_version: '2.0.0',
      install_secret_cipher: Buffer.from('synthetic-unused-install-secret'),
      last_seen_at: f.clock.now(),
    })
    .execute();
  // Agent's own availability gate is a deterministic downstream control (30501).
  await f.db
    .withSchema('app')
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: 'agent.enabled',
      value: false,
      updated_by: 'B1-15m',
    })
    .execute();
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const session = await f.db
    .withSchema('app')
    .transaction()
    .execute((trx) =>
      sessions.createSession(trx, { uid, app_id: appId, device_id: deviceId, scp: 'full' }, f),
    );
  return {
    appId,
    uid,
    async send(method: 'GET' | 'POST' = 'POST', path = WRITE, token = session.access_token) {
      const response = await f.app.inject({
        method,
        url: path,
        headers: {
          'x-app-id': appId,
          'x-platform': 'ios',
          'x-channel': 'appstore',
          'x-app-version': '2.0.0',
          'x-device-id': deviceId,
          authorization: `Bearer ${token}`,
        },
      });
      expect(f.validateEnvelope(response.json()), JSON.stringify(f.validateEnvelope.errors)).toBe(
        true,
      );
      return response;
    },
  };
}

export function refused(response: Response, stage: 'cooling' | 'processing') {
  expect(response.statusCode, response.body).toBe(403);
  expect(response.json()).toEqual({
    code: 10007,
    msg: '账号注销处理中',
    data: { stage },
    trace_id: expect.any(String),
  });
}

export function passed(response: Response) {
  // A 404, validation error, bad token or broken caller must not masquerade as a pass.
  expect(response.json()['code'], response.body).toBe(30501);
}
