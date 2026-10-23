// F1-02zzj (D10-281, D10-152 ④): content's dedicated write port for the configuration key
// `union.auth_alert_phones`. union encrypts the whole number group itself and hands content an
// opaque JSON object; content stores it as given (config_items and one config_item_versions row)
// with a compare-and-set on the item version, inside the caller's transaction. The key is fixed
// here, never chosen by the caller. No audit_logs row (union audits the business change) and the
// value never appears in a log line; a rejected call logs nothing (its input may carry markers).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import {
  kyselyUnionAlertPhonesTx,
  type UnionAlertPhonesTx,
  type UnionAlertPhonesWrite,
} from '../infra/kysely-union-alert-phones-store.ts';

type Json = DB['config_items']['value'];

/** The only key this port writes. */
export type UnionAlertPhonesKey = 'union.auth_alert_phones';

/** Opaque JSON object (union's `{ cipher }`); never null, an array or a scalar. */
export type UnionAlertPhonesValue = { readonly [field: string]: Json | undefined };

export interface UnionAlertPhonesInput {
  readonly appId: string;
  readonly value: UnionAlertPhonesValue;
  /** Current item version the caller read; 0 when the item was never written. */
  readonly expectedVersion: number;
  /** The operating admin (admin_users.id). */
  readonly adminId: string;
  readonly reason?: string | null;
}

export interface UnionAlertPhonesResult {
  /** The new item version. */
  readonly version: number;
}

export interface UnionAlertPhonesWriter {
  /**
   * Uses the caller's transaction. Throws UnionAlertPhonesInputError before writing anything for a
   * bad transaction or input, and UnionAlertPhonesConflictError, writing nothing, when
   * `expectedVersion` is not the current version.
   */
  write(trx: Transaction<DB>, input: UnionAlertPhonesInput): Promise<UnionAlertPhonesResult>;
}

export interface UnionAlertPhonesWriterOptions {
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** The transaction or the input is not acceptable; nothing was written. */
export class UnionAlertPhonesInputError extends Error {
  /** Name of the rejected field (never its value). */
  readonly field: string;

  constructor(field: string) {
    super(`union alert phones: invalid ${field}`);
    this.name = 'UnionAlertPhonesInputError';
    this.field = field;
  }
}

/** `expectedVersion` differs from the current version; nothing was written. */
export class UnionAlertPhonesConflictError extends Error {
  constructor() {
    super('union alert phones: version conflict');
    this.name = 'UnionAlertPhonesConflictError';
  }
}

export const UNION_ALERT_PHONES_KEY: UnionAlertPhonesKey = 'union.auth_alert_phones';

const INPUT_FIELDS: ReadonlySet<string> = new Set([
  'appId',
  'value',
  'expectedVersion',
  'adminId',
  'reason',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** config_items.version is int4; the next version must still fit. */
const VERSION_MAX = 2_147_483_646;
/** Same limit as the admin console's reason (AdminConfigReason, counted in code points). */
const REASON_MAX = 200;
const CONTROL = /\p{Cc}/u;

interface Checked {
  readonly appId: string;
  readonly valueJson: string;
  readonly expectedVersion: number;
  readonly adminId: string;
  readonly reason: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** JSON text of the opaque object, or null when it cannot be stored as a JSON object. */
function jsonObjectText(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && text.startsWith('{') ? text : null;
  } catch {
    // Circular structures or bigint fields.
    return null;
  }
}

/** Every check runs before the first statement; a rejected call touches nothing. */
function checked(trx: unknown, input: unknown): Checked {
  if (
    typeof trx !== 'object' ||
    trx === null ||
    (trx as { isTransaction?: unknown }).isTransaction !== true
  ) {
    throw new UnionAlertPhonesInputError('transaction');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UnionAlertPhonesInputError('input');
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) throw new UnionAlertPhonesInputError(field);
  }
  const { appId, value, expectedVersion, adminId, reason } = input as Record<string, unknown>;
  if (typeof appId !== 'string' || appId.length === 0 || CONTROL.test(appId)) {
    throw new UnionAlertPhonesInputError('appId');
  }
  const valueJson = jsonObjectText(value);
  if (valueJson === null) throw new UnionAlertPhonesInputError('value');
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > VERSION_MAX
  ) {
    throw new UnionAlertPhonesInputError('expectedVersion');
  }
  if (typeof adminId !== 'string' || !UUID.test(adminId)) {
    throw new UnionAlertPhonesInputError('adminId');
  }
  let history: string | null = null;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== 'string' || [...reason].length > REASON_MAX || CONTROL.test(reason)) {
      throw new UnionAlertPhonesInputError('reason');
    }
    history = reason;
  }
  return { appId, valueJson, expectedVersion, adminId, reason: history };
}

/** Bound statements of one caller transaction (the SQL lives in infra). */
export type UnionAlertPhonesTxOf = (trx: Transaction<DB>) => UnionAlertPhonesTx;

/** Test seam: the same writer over injected statements. Production uses the create* factory. */
export function unionAlertPhonesWriter(
  options: UnionAlertPhonesWriterOptions,
  txOf: UnionAlertPhonesTxOf,
): UnionAlertPhonesWriter {
  const { clock, logger } = options;
  return {
    async write(trx, raw) {
      const input = checked(trx, raw);
      const tx = txOf(trx);
      const write: UnionAlertPhonesWrite = {
        appId: input.appId,
        key: UNION_ALERT_PHONES_KEY,
        valueJson: input.valueJson,
        updatedBy: input.adminId,
        adminId: input.adminId,
        reason: input.reason,
        at: clock.now(),
      };
      // Lock first, then decide; a missing row is version 0.
      const current = (await tx.lockVersion(input.appId, UNION_ALERT_PHONES_KEY)) ?? 0;
      if (current !== input.expectedVersion) throw new UnionAlertPhonesConflictError();
      // A concurrent first write that committed meanwhile makes the insert a miss: a conflict.
      const version =
        current === 0 ? await tx.insert(write) : await tx.update(write, input.expectedVersion);
      if (version === undefined) throw new UnionAlertPhonesConflictError();
      await tx.history(write, version);
      logger.info(
        { app_id: input.appId, key: UNION_ALERT_PHONES_KEY, version },
        'union_alert_phones_written',
      );
      return { version };
    },
  };
}

export function createUnionAlertPhonesWriter(
  options: UnionAlertPhonesWriterOptions,
): UnionAlertPhonesWriter {
  return unionAlertPhonesWriter(options, kyselyUnionAlertPhonesTx);
}
