// growth's landing channel (task B1-11h; 08 BR-INV-05, BR-INV-02, BR-INV-03; orchestrator ruling
// §9.2 第 4 条). Service layer only: identity's landing registration (POST
// /v1/invites/landing-register) calls it through the port app.module assembles (identity never
// imports growth). Both calls run in the caller's transaction and sample the injected Clock once.
//
// precheck(trx, input) — before the SMS code is checked, read-only plus the Redis count; each step
// answers at once when hit (BR-INV-05 校验顺序):
//   1. growth.invite_bind.enabled (the B1-11d parse: missing = on; false / 'off' = off; anything
//      else 50001) off → 30408;
//   2. the day's 30401 counts (Redis namespace invite_fail, +08:00 day) of the phone key
//      `<app_id>:<day>:<phone_hmac>` — shared with the register and backfill channels — and of the
//      landing-only IP key `<app_id>:<day>:ip:<ip_hmac>` (ip_hmac: the field cipher's blind index,
//      context invite_fail.ip; the clear IP never reaches Redis): either ≥
//      invite.fail_limit_per_day (missing = 5; a positive integer, else 50001) → 42901 with
//      retry_after_seconds up to the next 00:00 +08:00;
//   3. the normalised code (normalizeInviteCode) empty or not of the invite-code format → 30401,
//      no lookup;
//   4. no inviter with (app_id, invite_code), or inviter_unavailable(facts) at this instant →
//      30401 (isInviterUnavailable: the one definition every channel uses).
//   Answers { ok: true, inviter_id } otherwise.
// bind(trx, input) — after identity created the account in the same transaction:
//   1. the app's relation write lock (lockRelationWrites), held to the end of the transaction;
//   2. the inviter read again by id and judged again at this instant (banned or deleted since the
//      precheck) → 30401, counted like the precheck's;
//   3. the conditional update of the new account (parent_id IS NULL AND self_bind_used = false):
//      parent_id, parent_bind_source landing, parent_bound_at, self_bind_used, row_version + 1,
//      updated_at; 0 rows (impossible for a fresh account) → 50001 with a warning, nothing more;
//   4. 1 row → appendRelationChange (from NULL, source landing, operator user:<id>, at = the
//      bound instant) in the same transaction. A failing insert rejects; the caller rolls back.
// Every 30401 (precheck steps 3–4, bind step 2) increments both keys in one script; the request's
// Idempotency-Key is the attempt key: each key first sets its seen marker
// `<count key>:seen:<sha256 of [phone_hmac, attempt key]>` (SET NX EX) and increments only when it
// was new, so a retry of one key after a rolled-back commit never counts twice (B1-11e review r1
// S1, subject the phone blind index instead of a user id). Redis failing to read or count → 50001
// before anything is answered.
//
// Nothing logged identifies the person: app id and the new account's id only — no phone hash, IP,
// invite code or code.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { DB } from '@couli/db';
import {
  inviteFailWindow,
  isInviteCodeFormat,
  normalizeInviteCode,
  type InviteFailWindow,
} from '@couli/domain';
import { sql, type Transaction } from 'kysely';
import { appendRelationChange } from '../infra/change-logs.ts';
import { lockRelationWrites } from '../infra/relation-lock.ts';
import { qualifyAfterBind } from './invite-reward-hook.ts';
import {
  DEFAULT_FAIL_LIMIT,
  FAIL_KEY_GRACE_SECONDS,
  FAIL_LIMIT_KEY,
  INVITE_FAIL_NAMESPACE,
  SWITCH_KEY,
  errorClass,
  findInviterByCode,
  integerConfig,
  isInviterUnavailable,
  seenKey,
  storedCount,
  switchOn,
  type InviteBinderDeps,
  type InviterRow,
} from './invite-binder.ts';

/** Blind-index context of the client IP in the landing IP key (never the clear IP). */
export const INVITE_FAIL_IP_CONTEXT = 'invite_fail.ip';

export interface LandingPrecheckInput {
  readonly app_id: string;
  /** users.phone_hmac of the normalised phone (identity's PHONE_BLIND_INDEX_CONTEXT). */
  readonly phone_hmac: string;
  readonly client_ip: string;
  /** As sent; normalised here (BR-INV-02). */
  readonly invite_code: string;
  /** The request's Idempotency-Key (de-duplicates the 30401 count). */
  readonly attempt_key: string;
}

