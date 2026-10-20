// F1-02zk (BR-FUND-19 / BR-FUND-20): the system's own write of an emergency switch. Only the
// safe direction is offered (settle.auto.enabled → false); reopening stays an admin write with
// switch.all and step-up. The write shares the admin path's version counter and change history,
// runs inside the caller's transaction, and alerts only when the caller reports a commit.
// audit_logs is not written: its admin_id is a non-null foreign key to admin_users, so the
// history row (updated_by `system`, no admin id, reason `<source>:<reason>`) and the committed
// alert stand in for the audit record (D-S4).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import { switchSpecOf } from '../domain/switch-registry.ts';
import {
  kyselySystemSwitchTx,
  type SystemSwitchRow,
  type SystemSwitchTx,
  type SystemSwitchWrite,
} from '../infra/kysely-system-switch-store.ts';

/** F1-02zk: only BR-FUND-19's automatic safe-direction write is exposed. */
export interface SystemSwitchInput {
  readonly appId: string;
  readonly key: 'settle.auto.enabled';
  readonly source: string;
  readonly reason: string;
}

export interface SystemSwitchResult {
  readonly key: 'settle.auto.enabled';
  readonly changed: boolean;
  readonly version: number;
  /** Stored JSON before the change; null when no row existed. */
  readonly fromValue: DB['config_items']['value'];
}

export interface SystemSwitchWriter {
  /** Uses the caller's transaction, including the history insert; never alerts here. */
  turnOff(trx: Transaction<DB>, input: SystemSwitchInput): Promise<SystemSwitchResult>;
  /** Caller invokes this only after its transaction commits; unchanged results stay silent. */
  alertCommitted(input: SystemSwitchInput, result: SystemSwitchResult): void;
}

export interface SystemSwitchWriterOptions {
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn'>;
}

/** The writer's name in config_items.updated_by and config_item_versions.updated_by. */
export const SYSTEM_ACTOR = 'system';

/** Keys this port may switch off: registered systemWritten booleans whose safe value is false. */
const OFF_KEYS: ReadonlySet<string> = new Set(['settle.auto.enabled']);
const INPUT_FIELDS: ReadonlySet<string> = new Set(['appId', 'key', 'source', 'reason']);
const SOURCE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const SOURCE_MAX = 32;
/** Same limit as the admin console's reason (AdminConfigReason, counted in code points). */
const REASON_MAX = 200;
const CONTROL = /\p{Cc}/u;

export class SystemSwitchInputError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`system switch: invalid ${field}`);
    this.name = 'SystemSwitchInputError';
    this.field = field;
  }
}

const length = (text: string) => [...text].length;

/** Every check runs before the first statement; a rejected call touches nothing. */
function checked(trx: unknown, input: unknown): { input: SystemSwitchInput; history: string } {
  if (
    typeof trx !== 'object' ||
    trx === null ||
    (trx as { isTransaction?: unknown }).isTransaction !== true
  ) {
    throw new SystemSwitchInputError('transaction');
  }
  if (typeof input !== 'object' || input === null) throw new SystemSwitchInputError('input');
  // No value field (or anything else) may ride along: the port only ever writes false.
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) throw new SystemSwitchInputError(field);
  }
  const { appId, key, source, reason } = input as Record<string, unknown>;
  if (typeof appId !== 'string' || appId.length === 0) throw new SystemSwitchInputError('appId');
  const spec = typeof key === 'string' && OFF_KEYS.has(key) ? switchSpecOf(key) : null;
  if (spec === null || !spec.systemWritten || spec.valueType.kind !== 'boolean') {
    throw new SystemSwitchInputError('key');
  }
  if (typeof source !== 'string' || source.length > SOURCE_MAX || !SOURCE.test(source)) {
    throw new SystemSwitchInputError('source');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || CONTROL.test(reason)) {
    throw new SystemSwitchInputError('reason');
  }
  const history = `${source}:${reason}`;
  if (length(history) > REASON_MAX) throw new SystemSwitchInputError('reason');
  return { input: { appId, key: 'settle.auto.enabled', source, reason }, history };
}

/** Bound statements of one caller transaction (the SQL lives in infra). */
export type SystemSwitchTxOf = (trx: Transaction<DB>) => SystemSwitchTx;

/** Test seam: the same writer over injected statements. Production uses createSystemSwitchWriter. */
export function systemSwitchWriter(
  options: SystemSwitchWriterOptions,
  txOf: SystemSwitchTxOf,
): SystemSwitchWriter {
  const { clock, logger } = options;
  return {
    async turnOff(trx, raw) {
      const { input, history } = checked(trx, raw);
      const tx = txOf(trx);
      const write: SystemSwitchWrite = {
        appId: input.appId,
        key: input.key,
        updatedBy: SYSTEM_ACTOR,
        reason: history,
        at: clock.now(),
      };
      const unchanged = (row: SystemSwitchRow): SystemSwitchResult => ({
        key: input.key,
        changed: false,
        version: row.version,
        fromValue: row.value,
      });
      // Lock first, then decide; never insert or update on an unlocked read.
      let before = await tx.lock(input.appId, input.key);
      if (before === undefined) {
        const inserted = await tx.insertOff(write);
        if (inserted !== undefined) {
          await tx.history(write, inserted.version);
          return { key: input.key, changed: true, version: inserted.version, fromValue: null };
        }
        // A concurrent first write committed in between: lock that row and decide again.
        before = await tx.lock(input.appId, input.key);
        if (before === undefined) throw new Error('system switch: row vanished after conflict');
      }
      // Only the boolean false is off; any other stored value (true or corrupt) is replaced.
      if (before.value === false) return unchanged(before);
      const row = await tx.updateOff(write, before.version);
      // The row is locked, so a miss means the lock did not hold; fail rather than skip.
      if (row === undefined) throw new Error('system switch: locked row changed');
      await tx.history(write, row.version);
      return { key: input.key, changed: true, version: row.version, fromValue: before.value };
    },

    alertCommitted(input, result) {
      if (!result.changed) return;
      logger.warn(
        {
          key: result.key,
          from_value: result.fromValue,
          to_value: false,
          version: result.version,
          app_id: input.appId,
          actor: SYSTEM_ACTOR,
          source: input.source,
          reason: input.reason,
        },
        'config_change_alert',
      );
    },
  };
}

export function createSystemSwitchWriter(options: SystemSwitchWriterOptions): SystemSwitchWriter {
  return systemSwitchWriter(options, kyselySystemSwitchTx);
}
