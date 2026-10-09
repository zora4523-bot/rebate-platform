// BR-ID-37 同设备多账号 (task B1-03k §9.2, §9.4): judged when a withdrawal is accepted (and, later,
// when a reward is granted). Identity implements SameDeviceLoginReader (login_logs, users,
// user_oauth are its tables); the ranking, the merge tombstone dedupe, the threshold and the
// configuration fallbacks are risk's (../domain/same-device-ranking.ts).
//
// judge(handle, input): the window is [at − 720 h, at], both ends closed, where `at` is the
// judgement instant. Every read (configuration included) and every write goes through the caller's
// handle, so the hit rows commit or roll back with the caller's transaction and no pooled
// connection is borrowed. A rank ≥ risk.device_login_accounts_limit (default 3) on any device marks
// the subject; each marked device gets one risk_hits row (rule SAME_DEVICE_MULTI_ACCOUNT,
// manual_review, dimension device, value_hmac = the device_hash, ref = the withdrawal). The rule row
// is created first (ON CONFLICT DO NOTHING). Nothing else is written: no user state, no session, no
// ban (BR-ID-37: marking only).
//
// Serialisation: inside the caller's transaction judge() first takes a transaction-level advisory
// lock on (app_id, ref_type, ref_id) (pg_advisory_xact_lock, the B1-03f identity devices pattern),
// then looks for prior hits, ranks and writes. Two judgements of one withdrawal therefore run one
// after the other: the later one starts after the earlier one's transaction ended, so it sees the
// committed hit rows and replays instead of ranking at a newer instant (which could add a device
// that only became a hit later). Other withdrawals are never blocked. Outside a transaction (no
// transactional entry point) the lock would be released at the end of its own statement, so it is
// not taken; that path relies on the unique index and the re-read below.
//
// Replays: a withdrawal judged and marked once keeps its answer. judge() first looks for this
// rule's risk_hits rows on the same ref; when there are some, `at` is their created_at (the Clock
// instant of the first judgement) instead of the Clock's now, nothing is written and the answer is
// marked (login_logs is insert-only and the window's upper end is fixed, so the ranking is the
// first one even after the window has slid). Otherwise `at` is the Clock's now. A concurrent
// judgement that loses the insert race (risk_hits_same_device_once_key, ON CONFLICT DO NOTHING)
// re-reads the winner's instant the same way (a fallback for the unlocked path). An unmarked first
// judgement leaves no record.
//
// Configuration: risk.device_login_accounts_limit is a safe positive integer, else 3;
// risk.merge_tombstone_dedupe is a JSON boolean, else on. A malformed value or a failed read logs
// one warn line (key only, no value). Inside the caller's transaction each read runs under a
// savepoint, so a statement-level failure (a statement timeout, say) is rolled back to it and the
// transaction stays usable for the default; connection-level failures (SQLSTATE classes 08 and
// 57P) are rethrown.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { newUuidV7, type Clock, type RootLogger } from '../../platform/index.ts';
import {
  parseAccountsLimit,
  parseDedupe,
  rankSameDeviceAccounts,
} from '../domain/same-device-ranking.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** identity returns first successful logins per account/device in the closed window.
 * Include merged tombstones and their target IDs from user_oauth; risk owns dedupe/ranking.
 * Return all accounts on devices the subject logged into in this window; omit null hashes.
 */
export interface SameDeviceFirstLogin {
  readonly device_hash: string;
  readonly user_id: string;
  readonly first_login_at: Date;
  readonly login_log_id: bigint;
  readonly status: string;
  readonly deleted_reason: string | null;
  readonly merged_into_user_id: string | null;
}

export interface SameDeviceLoginReader {
  read(
    handle: Kysely<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      readonly window_start: Date;
      readonly window_end: Date;
    },
  ): Promise<readonly SameDeviceFirstLogin[]>;
}

export interface SameDeviceAccountsInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly ref: { readonly type: 'withdrawal'; readonly id: string };
}

export interface SameDeviceAccountsResult {
  readonly marked: boolean;
  readonly devices: readonly { readonly device_hash: string; readonly rank: number }[];
}

