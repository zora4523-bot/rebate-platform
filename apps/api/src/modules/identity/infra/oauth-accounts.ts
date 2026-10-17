import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock, FieldCrypto } from '../../platform/index.ts';

export const APPLE_REFRESH_TOKEN_CONTEXT = 'user_oauth.apple_refresh_token';

/** The binding remains authoritative after Apple revokes authorization. */
export async function findOauthAccount(
  trx: Transaction<DB>,
  appId: string,
  provider: 'wechat' | 'apple',
  unionId: string,
) {
  return (
    trx
      .selectFrom('user_oauth as oauth')
      .innerJoin('users as user', (join) =>
        join.onRef('user.app_id', '=', 'oauth.app_id').onRef('user.id', '=', 'oauth.user_id'),
      )
      .select(['user.id', 'user.status', 'user.parent_bind_source'])
      .where('oauth.app_id', '=', appId)
      .where('oauth.provider', '=', provider)
      .where('oauth.union_id', '=', unionId)
      // Keep status stable without blocking the foreign-key checks of consent writers.
      .forNoKeyUpdate('user')
      .executeTakeFirst()
  );
}

/** Replace only the binding that was verified, using a row-version CAS under its row lock. */
export async function replaceAppleRefreshToken(
  trx: Transaction<DB>,
  input: { app_id: string; user_id: string; union_id: string; refresh_token: string },
  deps: { clock: Clock; crypto: FieldCrypto },
): Promise<void> {
  const binding = await trx
    .selectFrom('user_oauth')
    .select(['id', 'row_version'])
    .where('app_id', '=', input.app_id)
    .where('user_id', '=', input.user_id)
    .where('provider', '=', 'apple')
    .where('union_id', '=', input.union_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const result = await trx
    .updateTable('user_oauth')
    .set({
      apple_refresh_token_cipher: Buffer.from(
        deps.crypto.encrypt(input.refresh_token, APPLE_REFRESH_TOKEN_CONTEXT),
        'utf8',
      ),
      revoked_at: null,
      row_version: binding.row_version + 1,
      updated_at: deps.clock.now(),
    })
    .where('app_id', '=', input.app_id)
    .where('id', '=', binding.id)
    .where('row_version', '=', binding.row_version)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('identity: Apple binding changed');
}
