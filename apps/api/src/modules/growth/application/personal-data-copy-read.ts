// The invite section of a personal information copy (规划/08 BR-ID-40 细则「导出范围（默认）」: 邀请关系只写
// 是否已绑定邀请人, J7; task B1-27f), for identity's PersonalDataCopySources (assembled by app.module).
// readPersonalDataCopyInvite(handle, subject) — { has_inviter } from the user's current parent_id
// in the app (false when the user does not exist); nothing of the inviter (id, nickname, phone,
// invite code) and nothing of the user's invitees. Plain SELECTs on the caller's handle (a READ
// ONLY transaction included): no locking clause (no relation write lock), no writes, no logging.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PersonalDataCopyInviteSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface PersonalDataCopyInviteRow {
  readonly has_inviter: boolean;
}

export async function readPersonalDataCopyInvite(
  handle: Kysely<DB>,
  subject: PersonalDataCopyInviteSubject,
): Promise<PersonalDataCopyInviteRow> {
  const row = await handle
    .withSchema('app')
    .selectFrom('users')
    .select('parent_id')
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.userId)
    .executeTakeFirst();
  // Only whether an inviter is bound: the parent id itself never leaves this function.
  return { has_inviter: row !== undefined && row.parent_id !== null };
}
