// F1-02zzj (D10-281, D10-152 ④): content's dedicated write port for the configuration key
// `union.auth_alert_phones`. union encrypts the whole number group itself and hands content an
// opaque JSON object; content stores it as given (config_items and one config_item_versions row)
// with a compare-and-set on the item version, inside the caller's transaction. The key is fixed
// here, never chosen by the caller. No audit_logs row (union audits the business change) and the
// value never appears in a log line.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';

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
export class UnionAlertPhonesInputError extends Error {}

/** `expectedVersion` differs from the current version; nothing was written. */
export class UnionAlertPhonesConflictError extends Error {}

export function createUnionAlertPhonesWriter(
  options: UnionAlertPhonesWriterOptions,
): UnionAlertPhonesWriter {
  void options;
  throw new Error('NotImplemented: createUnionAlertPhonesWriter');
}
