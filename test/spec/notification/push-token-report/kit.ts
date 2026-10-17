// B1-12c: fixture SQL, the real identity session creation (with B1-12b's login binding) and a
// memory logger. No rule of the report lives here: every token write under test goes through
// notification's createPushTokenReporter. Real PostgreSQL through the shared TEST_PG_ADMIN_URL
// harness (registration kit's openKit).
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { bindPushTokensForSession } from '../../../../apps/api/src/modules/notification/application/session-bindings.ts';
import {
  createPushTokenReporter,
  type PushTokenConfigReader,
} from '../../../../apps/api/src/modules/notification/application/push-token-report.ts';
import { openKit, closeKit, seedUser, type Kit } from '../../identity/registration/kit.ts';
import { fixture as tokenFixture } from '../../identity/token/kit.ts';

export { openKit as openSuite, closeKit as closeSuite, seedUser, type Kit as Suite };

export const PROVIDER = 'mobpush';
export const WINDOW_KEY = 'push.token_conflict_window_hours';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DB_TIMEOUT = 60_000;

export interface Actor {
  readonly user_id: string;
  readonly sid: string;
  readonly device_id: string;
}

export function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}

/** Fresh app id per fixture; the Clock starts at 2026-10-05T04:00:00.000Z (token kit). */
export async function fixture(suite: Kit, configured: unknown = undefined) {
  const deps = tokenFixture();
  const clock = deps.clock;
  const db: Kysely<DB> = suite.db;
  const appId = `ptr_${randomUUID().replaceAll('-', '')}`;
  const { logger, lines } = memoryLogger();
  const configCalls: [string, string][] = [];
  const config: PushTokenConfigReader = {
    configValue: async (app, key) => {
      configCalls.push([app, key]);
      return key === WINDOW_KEY && configured !== undefined ? { value: configured } : null;
    },
  };
  const user = (app = appId) => seedUser(db, app);
  /** A device row registered at `registeredAt` (devices.created_at). */
  const device = async (registeredAt: string, app = appId) => {
    const id = randomUUID();
    await db
      .insertInto('devices')
      .values({
        id,
        app_id: app,
        device_hash: createHash('sha256').update(id).digest('hex'),
        id_source: 'idfv',
        install_secret_cipher: Buffer.from('unused-by-push-report-tests'),
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: new Date(registeredAt),
        created_at: new Date(registeredAt),
        updated_at: new Date(registeredAt),
      })
      .execute();
    return id;
  };
  /** Real login (identity createSession + B1-12b binding); sessions.created_at = the Clock. */
  const login = async (deviceId: string, uid?: string, app = appId): Promise<Actor> => {
    const owner = uid ?? (await user(app));
    const issued = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid: owner, app_id: app, device_id: deviceId, scp: 'full' },
          deps,
          (same, session) =>
            bindPushTokensForSession(
              same,
              { app_id: app, user_id: owner, device_id: deviceId, sid: session.sid },
              clock,
            ),
        ),
      );
    return { user_id: owner, sid: issued.sid, device_id: deviceId };
  };
  const seedToken = async (values: {
    device_id: string;
    token: string;
    user_id?: string | null;
    bound_sid?: string | null;
    provider?: string;
    app_id?: string;
    token_set_at?: Date;
    acquired_by_move_at?: Date | null;
    frozen_until?: Date | null;
    revoked_at?: Date | null;
  }) => {
    const id = randomUUID();
    await db
      .insertInto('push_tokens')
      .values({
        id,
        app_id: appId,
        user_id: null,
        bound_sid: null,
        provider: PROVIDER,
        token_set_at: clock.now(),
        acquired_by_move_at: null,
        frozen_until: null,
        revoked_at: null,
        created_at: clock.now(),
        updated_at: clock.now(),
        ...values,
      })
      .execute();
    return id;
  };
  const row = (id: string) =>
    db.selectFrom('push_tokens').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const rowsOf = (deviceId: string, app = appId) =>
    db
      .selectFrom('push_tokens')
      .selectAll()
      .where('app_id', '=', app)
      .where('device_id', '=', deviceId)
      .execute();
  const live = (token: string, provider = PROVIDER, app = appId) =>
    db
      .selectFrom('push_tokens')
      .selectAll()
      .where('app_id', '=', app)
      .where('provider', '=', provider)
      .where('token', '=', token)
      .where('revoked_at', 'is', null)
      .execute();
  const all = () =>
    db.selectFrom('push_tokens').selectAll().where('app_id', '=', appId).orderBy('id').execute();
  const deviceRow = (deviceId: string) =>
    db.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirstOrThrow();
  const reporter = (handle: Kysely<DB> = db) =>
    createPushTokenReporter({ db: handle, clock, logger, config });
  // async: a synchronous throw of the reporter becomes this promise's rejection.
  const report = async (
    actor: Actor,
    token: string,
    provider = PROVIDER,
    handle: Kysely<DB> = db,
  ) =>
    reporter(handle).report({
      app_id: appId,
      user_id: actor.user_id,
      sid: actor.sid,
      device_id: actor.device_id,
      provider,
      token,
    });
  const at = (iso: string) => clock.set(new Date(iso));
  const now = () => clock.now();
  const plus = (ms: number) => new Date(clock.now().getTime() + ms);
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    ...deps,
    clock,
    db,
    appId,
    lines,
    configCalls,
    user,
    device,
    login,
    seedToken,
    row,
    rowsOf,
    live,
    all,
    deviceRow,
    reporter,
    report,
    at,
    now,
    plus,
    logged,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The one own row of a device (unique app_id, device_id, provider). */
