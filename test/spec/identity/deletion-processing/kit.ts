// B1-15g rule-test fixture (08 BR-ID-27, BR-ID-28, BR-ID-04, BR-AI-22, BR-FUND-24 ⑧; orchestrator
// brief §9.2 / §9.3; rulings D10-137, D10-186). The runner is identity's createDeletionProcessing
// (through identity/index.ts only, imported at run time: that file carries Nest decorators) over
// the business role couli_app of a cloned test database, with an injected FixedClock, a memory pino
// logger, a local FieldCrypto and controlled ports:
//   - the five cleanup ports (linking / growth / notification / agent / catalog): each call is
//     recorded with its input, whether it got a Kysely Transaction and whether the user's row was
//     locked by another session at that moment (FOR SHARE NOWAIT from a second connection → 55P03);
//     a port can be made unavailable (the marker), made to throw, or held at a barrier; growth can
//     run the real detachChildrenOfDeleted;
//   - the closing adjustment port (answer per user, default none_needed) and the paid-out
//     withdrawal port (answer per user, default false), recorded the same way;
//   - the Apple revoker (records its input; resolves, or rejects with the configured error);
//   - the push-unbinding hook of the session revocation (records sids and transaction).
// The test database is the global setup's createTestDatabase; this kit only sees a structural type
// (depcruise allows @couli/db/testing in *.int.test.ts only). No timing bets: barriers are promises
// and bounded polls of pg_locks.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, type DB } from '@couli/db';
import {
  sql,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Selectable,
  type Transaction,
} from 'kysely';
import { expect, vi } from 'vitest';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import { DEFAULT_AVATAR } from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import type {
  DeletionProcessing,
  DeletionProcessingOptions,
} from '../../../../apps/api/src/modules/identity/application/deletion-processing.ts';
import type { AfterSessionsRevoked } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import type {
  AppleTokenRevokeInput,
  AppleTokenRevoker,
} from '../../../../apps/api/src/modules/identity/ports/apple-token-revoker.ts';
import type { DeletionBalanceReader } from '../../../../apps/api/src/modules/identity/ports/deletion-balance.ts';
import type {
  ClosingAdjustmentState,
  DeletionCleanupInput,
  DeletionCleanupPort,
  DeletionCleanupPortName,
  DeletionCleanupPorts,
  DeletionCleanupStep,
  DeletionClosingAdjustmentReader,
} from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import type { WithdrawalSucceededReader } from '../../../../apps/api/src/modules/identity/ports/withdrawal-in-flight.ts';

export { DEFAULT_AVATAR };

interface TestDatabaseUrls {
  urlFor(role: string): string;
}

export const ROOT = new URL('../../../../', import.meta.url);
/** 2026-10-23 12:00 +08:00. */
export const NOW = '2026-10-23T04:00:00.000Z';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** BR-ID-28: deleted_identities are kept 180 days from the completion. */
export const RETENTION_MS = 180 * DAY_MS;
/** BR-ID-28: the nickname of a deleted account. */
export const TOMBSTONE_NICKNAME = '已注销用户';
/** Field-cipher context of the Apple refresh token (identity's APPLE_REFRESH_TOKEN_CONTEXT). */
export const APPLE_REFRESH_CONTEXT = 'user_oauth.apple_refresh_token';
export const CLEANUP_FAILED = 'identity_deletion_cleanup_failed';
export const CLEANUP_BLOCKED = 'identity_deletion_cleanup_blocked';
export const APPLE_FAILED = 'identity_deletion_apple_revoke_failed';
export const ADJUSTMENT_PENDING = 'identity_deletion_adjustment_pending';
export const PORT_NAMES: readonly DeletionCleanupPortName[] = [
  'linking',
  'growth',
  'notification',
  'agent',
  'catalog',
];