export type LandingPrecheckResult =
  | { readonly ok: true; readonly inviter_id: string }
  | {
      readonly ok: false;
      readonly code: 30401 | 30408 | 42901 | 50001;
      readonly retry_after_seconds?: number;
    };

export interface LandingBindInput {
  readonly app_id: string;
  /** The account identity created in this transaction. */
  readonly user_id: string;
  /** precheck's inviter_id. */
  readonly inviter_id: string;
  readonly phone_hmac: string;
  readonly client_ip: string;
  readonly attempt_key: string;
}

export type LandingBindResult =
  | { readonly result: 'bound'; readonly parent_id: string; readonly bound_at: Date }
  | { readonly result: 'failed'; readonly code: 30401 | 50001 };

export interface LandingInviteBinder {
  precheck(trx: Transaction<DB>, input: LandingPrecheckInput): Promise<LandingPrecheckResult>;
  bind(trx: Transaction<DB>, input: LandingBindInput): Promise<LandingBindResult>;
}

export type LandingInviteBinderDeps = Pick<
  InviteBinderDeps,
  | 'clock'
  | 'logger'
  | 'redis'
  | 'crypto'
  | 'config'
  | 'readRisk'
  | 'verifiedBirthDate'
  | 'readDeletionStage'
  | 'inviteReward'
>;

// Two (count key, seen marker) pairs: for each, SET NX EX ARGV[1] on the marker first; a marker
// that already exists means this attempt was counted on that key, and it stays unchanged. Then
// INCR, and the TTL (ARGV[1]) only on a key without one (the first increment of the day), so a
// later failure never extends the day's window. Returns both counts (0: already counted).
const COUNT_LANDING_FAILURE = `
local function count(key, seen)
  if not redis.call('SET', seen, '1', 'NX', 'EX', ARGV[1]) then
    return 0
  end
  local n = redis.call('INCR', key)
  if n == 1 or redis.call('TTL', key) < 0 then
    redis.call('EXPIRE', key, ARGV[1])
  end
  return n
end
return { count(KEYS[1], KEYS[2]), count(KEYS[3], KEYS[4]) }
`;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function checkSubject(input: {
  readonly app_id: string;
  readonly phone_hmac: string;
  readonly client_ip: string;
  readonly attempt_key: string;
}): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !nonEmpty(input.app_id) ||
    !nonEmpty(input.phone_hmac) ||
    typeof input.client_ip !== 'string' ||
    !nonEmpty(input.attempt_key)
  ) {
    throw new TypeError('growth: malformed landing invite input');
  }
}

