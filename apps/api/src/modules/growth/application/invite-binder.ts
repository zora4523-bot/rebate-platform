// growth binding core (task B1-11d; 08 BR-INV-02, BR-INV-03, BR-INV-06, BR-INV-07, BR-INV-08,
// BR-INV-21; orchestrator ruling §9.3). Service layer only: no route, no contract change.
//
// bind(trx, command) runs in the caller's transaction and samples the injected Clock exactly once.
// Checks, each answering at once when hit (BR-INV-02 校验顺序), all of them read-only:
//   1. backfill only: users.phone_hmac IS NULL → 10005;
//   2. growth.invite_bind.enabled (missing = on; false / 'off' = off; anything else 50001) off → 30408;
//   3. the daily failure count of `<app_id>:<+08 day>:<phone_hmac>` (Redis namespace invite_fail)
//      ≥ invite.fail_limit_per_day (missing = 5; a positive integer, else 50001) → 42901 with
//      retry_after_seconds up to the next 00:00 +08:00;
//   4. parent_id set or self_bind_used → 30402;
//   5. backfill only: not before created_at + invite.backfill_hours (missing = 168) → 30404;
//   6. backfill only: any order, any claim, or any direct child (any status) → 30409;
//      before the child check, the app-level relation write lock (lockRelationWrites) is taken in
//      the caller's transaction (also on register, after step 4) and held to its end, so the child
//      check, the walk of step 9 and the conditional update are serialised per app;
//   7. the normalised code is empty or not of the invite-code format → 30401, no lookup;
//   8. no inviter with (app_id, invite_code), or inviter_unavailable(facts) → 30401;
//   9. relation conflict (BR-INV-08) → 30403: the inviter is the invitee; the invitee is found
//      walking up from the inviter along parent_id (at most 1000 layers, the inviter being the
//      first; a chain longer than that counts as hit and is warned); or the two device sets meet
//      (the invitee's retained login_logs hashes plus this request's signature device, against the
//      inviter's retained login_logs hashes).
// Only the 30401 of steps 7 and 8 increment the count (an atomic INCR; the key gets its TTL, the
// window plus 60 s, when it is created). Redis failing to read or to count → 50001.
// Attempt de-duplication (B1-11e review r1 S1): the count lives outside the caller's transaction,
// so a backfill whose PG commit fails after the count was incremented would count again when the
// client retries the same Idempotency-Key (no record survived the rollback). The backfill route
// passes that key as `options.attemptKey`; the same script then first sets
// `<count key>:seen:<sha256 of [user_id, attemptKey]>` with SET NX EX (same TTL, set only when
// created, so neither key outlives the day's window) and increments only when that key was new: a
// retry of one key counts once, different keys count once each. Without an attemptKey (the
// register channel: identity's registration has its own idempotency and no key reaches the binder)
// the count is exactly as before.
// When everything passes: one conditional UPDATE of users (parent_id IS NULL AND
// self_bind_used = false); 0 rows → 30402 with nothing written; 1 row → appendRelationChange in
// the same transaction. A failing log insert rejects, and the caller rolls back.
//
// Configuration is read on the caller's transaction (deps.config gets the trx): no second
// connection is borrowed from the pool while the caller's one is held.
//
// Nothing logged identifies the person beyond app and user ids: no phone hash, no code, no device.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import type { components } from '@couli/contracts-ts';
import {
  inviteBackfillDeadline,
  inviteFailWindow,
  inviterUnavailable,
  isAtLeastAge,
  isInviteCodeFormat,
  normalizeInviteCode,
  withinBackfill,
  type InviteFailWindow,
} from '@couli/domain';
import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RiskStateSnapshot } from '../../risk/index.ts';
import { appendRelationChange } from '../infra/change-logs.ts';
import { lockRelationWrites } from '../infra/relation-lock.ts';

export interface InviteBindCommand {
  readonly channel: 'register' | 'backfill';
  readonly app_id: string;
  readonly user_id: string;
  readonly invite_code: string;
  /** Server-provided signature device, never a body field. */
  readonly device_id: string;
}

export type InviteBindingResult =
  | { readonly result: 'bound'; readonly parent_id: string; readonly bound_at: Date }
  | {
      readonly result: 'failed';
      readonly code: 10005 | 30401 | 30402 | 30403 | 30404 | 30408 | 30409 | 42901 | 50001;
      readonly retry_after_seconds?: number;
    };

