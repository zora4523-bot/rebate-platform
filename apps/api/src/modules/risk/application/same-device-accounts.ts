// BR-ID-37 同设备多账号 (task B1-03k §9.2, §9.4): judged when a withdrawal is accepted (and, later,
// when a reward is granted). Identity implements SameDeviceLoginReader (login_logs, users,
// user_oauth are its tables); the ranking, the merge tombstone dedupe, the threshold and the
// configuration fallbacks are risk's (../domain/same-device-ranking.ts).
//
// judge(handle, input): the window is [now − 720 h, now] of the injected Clock, both ends closed.
// Every read (configuration included) and every write goes through the caller's handle, so the
// hit rows commit or roll back with the caller's transaction and no pooled connection is borrowed.
// A rank ≥ risk.device_login_accounts_limit (default 3) on any device marks the subject; each
// marked device gets one risk_hits row (rule SAME_DEVICE_MULTI_ACCOUNT, manual_review, dimension
// device, value_hmac = the device_hash, ref = the withdrawal). The rule row is created first
// (ON CONFLICT DO NOTHING); a repeated or concurrent judgement of the same withdrawal adds no row
// (risk_hits_same_device_once_key, ON CONFLICT DO NOTHING) and answers the same result. Nothing
// else is written: no user state, no session, no ban (BR-ID-37: marking only).
//
// Configuration: risk.device_login_accounts_limit is a safe positive integer, else 3;
// risk.merge_tombstone_dedupe is a JSON boolean, else on. A malformed value or a failed read logs
// one warn line (key only, no value).
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

export function createSameDeviceAccountsCheck(
  options: SameDeviceAccountsOptions,
): SameDeviceAccountsCheck {
  const { clock, logger, logins } = options;

  /** The stored value of one key; undefined when missing; a failed read logs and is undefined. */
  async function configured(
    reader: RateLimitConfigReader,
    appId: string,
    key: string,
  ): Promise<{ readonly found: boolean; readonly value: unknown }> {
    try {
      const found = await reader.configValue(appId, key);
      return found === null
        ? { found: false, value: undefined }
        : { found: true, value: found.value };
    } catch {
      logger.warn({ app_id: appId, key }, 'same_device_config_unavailable');
      return { found: false, value: undefined };
    }
  }

  async function settings(
    handle: Kysely<DB>,
    appId: string,
  ): Promise<{ readonly limit: number; readonly dedupe: boolean }> {
    const reader = options.config(handle);
    const limitValue = await configured(reader, appId, LIMIT_KEY);
    const dedupeValue = await configured(reader, appId, DEDUPE_KEY);
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

  return {
    async judge(handle, input) {
      const now = clock.now();
      const { limit, dedupe } = await settings(handle, input.app_id);
      const rows = await logins.read(handle, {
        app_id: input.app_id,
        user_id: input.user_id,
        window_start: earlierBy(now, WINDOW_MS),
        window_end: now,
      });
      const devices = rankSameDeviceAccounts(rows, input.user_id, dedupe);
      const hit = devices.filter((device) => device.rank >= limit);
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
        // identity key is the partial risk_hits_same_device_once_key (inferring a partial index
        // from a parameterised predicate is not reliable).
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
