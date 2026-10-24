// F1-02zzk rule-test fixture (08 BR-ID-28 「推送 token」, BR-ID-30 推送令牌「注销时删除」、站内信
// 180 天、发送记录 190 天; brief §9.2 / §9.3; ruling D10-311 ①). The port under test is
// notification's deletePushTokensForUser, through notification/index.ts only, checked against the
// shape of identity's DeletionCleanupStep. The assembled port is the one app.module really passes
// to IdentityDeletionExpiryModule.forWorker on the worker entry (B1-15g's capture: the module is
// not built by app.module here), resolved in a Nest context that offers the platform tokens only.
// Fixture rows are written directly (synthetic data, couli_app role); the test database is the
// global setup's createTestDatabase, seen here only through a structural type.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type {
  DeletionCleanupInput,
  DeletionCleanupPorts,
  DeletionCleanupStep,
} from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import { deletePushTokensForUser } from '../../../../apps/api/src/modules/notification/index.ts';
import {
  DAY_MS,
  HOUR_MS,
  at,
  capturedWorkerOptions,
  device,
  fieldCrypto,
  identity,
  userRow,
  workerHarness,
  type Member,
  type Ports,
  type Runner,
  type UserRow,
} from '../../identity/deletion-processing/kit.ts';

export {
  CLEANUP_BLOCKED,
  TOMBSTONE_NICKNAME,
  DAY_MS,
  HOUR_MS,
  NOW,
  at,
  compileOnlyDb,
  device,
  fieldCrypto,
  identity,
  member,
  ports,
  processing,
  session,
  userRow,
  warnings,
  workerHarness,
  type CompiledStatement,
  type Member,
  type Ports,
  type Runner,
} from '../../identity/deletion-processing/kit.ts';

/** notification's port, typed as itself; `satisfies` pins identity's DeletionCleanupStep. */
export const deleteTokens = deletePushTokensForUser satisfies DeletionCleanupStep;

export type TokenRow = Selectable<DB['push_tokens']>;

/** The cleanup input of one member at the step's instant (default: the kit's NOW). */
export function inputOf(m: Member, when: Date = at(0)): DeletionCleanupInput {
  return { appId: m.appId, userId: m.uid, at: when };
}

/** A fresh app id of this suite. */
export function newAppId(): string {
  return `nd_${randomBytes(10).toString('hex')}`;
}

// ---- seeding ---------------------------------------------------------------------------------

export interface TokenSeed {
  readonly appId: string;
  readonly deviceId: string;
  /** null: a token unbound from every user (the device's only). */
  readonly userId: string | null;
  readonly provider?: string;
  readonly boundSid?: string | null;
  readonly revokedAt?: Date | null;
  readonly frozenUntil?: Date | null;
}

/** Default: a session sid of its own (no sessions row) for a user's token, none without a user. */
function boundSidOf(seed: TokenSeed): string | null {
  if (seed.boundSid !== undefined) return seed.boundSid;
  return seed.userId === null ? null : `sid_${randomBytes(8).toString('hex')}`;
}

/** A push_tokens row (synthetic token value); returns its id. */
export async function seedToken(db: Kysely<DB>, seed: TokenSeed): Promise<string> {
  const id = randomUUID();
  const setAt = at(-5 * DAY_MS);
  await db
    .withSchema('app')
    .insertInto('push_tokens')
    .values({
      id,
      app_id: seed.appId,
      user_id: seed.userId,
      bound_sid: boundSidOf(seed),
      device_id: seed.deviceId,
      provider: seed.provider ?? 'apns',
      token: `fixture-token-${id}`,
      token_set_at: setAt,
      acquired_by_move_at: null,
      frozen_until: seed.frozenUntil ?? null,
      revoked_at: seed.revokedAt ?? null,
      created_at: setAt,
      updated_at: at(-2 * DAY_MS),
    })
    .execute();
  return id;
}

/**
 * Every kind of token row the member may hold in its app: bound to a session, a second provider on
 * the same device, revoked, frozen, and one still carrying the user without a bound session.
 * Returns the ids.
 */
export async function seedMemberTokens(db: Kysely<DB>, m: Member): Promise<string[]> {
  const first = await device(db, m.appId);
  const second = await device(db, m.appId);
  const third = await device(db, m.appId);
  return [
    await seedToken(db, { appId: m.appId, deviceId: first.id, userId: m.uid }),
    await seedToken(db, {
      appId: m.appId,
      deviceId: first.id,
      userId: m.uid,
      provider: 'fcm',
      revokedAt: at(-DAY_MS),
    }),
    await seedToken(db, {
      appId: m.appId,
      deviceId: second.id,
      userId: m.uid,
      frozenUntil: at(3 * DAY_MS),
    }),
    await seedToken(db, { appId: m.appId, deviceId: third.id, userId: m.uid, boundSid: null }),
  ];
}

/** Two inbox messages of the member (one read, one unread). */
export async function seedInbox(db: Kysely<DB>, m: Member): Promise<void> {
  for (const readAt of [at(-HOUR_MS), null]) {
    await db
      .withSchema('app')
      .insertInto('inbox_messages')
      .values({
        message_id: randomUUID(),
        app_id: m.appId,
        user_id: m.uid,
        code: 'claim_result',
        title: '找回结果',
        body: '你的订单找回已处理',
        route: null,
        read_at: readAt,
        created_at: at(-3 * DAY_MS),
        updated_at: readAt ?? at(-3 * DAY_MS),
      })
      .execute();
  }
}