export type RequestStatus = 'cooling' | 'processing' | 'done' | 'cancelled';
export type RequestRow = Selectable<DB['deletion_requests']>;
export type UserRow = Selectable<DB['users']>;
export type Runner = DeletionProcessing;
export interface WorkerModule {
  module: unknown;
  controllers?: unknown[];
}
export interface ProcessingApi {
  createDeletionProcessing(options: DeletionProcessingOptions): DeletionProcessing;
  closingAdjustmentFromBalance(balance: DeletionBalanceReader): DeletionClosingAdjustmentReader;
  unconfiguredAppleTokenRevoker(): AppleTokenRevoker;
  deletionExpiryToken(): symbol;
  IdentityDeletionExpiryModule: { forWorker(options: never): WorkerModule };
}

export async function identity(): Promise<ProcessingApi> {
  return (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as ProcessingApi;
}

export type DetachChildren = (
  trx: Transaction<DB>,
  input: DeletionCleanupInput,
) => Promise<{ detached: number }>;

/** growth's real detachChildrenOfDeleted (B1-15n), through growth/index.ts. */
export async function growthDetach(): Promise<DetachChildren> {
  const growth = (await import(new URL('apps/api/src/modules/growth/index.ts', ROOT).href)) as {
    detachChildrenOfDeleted: DetachChildren;
  };
  return growth.detachChildrenOfDeleted;
}

export async function ports() {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const clock = new platform.FixedClock(NOW);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const logs = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { platform, clock, lines, logger, logs };
}
export type Ports = Awaited<ReturnType<typeof ports>>;

export async function fieldCrypto(): Promise<FieldCrypto> {
  const provider = new LocalKeyProvider(randomBytes(32));
  return openFieldCrypto(await createWrappedKeyring(provider), provider);
}

/** A log line without pino's own fields and the message. */
export function fields(line: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(line).filter(
      ([key]) => !['level', 'time', 'pid', 'hostname', 'entry', 'env', 'msg'].includes(key),
    ),
  );
}

/** Warn lines (level 40) of one message, optionally of one app. */
export function warnings(kit: Pick<Ports, 'logs'>, msg: string, appId?: string) {
  return kit
    .logs()
    .filter(
      (line) =>
        line['level'] === 40 &&
        line['msg'] === msg &&
        (appId === undefined || line['app_id'] === appId),
    );
}

// ---- controlled ports ------------------------------------------------------------------------

export type RecordedPort = DeletionCleanupPortName | 'funds' | 'succeeded';
export interface PortCall {
  readonly port: RecordedPort;
  readonly input: Record<string, unknown>;
  /** The executor the port got was a Kysely Transaction (the caller's), not the pool. */
  readonly inTransaction: boolean;
  /** Another connection could not take FOR SHARE NOWAIT on the user's row (55P03). */
  readonly userRowLocked: boolean;
}
export interface HoldPlan {
  readonly hold: Promise<void>;
  readonly entered: () => void;
}
export interface Member {
  readonly appId: string;
  readonly uid: string;
  readonly phoneHmac: string | null;
}

const key = (appId: string, userId: string) => `${appId}/${userId}`;

function isTransaction(executor: unknown): boolean {
  return (
    typeof executor === 'object' &&
    executor !== null &&
    (executor as { isTransaction?: unknown }).isTransaction === true
  );
}

