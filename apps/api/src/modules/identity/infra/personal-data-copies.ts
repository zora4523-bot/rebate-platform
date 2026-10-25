// app.personal_data_copies writes outside the generation worker (task B1-27h; 08 BR-ID-40 细则
// 「副本请求与注销状态」「重新登记与登记人停用」, BR-ID-43; brief §9 ⑥ ⑦). identity is the table's only
// writer; every status change here is a conditional UPDATE (no generated state machine: the table is
// not in specs/state-machines), row_version + 1 and updated_at = the caller's instant.
//   - failWecomCopiesOfRegistrant: the account-disable step (admin's disable transaction, beside the
//     export canceller): the registrant's undelivered wecom_session requests (pending / running /
//     ready) → failed, one audit row each naming the disabling admin. in_app_sms requests, delivered
//     ones and other registrants' are left. The file of a ready request stays recorded in
//     object_key; its expire job (sent when it was generated) deletes it at expires_at.
//   - cancelOpenCopiesOfUser: the deletion cleanup step (identity's cleanup transaction, users row
//     already locked): the user's pending / running / ready requests → cancelled.
//   - deleteCopyFilesOfUser: after that transaction committed, every file of the user still recorded
//     in object_key (delivered and not yet expired ones included) is deleted from the store and
//     object_key cleared; a failed delete is one warn line (no error message) and the file stays
//     recorded, for its expire job.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AuditPort, Clock, ExportStore, RootLogger } from '../../platform/index.ts';

export const DATA_COPY_OPEN_STATUSES = ['pending', 'running', 'ready'] as const;
export const DATA_COPY_AUDIT_FAIL = 'user_data_copy_fail';
export const DATA_COPY_REASON_REGISTRANT_DISABLED = '登记人后台账号已停用，请由接手的客服重新登记';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z0-9_]{1,32}$/;

export function dataCopyAuditTarget(copyId: string): string {
  return `personal_data_copies:${copyId}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export interface WecomCopyFailInput {
  readonly appId: string;
  /** The registrant whose admin account is being disabled. */
  readonly adminId: string;
  /** The disabling super admin (audit actor). */
  readonly actor: string;
  readonly ip: string | null;
}

/**
 * On the caller's transaction (admin's disable): the registrant's undelivered wecom_session
 * requests → failed, one audit row each through `audit` (bound to that transaction). Returns how
 * many requests failed; nothing for ids of the wrong shape.
 */
export async function failWecomCopiesOfRegistrant(
  trx: Kysely<DB>,
  input: WecomCopyFailInput,
  deps: { readonly clock: Clock; readonly audit: AuditPort },
): Promise<number> {
  if (!APP_ID.test(input.appId) || !UUID.test(input.adminId)) return 0;
  const db = trx.withSchema('app');
  const rows = await db
    .selectFrom('personal_data_copies')
    .select(['id', 'user_id', 'status', 'row_version'])
    .where('app_id', '=', input.appId)
    .where('requested_by', '=', input.adminId)
    .where('delivery', '=', 'wecom_session')
    .where('status', 'in', [...DATA_COPY_OPEN_STATUSES])
    .orderBy('id')
    .forUpdate()
    .execute();
  let count = 0;
  for (const row of rows) {
    const now = deps.clock.now();
    const result = await db
      .updateTable('personal_data_copies')
      .set({
        status: 'failed',
        failure_reason: DATA_COPY_REASON_REGISTRANT_DISABLED,
        updated_at: now,
        row_version: row.row_version + 1,
      })
      .where('app_id', '=', input.appId)
      .where('id', '=', row.id)
      .where('status', '=', row.status)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) continue;
    await deps.audit.append({
      appId: input.appId,
      actor: input.actor,
      action: DATA_COPY_AUDIT_FAIL,
      target: dataCopyAuditTarget(row.id),
      before: { status: row.status },
      after: {
        copy_id: row.id,
        user_id: row.user_id,
        delivery: 'wecom_session',
        status: 'failed',
        cause: 'registrant_disabled',
        registrant_id: input.adminId,
      },
      ip: input.ip,
    });
    count += 1;
  }
  return count;
}

/** On identity's cleanup transaction: the user's open requests → cancelled; how many. */
export async function cancelOpenCopiesOfUser(
  trx: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string; readonly at: Date },
): Promise<number> {
  const result = await trx
    .withSchema('app')
    .updateTable('personal_data_copies')
    .set((eb) => ({
      status: 'cancelled',
      updated_at: input.at,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('status', 'in', [...DATA_COPY_OPEN_STATUSES])
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/**
 * Outside any transaction, after the cancellation committed: deletes every file of the user still
 * recorded in object_key and clears it (CAS on the key); a failed delete keeps the record.
 */
export async function deleteCopyFilesOfUser(
  db: Kysely<DB>,
  input: { readonly appId: string; readonly userId: string },
  deps: {
    readonly clock: Clock;
    readonly store: Pick<ExportStore, 'delete'>;
    readonly logger: RootLogger;
  },
): Promise<number> {
  const handle = db.withSchema('app');
  const rows = await handle
    .selectFrom('personal_data_copies')
    .select(['id', 'object_key'])
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('object_key', 'is not', null)
    .orderBy('id')
    .execute();
  let deleted = 0;
  for (const row of rows) {
    const key = row.object_key;
    if (key === null) continue;
    try {
      await deps.store.delete(key);
    } catch (error) {
      deps.logger.warn(
        { app_id: input.appId, copy_id: row.id, error_name: errorName(error) },
        'identity_data_copy_file_delete_failed',
      );
      continue;
    }
    await handle
      .updateTable('personal_data_copies')
      .set((eb) => ({
        object_key: null,
        updated_at: deps.clock.now(),
        row_version: eb('row_version', '+', 1),
      }))
      .where('app_id', '=', input.appId)
      .where('id', '=', row.id)
      .where('object_key', '=', key)
      .execute();
    deleted += 1;
  }
  return deleted;
}