export async function ownRow(f: Fixture, deviceId: string) {
  const rows = await f.rowsOf(deviceId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** No log line carries the token value in full. */
export function expectNoTokenText(f: Fixture, token: string) {
  for (const line of f.lines) expect(line.includes(token)).toBe(false);
}

/** The flat log field carrying the token fingerprint (never the token value). */
export const FINGERPRINT = 'token_fingerprint';

/** Log position before an operation: the helpers below only look at lines written after it. */
export function mark(f: Fixture): number {
  return f.lines.length;
}

function namesAll(line: Record<string, unknown>, devices: readonly string[]) {
  const text = JSON.stringify(line);
  return devices.every((id) => text.includes(id));
}

/** A non-empty string fingerprint that does not contain the token value; returned for comparison. */
function expectFingerprint(line: Record<string, unknown>, token: string): string {
  const value = line[FINGERPRINT];
  expect(typeof value).toBe('string');
  const fingerprint = String(value);
  expect(fingerprint.length).toBeGreaterThan(0);
  expect(fingerprint.includes(token)).toBe(false);
  return fingerprint;
}

/**
 * The operation since `since` wrote exactly one PUSH_TOKEN_CONFLICT line and exactly one line
 * naming both device rows, and they are the same warn line (pino level 40) with a token
 * fingerprint; no line carries the token value. Returns the fingerprint.
 */
export function expectConflictEvent(
  f: Fixture,
  devices: readonly string[],
  token: string,
  since = 0,
): string {
  const fresh = f.logged().slice(since);
  const events = fresh.filter((line) => line['code'] === 'PUSH_TOKEN_CONFLICT');
  expect(events).toHaveLength(1);
  const naming = fresh.filter((line) => namesAll(line, devices));
  expect(naming).toHaveLength(1);
  expect(naming[0]).toBe(events[0]);
  const event = events[0]!;
  expect(event['level']).toBe(40);
  expectNoTokenText(f, token);
  return expectFingerprint(event, token);
}

/**
 * The refusal since `since` wrote exactly one line naming both device rows, carrying a token
 * fingerprint; no line carries the token value. Returns the fingerprint.
 */
export function expectRefusalLog(
  f: Fixture,
  devices: readonly string[],
  token: string,
  since = 0,
): string {
  const naming = f
    .logged()
    .slice(since)
    .filter((line) => namesAll(line, devices));
  expect(naming).toHaveLength(1);
  expectNoTokenText(f, token);
  return expectFingerprint(naming[0]!, token);
}
