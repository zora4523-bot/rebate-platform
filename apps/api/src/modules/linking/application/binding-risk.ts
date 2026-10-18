// F1-07c: the ban / unban ports of the user's union bindings (BR-ID-20, BR-ID-31; ruling 2 of
// couli-runs/ADMIN-backend/f107-plan.md), called by F1-07d on its own transaction so the risk
// state change and the bindings commit or roll back together; linking stays the bindings' only
// writer.
// - blockForBan: every active / invalid / pending_auth binding of the user (all platforms) becomes
//   blocked with blocked_reason ban (row_version + 1; bound_at and the release instants kept). A
//   binding already blocked keeps its reason (admin_disable is never overwritten), released and
//   unbound rows are untouched; a second call changes nothing.
// - restoreAfterUnban: only bindings blocked for ban become invalid (blocked_reason cleared,
//   row_version + 1); admin_disable comes back only through the console's enable, deletion only
//   through the daily release task. The user authorizes again before rebates resume.
// Both take the user lock (binding-lock.ts) first, on the caller's transaction; each change is
// judged by canTransitionBinding and written by a compare-and-set on the row_version read with it
// (a writer without the lock, such as the inspection, winning the race → read again).
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-10 状态机生成器（approvals #26）
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { canTransitionBinding } from '../domain/binding-status-transitions.ts';
import { lockBindingUser } from './binding-lock.ts';

export interface BindingRiskInput {
  readonly appId: string;
  readonly userId: string;
  readonly clock: Clock;
}

/** Bounded re-reads when a writer without the user lock changed a row under us. */
const ATTEMPTS = 4;

interface RiskChange {
  readonly name: string;
  /** Whether this row is one the change applies to. */
  readonly applies: (row: {
    readonly status: string;
    readonly blocked_reason: string | null;
  }) => boolean;
  readonly to: 'blocked' | 'invalid';
  readonly blockedReason: 'ban' | null;
}

const BAN: RiskChange = {
  name: 'blockForBan',
  applies: (row) => ['active', 'invalid', 'pending_auth'].includes(row.status),
  to: 'blocked',
  blockedReason: 'ban',
};

const UNBAN: RiskChange = {
  name: 'restoreAfterUnban',
  applies: (row) => row.status === 'blocked' && row.blocked_reason === 'ban',
  to: 'invalid',
  blockedReason: null,
};

async function apply(
  trx: Transaction<DB>,
  input: BindingRiskInput,
  change: RiskChange,
): Promise<void> {
  const { appId, userId, clock } = input;
  if (!(await lockBindingUser(trx, appId, userId))) return;
  for (let attempt = 1; ; attempt += 1) {
    const rows = await trx
      .selectFrom('union_bindings')
      .select(['id', 'status', 'blocked_reason', 'row_version'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .execute();
    const due = rows.filter(change.applies);
    if (due.length === 0) return;
    const now = clock.now();
    let lost = false;
    for (const row of due) {
      if (!canTransitionBinding(row.status, change.to)) {
        throw new Error(`union_bindings: illegal status transition ${row.status} → ${change.to}`);
      }
      const updated = await trx
        .updateTable('union_bindings')
        .set((eb) => ({
          status: change.to,
          blocked_reason: change.blockedReason,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('status', '=', row.status)
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) lost = true;
    }
    if (!lost) return;
    if (attempt >= ATTEMPTS) throw new Error(`linking: ${change.name} kept losing the row`);
  }
}

/** F1-07d supplies its transaction; linking remains the binding's only writer. */
export async function blockForBan(trx: Transaction<DB>, input: BindingRiskInput): Promise<void> {
  await apply(trx, input, BAN);
}

export async function restoreAfterUnban(
  trx: Transaction<DB>,
  input: BindingRiskInput,
): Promise<void> {
  await apply(trx, input, UNBAN);
}
