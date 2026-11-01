// Transactional audit of the system's own actions (B1-34p; D10-551 ②, D10-552; BR-FUND-06):
// `append` inserts one app.audit_logs row on the caller's transaction, so the row commits or
// rolls back with the caller's work; it never opens a transaction of its own. Stored as
// system_actor = input.actor, admin_id null, action order_auto_hold, target orders:<order_id>,
// before / after the hold flag and the reason code, at from the injected Clock (input.at is not
// used), ip null. Satisfies settlement's RebateDependencies['audit']; production assembly belongs
// to B1-09n.
//
// Skeleton of the test phase: the implementation arrives with the task's implementation phase.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RebateHoldAudit } from '../../settlement/index.ts';

export interface SystemAuditWriterDeps {
  readonly clock: Clock;
}

export interface SystemAuditWriter {
  append(trx: Transaction<DB>, input: RebateHoldAudit): Promise<void>;
}

export function createSystemAuditWriter(deps: SystemAuditWriterDeps): SystemAuditWriter {
  void deps;
  throw new Error('NotImplemented: createSystemAuditWriter');
}