export interface InviteSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Consumer-owned read ports; app.module supplies identity's exported readers. */
export interface InviteActivityReader {
  orderCount(subject: { readonly appId: string; readonly userId: string }): Promise<number>;
  hasClaims(subject: { readonly appId: string; readonly userId: string }): Promise<boolean>;
}

export interface RegistrationInviteInput extends InviteSubject {
  readonly invite_code: string;
  readonly device_id?: string;
}

/** Structurally compatible with RegistrationOptions['bindInvite'], without importing Nest. */
export type RegistrationInviteBinding = (
  trx: Transaction<DB>,
  input: RegistrationInviteInput,
) => Promise<components['schemas']['InviteBind']>;

export interface InviteBinderDeps {
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly redis: RedisHandle;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
  /**
   * Read on the caller's transaction (`trx`), never through a second pooled connection: bind runs
   * inside the registration or backfill transaction (review r1 S2).
   */
  readonly config: {
    configValue(
      appId: string,
      key: string,
      trx: Transaction<DB>,
    ): Promise<{ readonly value: unknown; readonly version: number } | null>;
  };
  readonly loginDevices: {
    read(trx: Transaction<DB>, subject: InviteSubject): Promise<readonly string[]>;
  };
  readonly activity: (trx: Transaction<DB>) => InviteActivityReader;
  /** The assembler uses risk's readRiskState(subject, { fresh: true }) on this trx. */
  readonly readRisk: (trx: Transaction<DB>, subject: InviteSubject) => Promise<RiskStateSnapshot>;
  /**
   * identity's realname reader (B1-13d): the verified birth date, or null. app.module always wires
   * it (B1-11j); omitted only by unit tests, where the inviter counts as unverified.
   */
  readonly verifiedBirthDate?: (
    trx: Transaction<DB>,
    subject: InviteSubject,
  ) => Promise<string | null>;
}

/** Per-call options outside the command (the command stays the rule tests' exact shape). */
export interface InviteBindOptions {
  /**
   * Backfill: the request's Idempotency-Key. A 30401 is counted once per (user, attemptKey) and
   * day, so a retry after a rolled-back commit never counts twice. Omitted: every 30401 counts.
   */
  readonly attemptKey?: string;
}

export interface InviteBinder {
  bind(
    trx: Transaction<DB>,
    command: InviteBindCommand,
    options?: InviteBindOptions,
  ): Promise<InviteBindingResult>;
}

type FailureCode = Extract<InviteBindingResult, { result: 'failed' }>['code'];

/** Redis namespace of the daily 30401 count (BR-INV-02 【频控】), shared by every channel. */
export const INVITE_FAIL_NAMESPACE = 'invite_fail';
/** BR-INV-08 ②: layers walked up from the inviter (the inviter is layer one). */
export const INVITE_CHAIN_MAX_DEPTH = 1000;
/** Seconds the count key outlives its +08:00 day, so a late increment never restarts a day. */
const FAIL_KEY_GRACE_SECONDS = 60;
/**
 * Blind-index context of login_logs.device_id_hash, identity's LOGIN_LOGS_DEVICE_ID_CONTEXT. A copy:
 * identity's index.ts pulls in Nest, which the erasable-only `test` project cannot compile; the
 * unit test pins the two together.
 */
export const LOGIN_DEVICE_ID_CONTEXT = 'login_logs.device_id';
/** BR-INV-19 / BR-ID-26: a verified inviter must have reached this age at the judging instant. */
const INVITER_MIN_AGE = 18;

const SWITCH_KEY = 'growth.invite_bind.enabled';
const FAIL_LIMIT_KEY = 'invite.fail_limit_per_day';
const BACKFILL_HOURS_KEY = 'invite.backfill_hours';
const DEFAULT_FAIL_LIMIT = 5;
const DEFAULT_BACKFILL_HOURS = 168;
const INT32_MAX = 2_147_483_647;