async function userRowLocked(db: Kysely<DB>, appId: string, userId: string): Promise<boolean> {
  try {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM app.users WHERE app_id = ${appId} AND id = ${userId}
        FOR SHARE NOWAIT`.execute(trx);
    });
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code === '55P03') return true;
    throw error;
  }
}

/** Controlled ports and a runner factory over `db` (the caller owns `db`). */
export async function controls(db: Kysely<DB>, crypto: FieldCrypto, p: Ports) {
  const api = await identity();
  const calls: PortCall[] = [];
  const unavailable = new Map<DeletionCleanupPortName, string>();
  const failures = new Map<DeletionCleanupPortName, { error: Error; owner?: string }>();
  const holds = new Map<string, HoldPlan[]>();
  const adjustments = new Map<string, ClosingAdjustmentState>();
  const succeeded = new Map<string, boolean>();
  const appleCalls: AppleTokenRevokeInput[] = [];
  const revokedHooks: { inTransaction: boolean; sids: string[]; appId: string }[] = [];
  const state: { appleError: Error | undefined; growth: DetachChildren | undefined } = {
    appleError: undefined,
    growth: undefined,
  };

  async function record(
    port: RecordedPort,
    trx: unknown,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<void> {
    calls.push({
      port,
      input: { ...input },
      inTransaction: isTransaction(trx),
      userRowLocked: await userRowLocked(db, input.appId, input.userId),
    });
    const plan = holds.get(port)?.shift();
    if (plan !== undefined) {
      plan.entered();
      await plan.hold;
    }
  }

  function cleanupPort(name: DeletionCleanupPortName): DeletionCleanupPort {
    const blockedOn = unavailable.get(name);
    if (blockedOn !== undefined) return { unavailable: blockedOn };
    const step: DeletionCleanupStep = async (trx, input) => {
      await record(name, trx, input);
      const failure = failures.get(name);
      if (
        failure !== undefined &&
        (failure.owner === undefined || failure.owner === key(input.appId, input.userId))
      ) {
        throw failure.error;
      }
      if (name === 'growth' && state.growth !== undefined) await state.growth(trx, input);
    };
    return step;
  }
  /** Read when a runner is created: a marker set later needs a new runner. */
  const cleanup = (): DeletionCleanupPorts => ({
    linking: cleanupPort('linking'),
    growth: cleanupPort('growth'),
    notification: cleanupPort('notification'),
    agent: cleanupPort('agent'),
    catalog: cleanupPort('catalog'),
  });
  const funds: DeletionClosingAdjustmentReader = {
    async closingAdjustmentState(trx, input) {
      await record('funds', trx, input);
      return adjustments.get(key(input.appId, input.userId)) ?? 'none_needed';
    },
  };
  const withdrawals: WithdrawalSucceededReader = {
    async hasSucceeded(trx, input) {
      await record('succeeded', trx, input);
      return succeeded.get(key(input.appId, input.userId)) ?? false;
    },
  };
  const apple: AppleTokenRevoker = {
    async revoke(input) {
      appleCalls.push({ ...input });
      const plan = holds.get('apple')?.shift();
      if (plan !== undefined) {
        plan.entered();
        await plan.hold;
      }
      if (state.appleError !== undefined) throw state.appleError;
    },
  };
  const afterRevoked: AfterSessionsRevoked = async (trx, sids, context) => {
    revokedHooks.push({
      inTransaction: isTransaction(trx),
      sids: [...sids].sort(),
      appId: context.app_id,
    });
  };

  /** A new runner (call it in the test body: NotImplemented must fail each test). */
  const runner = (
    options: {
      readonly batchSize?: number;
      readonly db?: Kysely<DB>;
      readonly apple?: AppleTokenRevoker;
      readonly funds?: DeletionClosingAdjustmentReader;
    } = {},
  ): Runner =>
    api.createDeletionProcessing({
      db: options.db ?? db,
      clock: p.clock,
      logger: p.logger,
      crypto,
      cleanup: cleanup(),
      funds: options.funds ?? funds,
      withdrawals,
      apple: options.apple ?? apple,
      afterRevoked,
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    });

  return {
    ...p,
    api,
    db,
    crypto,
    calls,
    appleCalls,
    revokedHooks,
    runner,
    callsOf(port: RecordedPort, owner?: Member) {
      return calls.filter(
        (call) =>
          call.port === port &&
          (owner === undefined ||
            (call.input['appId'] === owner.appId && call.input['userId'] === owner.uid)),
      );
    },
    setUnavailable(name: DeletionCleanupPortName, blockedOn = 'W1') {
      unavailable.set(name, blockedOn);
    },
    setAvailable(name: DeletionCleanupPortName) {
      unavailable.delete(name);
    },
    /** The port throws `error` (for `owner` only, when given). */
    setFailure(name: DeletionCleanupPortName, error: Error, owner?: Member) {
      failures.set(
        name,
        owner === undefined ? { error } : { error, owner: key(owner.appId, owner.uid) },
      );
    },
    clearFailure(name: DeletionCleanupPortName) {
      failures.delete(name);
    },
    hold(port: RecordedPort | 'apple', plan: HoldPlan) {
      holds.set(port, [...(holds.get(port) ?? []), plan]);
    },
    setAdjustment(owner: Member, answer: ClosingAdjustmentState) {
      adjustments.set(key(owner.appId, owner.uid), answer);
    },
    setSucceeded(owner: Member, answer: boolean) {
      succeeded.set(key(owner.appId, owner.uid), answer);
    },
    failApple(error: Error | undefined) {
      state.appleError = error;
    },
    useGrowth(detach: DetachChildren | undefined) {
      state.growth = detach;
    },
    resetControls() {
      calls.length = 0;
      unavailable.clear();
      failures.clear();
      holds.clear();
      adjustments.clear();
      succeeded.clear();
      appleCalls.length = 0;
      revokedHooks.length = 0;
      state.appleError = undefined;
      state.growth = undefined;
    },
  };
}

export async function open(database: TestDatabaseUrls) {
  const p = await ports();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  const crypto = await fieldCrypto();
  return controls(db, crypto, p);
}
export type Kit = Awaited<ReturnType<typeof open>>;

/**
 * Between tests: every open request of earlier tests reaches done (couli_app cannot DELETE), so a
 * cross-app round only sees this test's rows; ports, logs and the clock are reset.
 */
export async function reset(kit: Kit) {
  await sql`UPDATE app.deletion_requests SET status = 'done', processed_at = cooling_until,
    row_version = row_version + 1 WHERE status IN ('cooling', 'processing')`.execute(kit.db);
  kit.clock.set(NOW);
  kit.lines.length = 0;
  kit.resetControls();
}

export async function close(kit: Kit | undefined) {
  await kit?.db.destroy();
}

// ---- seeding ---------------------------------------------------------------------------------

export function hex(): string {
  return randomBytes(32).toString('hex');
}

/** Instant `ms` after the kit's NOW. */
export function at(ms: number): Date {
  return new Date(Date.parse(NOW) + ms);
}

/**
 * A user (default users.status deleting, with a phone, nickname 小狸, a custom avatar and two
 * nickname changes this month) of a fresh app id unless given.
 */
export async function member(
  db: Kysely<DB>,
  options: {
    readonly appId?: string;
    readonly status?: string;
    readonly phone?: boolean;
    readonly parentId?: string;
  } = {},
): Promise<Member> {
  const appId = options.appId ?? `dp_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  const phoneHmac = options.phone === false ? null : hex();
  const parent = options.parentId ?? null;
  await sql`INSERT INTO app.users
    (id, app_id, phone_cipher, phone_hmac, nickname, avatar, nickname_change_month,
     nickname_change_count, invite_code, attr_code, level, register_method, status, parent_id,
     parent_bind_source, parent_bound_at)
    VALUES (${uid}, ${appId},
      ${phoneHmac === null ? null : Buffer.from(`synthetic-phone-cipher-${uid}`)}, ${phoneHmac},
      '小狸', 'https://example.test/avatar.png', '2026-10', 2,
      ${randomBytes(6).toString('hex')}, ${randomBytes(6).toString('hex')}, 'L1', 'sms',
      ${options.status ?? 'deleting'}, ${parent}, ${parent === null ? null : 'register'},
      ${parent === null ? null : at(-30 * DAY_MS)})`.execute(db);
  return { appId, uid, phoneHmac };
}

/**
 * A deletion request written directly (synthetic fixture). Default processing: cooling ended one
 * day before NOW, applied 7 days before that; updated_at = when it entered processing.
 */
export async function seedRequest(
  db: Kysely<DB>,
  m: Member,
  options: { readonly status?: RequestStatus } = {},
): Promise<RequestRow> {
  const status = options.status ?? 'processing';
  const coolingUntil = status === 'cooling' ? at(-HOUR_MS) : at(-DAY_MS);
  const applyAt = new Date(coolingUntil.getTime() - 7 * DAY_MS);
  return db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: m.appId,
      user_id: m.uid,
      status,
      apply_at: applyAt,
      cooling_until: coolingUntil,
      cancelled_at: status === 'cancelled' ? new Date(applyAt.getTime() + HOUR_MS) : null,
      cancel_reason: status === 'cancelled' ? 'user' : null,
      processed_at: status === 'done' ? coolingUntil : null,
      balance_snapshot_fen: 0n,
      created_at: applyAt,
      updated_at: status === 'processing' ? coolingUntil : applyAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A user in deletion processing: users.status deleting plus a processing request. */
export async function processing(
  db: Kysely<DB>,
  options: { readonly appId?: string; readonly phone?: boolean } = {},
) {
  const m = await member(db, options);
  const row = await seedRequest(db, m);
  return { m, row };
}

/** A registered device of the app (shared by installation: devices.user_id stays NULL). */
export async function device(db: Kysely<DB>, appId: string) {
  const id = randomUUID();
  const hash = hex();
  await sql`INSERT INTO app.devices
    (id, app_id, device_hash, id_source, install_secret_cipher, platform, app_version, last_seen_at)
    VALUES (${id}, ${appId}, ${hash}, 'idfv', ${Buffer.from(`install-secret-${id}`)}, 'ios',
      '2.0.0', ${at(-2 * DAY_MS)})`.execute(db);
  return { id, hash };
}

/** A session of the user on the device (live, or revoked by logout two days ago). */
export async function session(
  db: Kysely<DB>,
  m: Member,
  deviceId: string,
  options: { readonly revoked?: boolean } = {},
): Promise<string> {
  const sid = `sid_${randomBytes(12).toString('hex')}`;
  const created = at(-3 * DAY_MS);
  const revokedAt = options.revoked === true ? at(-2 * DAY_MS) : null;
  await sql`INSERT INTO app.sessions
    (id, app_id, sid, user_id, device_id, revoked_at, revoke_reason, login_method, created_at,
     updated_at)
    VALUES (${randomUUID()}, ${m.appId}, ${sid}, ${m.uid}, ${deviceId}, ${revokedAt},
      ${revokedAt === null ? null : 'logout'}, 'sms', ${created},
      ${revokedAt ?? created})`.execute(db);
  return sid;
}

export async function loginLog(db: Kysely<DB>, m: Member, deviceHash: string) {
  await sql`INSERT INTO app.login_logs (app_id, user_id, device_id_hash, ip, method, device_hash,
      created_at)
    VALUES (${m.appId}, ${m.uid}, ${hex()}, '192.0.2.10', 'sms', ${deviceHash},
      ${at(-3 * DAY_MS)})`.execute(db);
}

/** A third-party binding; an Apple one may carry an encrypted refresh token. */
export async function oauth(
  db: Kysely<DB>,
  m: Member,
  provider: 'wechat' | 'apple',
  options: { readonly appleToken?: string; readonly crypto?: FieldCrypto } = {},
) {
  const cipher =
    options.appleToken === undefined
      ? null
      : Buffer.from(options.crypto!.encrypt(options.appleToken, APPLE_REFRESH_CONTEXT), 'utf8');
  await db
    .withSchema('app')
    .insertInto('user_oauth')
    .values({
      id: randomUUID(),
      app_id: m.appId,
      user_id: m.uid,
      provider,
      union_id: `union-${randomUUID()}`,
      apple_refresh_token_cipher: cipher,
    })
    .execute();
}

/** A verified real name of the user, read back. */
export async function realname(db: Kysely<DB>, m: Member) {
  await db
    .withSchema('app')
    .insertInto('realname')
    .values({
      id: randomUUID(),
      app_id: m.appId,
      user_id: m.uid,
      name_cipher: Buffer.from(`synthetic-name-${m.uid}`),
      id_no_cipher: Buffer.from(`synthetic-id-${m.uid}`),
      id_no_hmac: hex(),
      birth_date_cipher: Buffer.from(`synthetic-birth-${m.uid}`),
      status: 'verified',
      provider: 'fixture-provider',
      verified_at: at(-20 * DAY_MS),
      created_at: at(-20 * DAY_MS),
      updated_at: at(-20 * DAY_MS),
    })
    .execute();
  return realnameOf(db, m);
}

export const PAYEE_NAME = '测试收款人';

/** A payout account of the user (alipay or bank card, current or historical), read back. */
export async function payoutAccount(
  db: Kysely<DB>,
  m: Member,
  method: 'alipay' | 'bank_card',
  current: boolean,
) {
  const id = randomUUID();
  await db
    .withSchema('app')
    .insertInto('payout_accounts')
    .values({
      id,
      app_id: m.appId,
      user_id: m.uid,
      payout_method: method,
      alipay_logon_id_cipher: method === 'alipay' ? Buffer.from(`synthetic-alipay-${id}`) : null,
      alipay_hmac: method === 'alipay' ? hex() : null,
      bank_card_no_cipher: method === 'bank_card' ? Buffer.from(`synthetic-card-${id}`) : null,
      bank_card_hmac: method === 'bank_card' ? hex() : null,
      bank_name: method === 'bank_card' ? 'fixture-bank' : null,
      card_bin: method === 'bank_card' ? '622588' : null,
      payee_name: PAYEE_NAME,
      is_current: current,
      created_at: at(-10 * DAY_MS),
      updated_at: at(-10 * DAY_MS),
    })
    .execute();
  return db
    .withSchema('app')
    .selectFrom('payout_accounts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

// ---- reading ---------------------------------------------------------------------------------

export async function request(db: Kysely<DB>, id: string): Promise<RequestRow> {
  return db
    .withSchema('app')
    .selectFrom('deletion_requests')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export async function userRow(db: Kysely<DB>, m: Pick<Member, 'appId' | 'uid'>): Promise<UserRow> {
  return db
    .withSchema('app')
    .selectFrom('users')
    .selectAll()
    .where('app_id', '=', m.appId)
    .where('id', '=', m.uid)
    .executeTakeFirstOrThrow();
}

export async function sessionsOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('sessions')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('sid')
    .execute();
}

export async function devicesOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('devices')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export async function loginLogsOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('login_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

export async function oauthOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('user_oauth')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** deleted_identities of the app, without the generated id / created_at, in a stable order. */
export async function deletedIdentitiesOf(db: Kysely<DB>, appId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('deleted_identities')
    .select(['app_id', 'reason', 'phone_hmac', 'device_hash', 'deleted_at', 'expire_at'])
    .where('app_id', '=', appId)
    .execute();
  return rows.sort((a, b) =>
    `${a.phone_hmac ?? ''}/${a.device_hash ?? ''}`.localeCompare(
      `${b.phone_hmac ?? ''}/${b.device_hash ?? ''}`,
    ),
  );
}

export async function realnameOf(db: Kysely<DB>, m: Member) {
  return db
    .withSchema('app')
    .selectFrom('realname')
    .selectAll()
    .where('app_id', '=', m.appId)
    .where('user_id', '=', m.uid)
    .executeTakeFirstOrThrow();
}

export async function payoutAccountsOf(db: Kysely<DB>, m: Member) {
  return db
    .withSchema('app')
    .selectFrom('payout_accounts')
    .selectAll()
    .where('app_id', '=', m.appId)
    .where('user_id', '=', m.uid)
    .orderBy('id')
    .execute();
}

export async function relationLogsOf(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('relation_change_logs')
    .select(['app_id', 'user_id', 'from_parent_id', 'to_parent_id', 'source', 'operator', 'at'])
    .where('app_id', '=', appId)
    .orderBy('user_id')
    .execute();
}

/** Everything the cleanup may touch for one user, to compare before / after a rolled-back round. */
export async function footprint(db: Kysely<DB>, m: Member, requestId: string) {
  return {
    request: await request(db, requestId),
    user: await userRow(db, m),
    sessions: await sessionsOf(db, m.appId),
    logs: await loginLogsOf(db, m.appId),
    oauth: await oauthOf(db, m.appId),
    realname: await realnameOf(db, m),
    payout: await payoutAccountsOf(db, m),
    identities: await deletedIdentitiesOf(db, m.appId),
  };
}

// ---- barriers --------------------------------------------------------------------------------

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A promise with its opener. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function waitingSessions(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ waiting: number }>`SELECT count(DISTINCT l.pid)::int AS waiting
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND a.datname = current_database()`.execute(db);
  return rows[0]!.waiting;
}

/**
 * Waits until at least `count` sessions of this test database wait for a lock that is not granted.
 * A bounded poll of pg_locks, not a timed bet.
 */
export async function lockWaiters(db: Kysely<DB>, count: number): Promise<void> {
  let waiting = 0;
  for (let attempt = 0; attempt < 1500 && waiting < count; attempt += 1) {
    if (attempt > 0) await delay(10);
    waiting = await waitingSessions(db);
  }
  expect(
    waiting,
    `fewer than ${count} sessions waited on a lock within the bound`,
  ).toBeGreaterThanOrEqual(count);
}

/**
 * Waits (bounded) until `work` has settled or some session waits on a lock, whichever comes first;
 * never rejects on its own.
 */
export async function settledOrWaiting(db: Kysely<DB>, work: Promise<unknown>): Promise<void> {
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let attempt = 0; attempt < 1500 && !settled; attempt += 1) {
    if (attempt > 0) await delay(10);
    if ((await waitingSessions(db)) > 0) return;
  }
}

// ---- assembly --------------------------------------------------------------------------------

export interface CompiledStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** A Kysely that compiles and records every statement (SQL and parameters) but never connects. */
export function compileOnlyDb(statements: CompiledStatement[]) {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
}

/**
 * A Nest application context holding `module` plus the platform tokens a worker module may use:
 * CLOCK, ROOT_LOGGER, APP_CONFIG and, when given, DB and FIELD_CRYPTO.
 */
export async function workerHarness(
  p: Ports,
  module: unknown,
  appEnv: 'test' | 'local' | 'staging' | 'prod',
  db?: Kysely<DB>,
  crypto?: FieldCrypto,
) {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ get(token: unknown): unknown; close(): Promise<void> }>;
    };
  };
  class Dependencies {}
  class Harness {}
  const providers = [
    { provide: p.platform.CLOCK, useValue: p.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: p.logger },
    { provide: p.platform.APP_CONFIG, useValue: { appEnv } },
    ...(db === undefined ? [] : [{ provide: p.platform.DB, useValue: db }]),
    ...(crypto === undefined ? [] : [{ provide: p.platform.FIELD_CRYPTO, useValue: crypto }]),
  ];
  return NestFactory.createApplicationContext(
    {
      module: Harness,
      imports: [
        {
          module: Dependencies,
          global: true,
          providers,
          exports: providers.map((value) => value.provide),
        },
        module,
      ],
    },
    { logger: false, abortOnError: false },
  );
}

/**
 * The options app.module passes to IdentityDeletionExpiryModule.forWorker on the worker entry
 * (captured; the module is not built here). Fails an assertion when app.module does not call it.
 */
export async function capturedWorkerOptions(api: ProcessingApi, p: Ports): Promise<unknown> {
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi
    .spyOn(api.IdentityDeletionExpiryModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityDeletionExpiryModule });
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: p.platform.loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
    });
    expect(
      forWorker,
      'app.module does not assemble IdentityDeletionExpiryModule',
    ).toHaveBeenCalledTimes(1);
    return forWorker.mock.calls[0]![0] as unknown;
  } finally {
    forWorker.mockRestore();
  }
}