export interface SameDeviceAccountsCheck {
  judge(handle: Kysely<DB>, input: SameDeviceAccountsInput): Promise<SameDeviceAccountsResult>;
}

export interface SameDeviceAccountsOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly logins: SameDeviceLoginReader;
  /** Bind the existing configuration port to the caller's handle; no pooled reads. */
  readonly config: (handle: Kysely<DB>) => RateLimitConfigReader;
}

/** BR-ID-37: the sliding window, 720 hours. */
const WINDOW_MS = 720 * 60 * 60 * 1000;
const LIMIT_KEY = 'risk.device_login_accounts_limit';
const DEDUPE_KEY = 'risk.merge_tombstone_dedupe';
const DEFAULT_LIMIT = 3;
const RULE_ID = 'SAME_DEVICE_MULTI_ACCOUNT';
const RISK_ACTION = 'manual_review';

const SAME_DEVICE_ACCOUNTS_CHECK = Symbol('SAME_DEVICE_ACCOUNTS_CHECK');
const SAME_DEVICE_LOGIN_READER = Symbol('SAME_DEVICE_LOGIN_READER');

/** `instant` minus `ms` as a new Date (the Clock's instant is never modified). */
function earlierBy(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() - ms);
  return result;
}

/** SQLSTATE classes after which the connection (not just the statement) is gone: rethrow. */
function unrecoverable(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (code.startsWith('08') || code.startsWith('57P'));
}

const CONFIG_SAVEPOINT = sql.raw('same_device_config');

