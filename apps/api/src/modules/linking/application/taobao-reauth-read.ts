// linking's read-only port for notification's unbanned message (B1-12g, BR-TEXT-23 {need_reauth}):
// whether the user's Taobao union binding is currently invalid. SELECT only, on the caller's
// transaction; linking stays the single writer of union_bindings.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface TaobaoReauthScope {
  readonly appId: string;
  readonly userId: string;
}

export type TaobaoReauthReader = (
  trx: Transaction<DB>,
  scope: TaobaoReauthScope,
) => Promise<boolean>;

/** B1-12g: SELECT only; true iff this app/user currently has a Taobao invalid binding. */
export async function needsTaobaoReauth(
  trx: Transaction<DB>,
  scope: TaobaoReauthScope,
): Promise<boolean> {
  // At most one live binding per (app_id, user_id, platform) (union_bindings_user_platform_key).
  const row = await trx
    .withSchema('app')
    .selectFrom('union_bindings')
    .select('id')
    .where('app_id', '=', scope.appId)
    .where('user_id', '=', scope.userId)
    .where('platform', '=', 'taobao')
    .where('status', '=', 'invalid')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
