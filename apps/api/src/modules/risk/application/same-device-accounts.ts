// BR-ID-37 同设备多账号 (tasks B1-03k, B1-03n): judged when a withdrawal is accepted (and, later,
// when a reward is granted), once per judged object. Identity implements SameDeviceLoginReader
// (login_logs, users, user_oauth are its tables); the ranking, the merge tombstone dedupe, the
// threshold and the configuration fallbacks are risk's (../domain/same-device-ranking.ts).
//
// judge(handle, input): the window is [at − 720 h, at], both ends closed, where `at` is the Clock's
// now at the first judgement. A rank ≥ risk.device_login_accounts_limit (default 3) on any device
// marks the subject; each marked device gets one risk_hits row (rule SAME_DEVICE_MULTI_ACCOUNT,
// manual_review, dimension device, value_hmac = the device_hash, ref = the withdrawal). Nothing
// else is written: no user state, no session, no ban (BR-ID-37: marking only).
//
// One conclusion per judged object (B1-03n): the first judgement, marked or not, inserts one
// app.risk_judgements row keyed by (app_id, rule_id, ref_type, ref_id) (unique constraint
// risk_judgements_ref_key) whose `result` is the full answer, devices and ranks included. Every
// later judgement of the same object returns that stored `result` verbatim: no configuration read,
// no login read, no ranking, no write. So a configuration read that failed (and fell back to the
// defaults) at the first judgement cannot be contradicted by a retry that reads the real values,
// and a window that slid or accounts merged since do not change the answer. B1-03k risk_hits rows
// without a judgement row are not replayed (and not backfilled): such a ref is judged afresh.
//
// Transactions: every read (configuration included) and write runs in one transaction. A
// transaction handle is used as is, so the rows commit or roll back with the caller's work; any
// other handle gets its own read committed transaction around the whole judgement. Inside it,
// judge() first refuses repeatable read and serializable (SameDeviceIsolationError: a snapshot
// taken before the lock would miss a judgement committed while waiting for it), then takes a
// transaction-level advisory lock on (app_id, ref_type, ref_id), then looks up the stored
// judgement. Two judgements of one object therefore run one after the other and the later one
// replays. The rule row is registered first (ON CONFLICT DO NOTHING; the judgement row references
// it), then the judgement row is inserted ON CONFLICT DO NOTHING before any hit row: when a
// concurrent writer that bypassed the lock committed the judgement first, nothing is inserted, no
// hit row is written and the stored result is re-read and returned.
//
// Configuration: risk.device_login_accounts_limit is a safe positive integer, else 3;
// risk.merge_tombstone_dedupe is a JSON boolean, else on. A malformed value or a failed read logs
// one warn line (key only, no value) and uses the default (BR: unconfigured means the default; the
// conclusion is persisted, so a retry replays it). Each read runs under a savepoint, so a
// statement-level failure (a statement timeout, say) is rolled back to it and the transaction
// stays usable for the default; connection-level failures (SQLSTATE classes 08 and 57P) are
// rethrown.
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
  /** Bind the existing configuration port to the judging transaction; no pooled reads. */
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

/** Snapshot isolation levels under which the lookup after the lock could miss a commit. */
const SNAPSHOT_ISOLATION: ReadonlySet<string> = new Set(['repeatable read', 'serializable']);

/** judge() was called inside a repeatable read or serializable transaction. */
export class SameDeviceIsolationError extends Error {
  constructor(isolation: string) {
    super(`same-device judgement needs read committed, not ${isolation}`);
    this.name = 'SameDeviceIsolationError';
  }
}

/** A stored risk_judgements.result as the judge's answer; throws on a malformed value. */
function storedResult(value: unknown): SameDeviceAccountsResult {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const { marked, devices } = value as { marked?: unknown; devices?: unknown };
    if (typeof marked === 'boolean' && Array.isArray(devices)) {
      const parsed: { device_hash: string; rank: number }[] = [];
      for (const device of devices as unknown[]) {
        if (typeof device !== 'object' || device === null) break;
        const { device_hash: hash, rank } = device as { device_hash?: unknown; rank?: unknown };
        if (typeof hash !== 'string' || typeof rank !== 'number' || !Number.isSafeInteger(rank)) {
          break;
        }
        parsed.push({ device_hash: hash, rank });
      }
      if (parsed.length === devices.length) return { marked, devices: parsed };
    }
  }
  throw new Error('same-device judgement: stored result malformed');
}