/** B1-11h §9.2 第 4 条: the landing channel's precheck and in-transaction binding. */
export function createLandingInviteBinder(deps: LandingInviteBinderDeps): LandingInviteBinder {
  const { clock, logger, redis, crypto, config } = deps;

  function countKeys(
    input: {
      readonly app_id: string;
      readonly phone_hmac: string;
      readonly client_ip: string;
    },
    window: InviteFailWindow,
  ) {
    const prefix = `${input.app_id}:${window.day}`;
    return {
      phone: `${prefix}:${input.phone_hmac}`,
      ip: `${prefix}:ip:${crypto.blindIndex(input.client_ip, INVITE_FAIL_IP_CONTEXT)}`,
    };
  }

  /** A 30401: both keys counted once per attempt; a count that cannot be written is 50001. */
  async function invalidCode(
    input: LandingPrecheckInput | LandingBindInput,
    window: InviteFailWindow,
  ): Promise<{ readonly code: 30401 | 50001 }> {
    const keys = countKeys(input, window);
    try {
      await redis.namespace(INVITE_FAIL_NAMESPACE).eval(COUNT_LANDING_FAILURE, {
        keys: [
          keys.phone,
          seenKey(keys.phone, input.phone_hmac, input.attempt_key),
          keys.ip,
          seenKey(keys.ip, input.phone_hmac, input.attempt_key),
        ],
        args: [],
        ttlSeconds: window.retry_after_seconds + FAIL_KEY_GRACE_SECONDS,
      });
    } catch (error) {
      logger.warn(
        { app_id: input.app_id, channel: 'landing', error_class: errorClass(error) },
        'invite_bind_redis_failed',
      );
      return { code: 50001 };
    }
    return { code: 30401 };
  }

  function unavailable(
    trx: Transaction<DB>,
    appId: string,
    inviter: InviterRow,
    at: Date,
  ): Promise<boolean> {
    return isInviterUnavailable(deps, trx, appId, inviter, at);
  }

  return {
    async precheck(trx, input) {
      checkSubject(input);
      if (typeof input.invite_code !== 'string') {
        throw new TypeError('growth: malformed landing invite input');
      }
      const at = clock.now();
      const appId = input.app_id;
      const fields = { app_id: appId, channel: 'landing' };

      // 1. switch.
      const enabled = switchOn(await config.configValue(appId, SWITCH_KEY, trx));
      if (enabled === null) {
        logger.warn({ ...fields, config_key: SWITCH_KEY }, 'invite_bind_config_invalid');
        return { ok: false, code: 50001 };
      }
      if (!enabled) return { ok: false, code: 30408 };

      // 2. the day's 30401 counts of the phone and of the IP.
      const limit = integerConfig(
        await config.configValue(appId, FAIL_LIMIT_KEY, trx),
        DEFAULT_FAIL_LIMIT,
        1,
      );
      if (limit === null) {
        logger.warn({ ...fields, config_key: FAIL_LIMIT_KEY }, 'invite_bind_config_invalid');
        return { ok: false, code: 50001 };
      }
      const window = inviteFailWindow(at);
      const keys = countKeys(input, window);
      let phoneCount: number | null;
      let ipCount: number | null;
      try {
        const counter = redis.namespace(INVITE_FAIL_NAMESPACE);
        phoneCount = storedCount(await counter.get(keys.phone));
        ipCount = storedCount(await counter.get(keys.ip));
      } catch (error) {
        logger.warn({ ...fields, error_class: errorClass(error) }, 'invite_bind_redis_failed');
        return { ok: false, code: 50001 };
      }
      if (phoneCount === null || ipCount === null) {
        logger.warn(fields, 'invite_bind_count_malformed');
        return { ok: false, code: 50001 };
      }
      if (phoneCount >= limit || ipCount >= limit) {
        return { ok: false, code: 42901, retry_after_seconds: window.retry_after_seconds };
      }

      // 3. format of the normalised code (no lookup).
      const code = normalizeInviteCode(input.invite_code);
      if (!isInviteCodeFormat(code)) {
        return { ok: false, ...(await invalidCode(input, window)) };
      }

      // 4. an existing, available inviter of the same app.
      const inviter = await findInviterByCode(trx, appId, code);
      if (inviter === undefined || (await unavailable(trx, appId, inviter, at))) {
        return { ok: false, ...(await invalidCode(input, window)) };
      }
      return { ok: true, inviter_id: inviter.id };
    },

    async bind(trx, input) {
      checkSubject(input);
      if (!nonEmpty(input.user_id) || !nonEmpty(input.inviter_id)) {
        throw new TypeError('growth: malformed landing invite input');
      }
      const at = clock.now();
      const { app_id: appId, user_id: userId } = input;

      // 1. the relation write lock (after identity's users row and consent lock).
      await lockRelationWrites(trx, appId);

      // 2. the inviter again, at this instant.
      const inviter: InviterRow | undefined = await trx
        .withSchema('app')
        .selectFrom('users')
        .select(['id', 'phone_hmac', 'status'])
        .where('app_id', '=', appId)
        .where('id', '=', input.inviter_id)
        .executeTakeFirst();
      if (inviter === undefined || (await unavailable(trx, appId, inviter, at))) {
        const failure = await invalidCode(input, inviteFailWindow(at));
        return { result: 'failed', code: failure.code };
      }

      // 3. the conditional update (BR-INV-03).
      const updated = await trx
        .withSchema('app')
        .updateTable('users')
        .set({
          parent_id: inviter.id,
          parent_bind_source: 'landing',
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
      if (updated.numUpdatedRows === 0n) {
        logger.warn({ app_id: appId, user_id: userId }, 'invite_landing_bind_not_updated');
        return { result: 'failed', code: 50001 };
      }

      // 4. the relation log in the same transaction.
      await appendRelationChange(trx, {
        app_id: appId,
        user_id: userId,
        from_parent_id: null,
        to_parent_id: inviter.id,
        source: 'landing',
        operator: `user:${userId}`,
        reason: null,
        at,
      });
      // 5. BR-INV-24 ① (B1-35): the reward qualification in this transaction, at the bound instant.
      await qualifyAfterBind(deps.inviteReward, logger, trx, {
        app_id: appId,
        invitee_id: userId,
        inviter_id: inviter.id,
        bind_source: 'landing',
        client_ip: input.client_ip,
        at,
      });
      return { result: 'bound', parent_id: inviter.id, bound_at: at };
    },
  };
}