/** Send records of the member on every channel (sent, queued, suppressed). */
export async function seedNotifyLogs(db: Kysely<DB>, m: Member): Promise<void> {
  const rows = [
    { channel: 'inbox', status: 'success', sent_at: at(-3 * DAY_MS), suppress_reason: null },
    { channel: 'push', status: 'success', sent_at: at(-3 * DAY_MS), suppress_reason: null },
    { channel: 'push', status: 'suppressed', sent_at: null, suppress_reason: 'push_disabled' },
    { channel: 'sms', status: 'queued', sent_at: null, suppress_reason: null },
  ] as const;
  for (const row of rows) {
    const id = randomUUID();
    await db
      .withSchema('app')
      .insertInto('notify_logs')
      .values({
        id,
        app_id: m.appId,
        user_id: m.uid,
        code: 'claim_result',
        channel: row.channel,
        dedupe_key: `fixture:${id}`,
        planned_at: at(-3 * DAY_MS),
        sent_at: row.sent_at,
        status: row.status,
        suppress_reason: row.suppress_reason,
        created_at: at(-3 * DAY_MS),
        updated_at: at(-3 * DAY_MS),
      })
      .execute();
  }
}

/** The member's push switches (not all default). */
export async function seedSettings(db: Kysely<DB>, m: Member): Promise<void> {
  await db
    .withSchema('app')
    .insertInto('notification_settings')
    .values({
      app_id: m.appId,
      user_id: m.uid,
      service_push: true,
      subscription_push: false,
      marketing_push: false,
      created_at: at(-4 * DAY_MS),
      updated_at: at(-4 * DAY_MS),
    })
    .execute();
}

/** Inbox messages, send records and switches of the member. */
export async function seedRetained(db: Kysely<DB>, m: Member): Promise<void> {
  await seedInbox(db, m);
  await seedNotifyLogs(db, m);
  await seedSettings(db, m);
}

// ---- reading ---------------------------------------------------------------------------------

/** Every push_tokens row of the app (on `db` or a transaction), in a stable order. */
export function tokensOf(db: Kysely<DB>, appId: string): Promise<TokenRow[]> {
  return db
    .withSchema('app')
    .selectFrom('push_tokens')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** The app's rows the cleanup must leave alone, for a before / after comparison. */
export async function retainedOf(db: Kysely<DB>, appId: string) {
  return {
    inbox: await db
      .withSchema('app')
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('message_id')
      .execute(),
    logs: await db
      .withSchema('app')
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    settings: await db
      .withSchema('app')
      .selectFrom('notification_settings')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('user_id')
      .execute(),
    devices: await db
      .withSchema('app')
      .selectFrom('devices')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** Everything of the app the port may not change, users rows included. */
export async function untouchedOf(db: Kysely<DB>, appId: string, members: readonly Member[]) {
  const users: UserRow[] = [];
  for (const m of members) users.push(await userRow(db, m));
  return { ...(await retainedOf(db, appId)), users };
}

/** Takes the user's row lock on the transaction, as identity's cleanup does before the ports. */
export async function lockUser(trx: Transaction<DB>, m: Member): Promise<void> {
  await sql`SELECT id FROM app.users WHERE app_id = ${m.appId} AND id = ${m.uid}
    FOR UPDATE`.execute(trx);
}

// ---- assembly --------------------------------------------------------------------------------

/**
 * The DeletionCleanupPorts app.module assembles for the worker's deletion processing: the cleanup
 * factory of the options it passes to IdentityDeletionExpiryModule.forWorker, resolved as a Nest
 * provider in a context offering CLOCK, ROOT_LOGGER, APP_CONFIG and, when given, DB and
 * FIELD_CRYPTO. `close` ends the context.
 */
export async function assembledCleanup(p: Ports, db?: Kysely<DB>) {
  const api = await identity();
  const options = (await capturedWorkerOptions(api, p)) as {
    readonly cleanup?: Record<string, unknown>;
  };
  expect(options.cleanup, 'app.module passes no cleanup factory').toBeDefined();
  const token = Symbol('F1-02zzk assembled cleanup ports');
  class CleanupProbe {}
  const module = {
    module: CleanupProbe,
    providers: [{ ...options.cleanup, provide: token }],
    exports: [token],
  };
  const context =
    db === undefined
      ? await workerHarness(p, module, 'test')
      : await workerHarness(p, module, 'test', db, await fieldCrypto());
  return {
    ports: context.get(token) as DeletionCleanupPorts,
    close: () => context.close(),
  };
}

/** The assembled notification port, failing an assertion while it is an unavailable marker. */
export function notificationStep(cleanup: DeletionCleanupPorts): DeletionCleanupStep {
  const port = cleanup.notification;
  expect(
    typeof port,
    `app.module still assembles the notification cleanup port as ${JSON.stringify(port)}`,
  ).toBe('function');
  return port as DeletionCleanupStep;
}

/**
 * The worker's deletion runner as app.module assembles it (B1-15g: one round = processing, then
 * the cooling-period expiry), over `db`.
 */
export async function assembledRunner(p: Ports, db: Kysely<DB>) {
  const api = await identity();
  const options = await capturedWorkerOptions(api, p);
  const context = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
    db,
    await fieldCrypto(),
  );
  return {
    runner: context.get(api.deletionExpiryToken()) as Runner,
    close: () => context.close(),
  };
}