export function createSameDeviceAccountsCheck(
  options: SameDeviceAccountsOptions,
): SameDeviceAccountsCheck {
  const { clock, logger, logins } = options;

  /**
   * The stored value of one key; undefined when missing. A failed read logs and is undefined,
   * except a connection-level failure, which is rethrown. Inside a transaction the read runs under
   * a savepoint so that a failed statement does not abort the caller's transaction.
   */
  async function configured(
    handle: Kysely<DB>,
    reader: RateLimitConfigReader,
    appId: string,
    key: string,
  ): Promise<{ readonly found: boolean; readonly value: unknown }> {
    const guarded = handle.isTransaction;
    if (guarded) await sql`SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(handle);
    let found: Awaited<ReturnType<RateLimitConfigReader['configValue']>>;
    try {
      found = await reader.configValue(appId, key);
    } catch (error) {
      if (unrecoverable(error)) throw error;
      if (guarded) {
        await sql`ROLLBACK TO SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(handle);
        await sql`RELEASE SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(handle);
      }
      logger.warn({ app_id: appId, key }, 'same_device_config_unavailable');
      return { found: false, value: undefined };
    }
    if (guarded) await sql`RELEASE SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(handle);
    return found === null
      ? { found: false, value: undefined }
      : { found: true, value: found.value };
  }

  async function settings(
    handle: Kysely<DB>,
    appId: string,
  ): Promise<{ readonly limit: number; readonly dedupe: boolean }> {
    const reader = options.config(handle);
    const limitValue = await configured(handle, reader, appId, LIMIT_KEY);
    const dedupeValue = await configured(handle, reader, appId, DEDUPE_KEY);
    let limit = parseAccountsLimit(limitValue.value);
    if (limit === null) {
      if (limitValue.found)
        logger.warn({ app_id: appId, key: LIMIT_KEY }, 'same_device_config_invalid');
      limit = DEFAULT_LIMIT;
    }
    let dedupe = parseDedupe(dedupeValue.value);
    if (dedupe === null) {
      if (dedupeValue.found) {
        logger.warn({ app_id: appId, key: DEDUPE_KEY }, 'same_device_config_invalid');
      }
      dedupe = true;
    }
    return { limit, dedupe };
  }

  /** Transaction-level lock of one judged ref; held until the caller's transaction ends. */
  async function lockRef(handle: Kysely<DB>, input: SameDeviceAccountsInput): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`risk.same_device:${input.app_id}:${input.ref.type}:${input.ref.id}`}, 0))`.execute(
      handle,
    );
  }

  /** The instant of an earlier judgement of this ref that wrote hit rows; null when none. */
  async function judgedAt(
    handle: Kysely<DB>,
    input: SameDeviceAccountsInput,
  ): Promise<Date | null> {
    const prior = await handle
      .withSchema('app')
      .selectFrom('risk_hits')
      .select('created_at')
      .where('app_id', '=', input.app_id)
      .where('rule_id', '=', RULE_ID)
      .where('ref_type', '=', input.ref.type)
      .where('ref_id', '=', input.ref.id)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    return prior === undefined ? null : prior.created_at;
  }

  /** Ranks every device the subject used in the window [at − 720 h, at]. */
  async function rank(
    handle: Kysely<DB>,
    input: SameDeviceAccountsInput,
    at: Date,
  ): Promise<{
    readonly devices: SameDeviceAccountsResult['devices'];
    readonly hit: SameDeviceAccountsResult['devices'];
  }> {
    const { limit, dedupe } = await settings(handle, input.app_id);
    const rows = await logins.read(handle, {
      app_id: input.app_id,
      user_id: input.user_id,
      window_start: earlierBy(at, WINDOW_MS),
      window_end: at,
    });
    const devices = rankSameDeviceAccounts(rows, input.user_id, dedupe);
    return { devices, hit: devices.filter((device) => device.rank >= limit) };
  }

  /** Answer of a ref already marked at `at`: the first ranking, no write. */
  async function replay(
    handle: Kysely<DB>,
    input: SameDeviceAccountsInput,
    at: Date,
  ): Promise<SameDeviceAccountsResult> {
    const { devices } = await rank(handle, input, at);
    return { marked: true, devices };
  }

  return {
    async judge(handle, input) {
      if (handle.isTransaction) await lockRef(handle, input);
      const prior = await judgedAt(handle, input);
      if (prior !== null) return replay(handle, input, prior);
      const now = clock.now();
      const { devices, hit } = await rank(handle, input, now);
      if (hit.length === 0) return { marked: false, devices };
      const app = handle.withSchema('app');
      await app
        .insertInto('risk_rules')
        .values({
          id: newUuidV7(now),
          app_id: input.app_id,
          rule_id: RULE_ID,
          scene: 'withdrawal',
          conditions: sql`'{}'::jsonb`,
          risk_action: RISK_ACTION,
          status: 'active',
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['app_id', 'rule_id']).doNothing())
        .execute();
      // One statement, rows in device_hash order: concurrent judgements lock keys in one order.
      const inserted = await app
        .insertInto('risk_hits')
        .values(
          hit.map((device) => ({
            app_id: input.app_id,
            user_id: input.user_id,
            rule_id: RULE_ID,
            risk_action: RISK_ACTION,
            dimension: 'device',
            value_hmac: device.device_hash,
            ref_type: input.ref.type,
            ref_id: input.ref.id,
            created_at: now,
          })),
        )
        // No conflict target: the only unique index a same-device row can meet besides the
        // identity key is the partial risk_hits_same_device_once_key (inferring a partial index
        // from a parameterised predicate is not reliable).
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .execute();
      if (inserted.length < hit.length) {
        // A concurrent judgement of this ref committed first: answer with its instant.
        const winner = await judgedAt(handle, input);
        if (winner !== null && winner.getTime() !== now.getTime()) {
          return replay(handle, input, winner);
        }
      }
      logger.info(
        {
          app_id: input.app_id,
          rule_id: RULE_ID,
          ref_type: input.ref.type,
          ref_id: input.ref.id,
          devices: hit.length,
        },
        'risk_same_device_multi_account',
      );
      return { marked: true, devices };
    },
  };
}

/** Nest token of the SameDeviceAccountsCheck that RiskModule provides. */
export function sameDeviceAccountsCheckToken(): symbol {
  return SAME_DEVICE_ACCOUNTS_CHECK;
}

/** Nest token of identity's SameDeviceLoginReader inside RiskModule. */
export function sameDeviceLoginReaderToken(): symbol {
  return SAME_DEVICE_LOGIN_READER;
}