// With a second key (the attempt's seen marker): SET NX EX ARGV[1] first; a marker that already
// exists means this attempt was counted, and nothing changes (returns 0). Then INCR, and the TTL
// (ARGV[1]) only on a key without one (the first increment of the day), so a later failure never
// extends the day's window. Returns the new count.
const COUNT_FAILURE = `
if #KEYS > 1 and not redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[1]) then
  return 0
end
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/** The register channel answers only these codes as they are (BR-INV-06); others are 50001. */
const REGISTER_CODES: ReadonlySet<number> = new Set([30401, 30403, 30408, 42901]);

function failed(code: FailureCode): InviteBindingResult {
  return { result: 'failed', code };
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function checkOptions(options: InviteBindOptions | undefined): void {
  if (options === undefined) return;
  if (
    typeof options !== 'object' ||
    options === null ||
    (options.attemptKey !== undefined && !nonEmpty(options.attemptKey))
  ) {
    throw new TypeError('growth: malformed invite bind options');
  }
}

/** The attempt's seen marker: one hash of user and key (the raw key never reaches Redis). */
function seenKey(countKey: string, userId: string, attemptKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([userId, attemptKey]), 'utf8')
    .digest('hex');
  return `${countKey}:seen:${digest}`;
}

function checkCommand(command: InviteBindCommand): void {
  if (
    typeof command !== 'object' ||
    command === null ||
    (command.channel !== 'register' && command.channel !== 'backfill') ||
    !nonEmpty(command.app_id) ||
    !nonEmpty(command.user_id) ||
    typeof command.invite_code !== 'string' ||
    !nonEmpty(command.device_id)
  ) {
    throw new TypeError('growth: malformed invite bind command');
  }
}

/** Switch value as in identity's me.ts: missing → on; true / 'on' / false / 'off'; else invalid. */
function switchOn(item: { readonly value: unknown } | null): boolean | null {
  const value = item?.value ?? true;
  if (value === true || value === 'on') return true;
  if (value === false || value === 'off') return false;
  return null;
}

function integerConfig(
  item: { readonly value: unknown } | null,
  fallback: number,
  min: number,
): number | null {
  if (item == null) return fallback;
  const { value } = item;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return null;
  return value > INT32_MAX ? null : value;
}

/** The stored count; null when it is not a plain non-negative integer. */
function storedCount(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^[0-9]{1,15}$/.test(raw)) return null;
  return Number(raw);
}

interface SubjectRow {
  readonly phone_hmac: string | null;
  readonly created_at: Date;
  readonly parent_id: string | null;
  readonly self_bind_used: boolean;
}

interface InviterRow {
  readonly id: string;
  readonly phone_hmac: string | null;
  readonly status: string;
}

interface ChainRow {
  readonly hit: boolean;
  readonly truncated: boolean;
}

/** B1-11d §9.3: caller-owned transaction, one Clock sample, ordered checks, CAS + audit. */
export function createInviteBinder(deps: InviteBinderDeps): InviteBinder {
  const { clock, logger, redis, crypto, config, loginDevices, activity, readRisk } = deps;
  const verifiedBirthDate = deps.verifiedBirthDate;

  async function subjectRow(trx: Transaction<DB>, command: InviteBindCommand) {
    const row = await trx
      .withSchema('app')
      .selectFrom('users')
      .select(['phone_hmac', 'created_at', 'parent_id', 'self_bind_used'])
      .where('app_id', '=', command.app_id)
      .where('id', '=', command.user_id)
      .executeTakeFirst();
    if (row === undefined) throw new Error('growth: invite bind subject not found');
    return row satisfies SubjectRow;
  }

  async function hasDirectChild(trx: Transaction<DB>, command: InviteBindCommand) {
    const row = await trx
      .withSchema('app')
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', command.app_id)
      .where('parent_id', '=', command.user_id)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function inviterOf(trx: Transaction<DB>, appId: string, code: string) {
    const row: InviterRow | undefined = await trx
      .withSchema('app')
      .selectFrom('users')
      .select(['id', 'phone_hmac', 'status'])
      .where('app_id', '=', appId)
      .where('invite_code', '=', code)
      .executeTakeFirst();
    return row;
  }

  /** BR-INV-02 inviter_unavailable with the facts read at the bind's single instant. */
  async function unavailable(
    trx: Transaction<DB>,
    appId: string,
    inviter: InviterRow,
    at: Date,
  ): Promise<boolean> {
    const subject = { app_id: appId, user_id: inviter.id };
    const risk = await readRisk(trx, subject);
    const birthDate =
      verifiedBirthDate === undefined ? null : await verifiedBirthDate(trx, subject);
    return inviterUnavailable({
      risk_state: risk.state,
      // TODO(规划/11 §2.3): 读注销单 deletion_status（cooling / processing / done）— blocked on B1-15
      deletion_status: inviter.status === 'deleted' ? 'done' : null,
      phone_bound: inviter.phone_hmac !== null,
      verified_minor: birthDate !== null && !isAtLeastAge(birthDate, INVITER_MIN_AGE, at),
    });
  }

  /** BR-INV-08 ②: walk up from the inviter; true when the invitee is met or the walk is cut. */
  async function descendant(
    trx: Transaction<DB>,
    command: InviteBindCommand,
    inviterId: string,
  ): Promise<boolean> {
    const appId = command.app_id;
    const userId = command.user_id;
    const result = await sql<ChainRow>`
      WITH RECURSIVE chain (id, parent_id, depth) AS (
        SELECT u.id, u.parent_id, 1
        FROM app.users u
        WHERE u.app_id = ${appId} AND u.id = ${inviterId}
        UNION ALL
        SELECT u.id, u.parent_id, c.depth + 1
        FROM chain c
        JOIN app.users u ON u.app_id = ${appId} AND u.id = c.parent_id
        WHERE c.depth < ${INVITE_CHAIN_MAX_DEPTH} AND c.id <> ${userId}
      )
      SELECT
        EXISTS (SELECT 1 FROM chain WHERE id = ${userId}) AS hit,
        EXISTS (
          SELECT 1 FROM chain
          WHERE depth = ${INVITE_CHAIN_MAX_DEPTH} AND parent_id IS NOT NULL
        ) AS truncated`.execute(trx);
    const row = result.rows[0];
    if (row === undefined) throw new Error('growth: invite chain query returned no row');
    if (row.hit) return true;
    if (row.truncated) {
      logger.warn(
        {
          app_id: appId,
          user_id: userId,
          inviter_id: inviterId,
          max_depth: INVITE_CHAIN_MAX_DEPTH,
        },
        'invite_bind_chain_limit',
      );
      return true;
    }
    return false;
  }

  /** BR-INV-08 ③: the invitee's set includes this request's signature device. */
  async function sharedDevice(
    trx: Transaction<DB>,
    command: InviteBindCommand,
    inviterId: string,
  ): Promise<boolean> {
    const own = new Set(await loginDevices.read(trx, command));
    own.add(crypto.blindIndex(command.device_id, LOGIN_DEVICE_ID_CONTEXT));
    const theirs = await loginDevices.read(trx, { app_id: command.app_id, user_id: inviterId });
    return theirs.some((hash) => own.has(hash));
  }

  return {
    async bind(trx, command, options) {
      checkCommand(command);
      checkOptions(options);
      const at = clock.now();
      const { app_id: appId, user_id: userId, channel } = command;
      const backfill = channel === 'backfill';
      const fields = { app_id: appId, user_id: userId, channel };
      const user = await subjectRow(trx, command);

      // 1. identity level phone (backfill only).
      if (backfill && user.phone_hmac === null) return failed(10005);

      // 2. switch.
      const enabled = switchOn(await config.configValue(appId, SWITCH_KEY, trx));
      if (enabled === null) {
        logger.warn({ ...fields, config_key: SWITCH_KEY }, 'invite_bind_config_invalid');
        return failed(50001);
      }
      if (!enabled) return failed(30408);

      // 3. daily 30401 count of the phone.
      const limit = integerConfig(
        await config.configValue(appId, FAIL_LIMIT_KEY, trx),
        DEFAULT_FAIL_LIMIT,
        1,
      );
      if (limit === null) {
        logger.warn({ ...fields, config_key: FAIL_LIMIT_KEY }, 'invite_bind_config_invalid');
        return failed(50001);
      }
      if (user.phone_hmac === null) {
        // Only a register channel without a phone gets here; there is no key to count against.
        logger.warn(fields, 'invite_bind_without_phone');
        return failed(50001);
      }
      const window: InviteFailWindow = inviteFailWindow(at);
      const key = `${appId}:${window.day}:${user.phone_hmac}`;
      // Every Redis call, also taking the namespace (a closed handle throws there), is inside a
      // catch that answers 50001 before anything is written.
      let counter: ReturnType<RedisHandle['namespace']>;
      let count: number | null;
      try {
        counter = redis.namespace(INVITE_FAIL_NAMESPACE);
        count = storedCount(await counter.get(key));
      } catch (error) {
        logger.warn({ ...fields, error_class: errorClass(error) }, 'invite_bind_redis_failed');
        return failed(50001);
      }
      if (count === null) {
        logger.warn(fields, 'invite_bind_count_malformed');
        return failed(50001);
      }
      if (count >= limit) {
        return { result: 'failed', code: 42901, retry_after_seconds: window.retry_after_seconds };
      }

      /** 30401 of steps 7 and 8: counted first; a count that cannot be written is 50001. */
      const invalidCode = async (): Promise<InviteBindingResult> => {
        try {
          const attemptKey = options?.attemptKey;
          await counter.eval(COUNT_FAILURE, {
            keys: attemptKey === undefined ? [key] : [key, seenKey(key, userId, attemptKey)],
            args: [],
            ttlSeconds: window.retry_after_seconds + FAIL_KEY_GRACE_SECONDS,
          });
        } catch (error) {
          logger.warn({ ...fields, error_class: errorClass(error) }, 'invite_bind_redis_failed');
          return failed(50001);
        }
        return failed(30401);
      };

      // 4. one self-service binding per account.
      if (user.parent_id !== null || user.self_bind_used) return failed(30402);

      if (backfill) {
        // 5. backfill period.
        const hours = integerConfig(
          await config.configValue(appId, BACKFILL_HOURS_KEY, trx),
          DEFAULT_BACKFILL_HOURS,
          0,
        );
        if (hours === null) {
          logger.warn({ ...fields, config_key: BACKFILL_HOURS_KEY }, 'invite_bind_config_invalid');
          return failed(50001);
        }
        let deadline: Date;
        try {
          deadline = inviteBackfillDeadline(user.created_at, hours);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          logger.warn({ ...fields, config_key: BACKFILL_HOURS_KEY }, 'invite_bind_config_invalid');
          return failed(50001);
        }
        if (!withinBackfill(at, deadline)) return failed(30404);

        // 6. no order, claim or direct child of any status (children below, under the lock).
        const reader = activity(trx);
        const subject = { appId, userId };
        if ((await reader.orderCount(subject)) > 0) return failed(30409);
        if (await reader.hasClaims(subject)) return failed(30409);
      }

      // The app's relation write lock, held to the end of the caller's transaction: the child
      // check, the descendant walk and the conditional update all see every earlier relation write
      // committed, so concurrent binds can never close a cycle (review r1 S0). Taken only now, so
      // nothing waits on it before the prechecks above (no row lock is held either).
      await lockRelationWrites(trx, appId);
      if (backfill && (await hasDirectChild(trx, command))) return failed(30409);

      // 7. format of the normalised code (no lookup).
      const code = normalizeInviteCode(command.invite_code);
      if (!isInviteCodeFormat(code)) return invalidCode();

      // 8. an existing, available inviter of the same app.
      const inviter = await inviterOf(trx, appId, code);
      if (inviter === undefined) return invalidCode();
      if (await unavailable(trx, appId, inviter, at)) return invalidCode();

      // 9. relation conflict (not counted).
      if (inviter.id === userId) return failed(30403);
      if (await descendant(trx, command, inviter.id)) return failed(30403);
      if (await sharedDevice(trx, command, inviter.id)) return failed(30403);

      // Write: the conditional update decides between concurrent attempts (BR-INV-03).
      const updated = await trx
        .withSchema('app')
        .updateTable('users')
        .set({
          parent_id: inviter.id,
          parent_bind_source: channel,
          parent_bound_at: at,
          self_bind_used: true,
          updated_at: at,
          row_version: sql<number>`row_version + 1`,
        })
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .where('parent_id', 'is', null)
        .where('self_bind_used', '=', false)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return failed(30402);
      await appendRelationChange(trx, {
        app_id: appId,
        user_id: userId,
        from_parent_id: null,
        to_parent_id: inviter.id,
        source: channel,
        operator: `user:${userId}`,
        reason: null,
        at,
      });
      return { result: 'bound', parent_id: inviter.id, bound_at: at };
    },
  };
}

/** Identity retains its SAVEPOINT; maps unexpected channel errors to 50001. */
export function createRegistrationInviteBinding(binder: InviteBinder): RegistrationInviteBinding {
  return async (trx, input) => {
    const answer = await binder.bind(trx, {
      channel: 'register',
      app_id: input.app_id,
      user_id: input.user_id,
      invite_code: input.invite_code,
      // A registration without a signature device is a caller bug: the binder refuses it.
      device_id: input.device_id ?? '',
    });
    if (answer.result === 'bound') return { result: 'bound', code: null };
    const code = REGISTER_CODES.has(answer.code) ? answer.code : 50001;
    return { result: 'failed', code: code as 30401 | 30403 | 30408 | 42901 | 50001 };
  };
}