export function createSameDeviceAccountsCheck(
  options: SameDeviceAccountsOptions,
): SameDeviceAccountsCheck {
  const { clock, logger, logins } = options;

  /**
   * The stored value of one key; undefined when missing. A failed read logs and is undefined,
   * except a connection-level failure, which is rethrown. The read runs under a savepoint (judge
   * always runs in a transaction) so that a failed statement does not abort the transaction.
   */
  async function configured(
    trx: Kysely<DB>,
    reader: RateLimitConfigReader,
    appId: string,
    key: string,
  ): Promise<{ readonly found: boolean; readonly value: unknown }> {
    await sql`SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(trx);
    let found: Awaited<ReturnType<RateLimitConfigReader['configValue']>>;
    try {
      found = await reader.configValue(appId, key);
    } catch (error) {
      if (unrecoverable(error)) throw error;
      await sql`ROLLBACK TO SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(trx);
      await sql`RELEASE SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(trx);
      logger.warn({ app_id: appId, key }, 'same_device_config_unavailable');
      return { found: false, value: undefined };
    }
    await sql`RELEASE SAVEPOINT ${CONFIG_SAVEPOINT}`.execute(trx);
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

  /** Transaction-level lock of one judged ref; held until the transaction ends. */
  async function lockRef(trx: Kysely<DB>, input: SameDeviceAccountsInput): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`risk.same_device:${input.app_id}:${input.ref.type}:${input.ref.id}`}, 0))`.execute(
      trx,
    );
  }

  /** Refuses the snapshot isolation levels, before the lock (as identity's registration does). */
  async function requireReadCommitted(trx: Kysely<DB>): Promise<void> {
    const { rows } = await sql<{
      isolation: string;
    }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(trx);
    const isolation = rows[0]?.isolation;
    if (typeof isolation !== 'string') {
      throw new Error('same-device judgement: transaction_isolation unread');
    }
    if (SNAPSHOT_ISOLATION.has(isolation)) throw new SameDeviceIsolationError(isolation);
  }

  /** The stored conclusion of this ref; null when it was never judged. */
  async function stored(
    trx: Kysely<DB>,
    input: SameDeviceAccountsInput,
  ): Promise<SameDeviceAccountsResult | null> {
    const row = await trx
      .withSchema('app')
      .selectFrom('risk_judgements')
      .select('result')
      .where('app_id', '=', input.app_id)
      .where('rule_id', '=', RULE_ID)
      .where('ref_type', '=', input.ref.type)
      .where('ref_id', '=', input.ref.id)
      .executeTakeFirst();
    return row === undefined ? null : storedResult(row.result);
  }

  /** Ranks every device the subject used in the window [at − 720 h, at]. */
  async function rank(
    trx: Kysely<DB>,
    input: SameDeviceAccountsInput,
    at: Date,
  ): Promise<{
    readonly devices: SameDeviceAccountsResult['devices'];
    readonly hit: SameDeviceAccountsResult['devices'];
  }> {
    const { limit, dedupe } = await settings(trx, input.app_id);
    const rows = await logins.read(trx, {
      app_id: input.app_id,
      user_id: input.user_id,
      window_start: earlierBy(at, WINDOW_MS),
      window_end: at,
    });
    const devices = rankSameDeviceAccounts(rows, input.user_id, dedupe);
    return { devices, hit: devices.filter((device) => device.rank >= limit) };
  }

  /** The whole judgement inside one transaction (the caller's or judge's own). */
  async function judgeIn(
    trx: Kysely<DB>,
    input: SameDeviceAccountsInput,
  ): Promise<SameDeviceAccountsResult> {
    await requireReadCommitted(trx);
    await lockRef(trx, input);
    const prior = await stored(trx, input);
    if (prior !== null) return prior;
    const now = clock.now();
    const { devices, hit } = await rank(trx, input, now);
    const result: SameDeviceAccountsResult = { marked: hit.length > 0, devices };
    const app = trx.withSchema('app');
    // The judgement row references the rule row, so it is registered whatever the conclusion.
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
    // The judgement row first: a loser of the unique constraint writes no hit row.
    const judged = await app
      .insertInto('risk_judgements')
      .values({
        app_id: input.app_id,
        rule_id: RULE_ID,
        ref_type: input.ref.type,
        ref_id: input.ref.id,
        user_id: input.user_id,
        marked: result.marked,
        result: sql`CAST(${JSON.stringify(result)} AS jsonb)`,
        judged_at: now,
      })
      .onConflict((oc) => oc.columns(['app_id', 'rule_id', 'ref_type', 'ref_id']).doNothing())
      .returning('id')
      .execute();
    if (judged.length === 0) {
      // Another writer committed this ref's judgement first: its conclusion is the answer.
      const winner = await stored(trx, input);
      if (winner === null) throw new Error('same-device judgement: conflicting row unread');
      return winner;
    }
    if (hit.length === 0) return result;
    // One statement, rows in device_hash order: concurrent judgements lock keys in one order.
    await app
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
      // identity key is the partial risk_hits_same_device_once_key (a B1-03k row of this ref).
      .onConflict((oc) => oc.doNothing())
      .execute();
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
    return result;
  }

  return {
    async judge(handle, input) {
      if (handle.isTransaction) return judgeIn(handle, input);
      return handle
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) => judgeIn(trx, input));
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
