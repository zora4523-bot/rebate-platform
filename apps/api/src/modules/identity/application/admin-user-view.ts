import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable } from 'kysely';

/** Internal read result; decrypted phone must never be returned as a user view. */
export interface AdminUserViewSource {
  readonly user: Readonly<
    Pick<
      Selectable<DB['users']>,
      | 'id'
      | 'nickname'
      | 'level'
      | 'invite_code'
      | 'parent_id'
      | 'register_method'
      | 'registered_channel'
      | 'created_at'
    >
  >;
  readonly phone: string | null;
  readonly risk: Readonly<Schema<'AdminUserRiskState'>>;
  readonly unionBindings: readonly Readonly<Schema<'AdminUserUnionBinding'>>[];
}

/** Read capability for the later list/detail routes; appId comes from the admin actor. */
export interface AdminUserViewReader {
  read(input: {
    readonly appId: string;
    readonly userId: string;
  }): Promise<AdminUserViewSource | null>;
}

/** Both permitted view shapes whitelist fields; neither permits plaintext, even for a super. */
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'list',
): Schema<'AdminUserListItem'>;
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'detail',
): Schema<'AdminUserDetail'>;
export function projectAdminUser(
  source: AdminUserViewSource,
  view: 'list' | 'detail',
): Schema<'AdminUserListItem'> | Schema<'AdminUserDetail'> {
  void source;
  void view;
  throw new Error('NotImplemented: projectAdminUser');
}
