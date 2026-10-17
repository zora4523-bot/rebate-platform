import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';
import type { AdminUsersReader } from '../application/admin-users.ts';
import type { AdminUserViewSource } from '../application/admin-user-view.ts';
import { PHONE_CIPHER_CONTEXT } from '../domain/registration.ts';

const USER_COLUMNS = [
  'users.id',
  'users.nickname',
  'users.level',
  'users.invite_code',
  'users.parent_id',
  'users.register_method',
  'users.registered_channel',
  'users.created_at',
  'users.phone_cipher',
] as const;

const NO_RISK: Readonly<Schema<'AdminUserRiskState'>> = {
  state: 'normal',
  reason_category: null,
  reason: null,
  frozen_until: null,
  changed_by: null,
  changed_at: null,
  row_version: null,
};

/** Only console view columns are read; no union credentials or payment/account data. */
export function createKyselyAdminUsersReader(
  database: Kysely<DB>,
  crypto: FieldCrypto | null,
): AdminUsersReader {
  const db = database.withSchema('app');

  function phone(cipher: Uint8Array | null): string | null {
    if (cipher === null) return null;
    if (crypto === null) throw new Error('identity: user views need the field cipher');
    return crypto.decrypt(Buffer.from(cipher).toString('utf8'), PHONE_CIPHER_CONTEXT);
  }

  async function detail(
    appId: string,
    user: AdminUserViewSource['user'] & { readonly phone_cipher: Uint8Array | null },
  ): Promise<AdminUserViewSource> {
    const [risk, bindings] = await Promise.all([
      db
        .selectFrom('user_risk_state')
        .select([
          'state',
          'reason_category',
          'reason',
          'frozen_until',
          'changed_by',
          'changed_at',
          'row_version',
        ])
        .where('app_id', '=', appId)
        .where('user_id', '=', user.id)
        .executeTakeFirst(),
      db
        .selectFrom('union_bindings')
        .distinctOn('platform')
        .select([
          'platform',
          'status',
          'blocked_reason',
          'bound_at',
          'released_at',
          'cooldown_until',
          'reason',
          'row_version',
        ])
        .where('app_id', '=', appId)
        .where('user_id', '=', user.id)
        .orderBy('platform')
        // The partial unique index permits at most one current row per platform.
        .orderBy(
          (eb) =>
            eb
              .case()
              .when('status', 'in', ['pending_auth', 'active', 'invalid', 'blocked'])
              .then(0)
              .else(1)
              .end(),
          'asc',
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute(),
    ]);
    return {
      user,
      phone: phone(user.phone_cipher),
      risk:
        risk === undefined
          ? NO_RISK
          : {
              state: risk.state as Schema<'AdminUserRiskStateCode'>,
              reason_category:
                risk.reason_category as Schema<'AdminUserRiskState'>['reason_category'],
              reason: risk.reason,
              frozen_until: risk.frozen_until?.toISOString() ?? null,
              changed_by: risk.changed_by,
              changed_at: risk.changed_at.toISOString(),
              row_version: risk.row_version,
            },
      unionBindings: bindings.map((binding) => ({
        platform: binding.platform as Schema<'PlatformCode'>,
        status: binding.status as Schema<'AdminUnionBindingStatus'>,
        blocked_reason: binding.blocked_reason as Schema<'AdminUserUnionBinding'>['blocked_reason'],
        bound_at: binding.bound_at?.toISOString() ?? null,
        released_at: binding.released_at?.toISOString() ?? null,
        cooldown_until: binding.cooldown_until?.toISOString() ?? null,
        reason: binding.reason,
        row_version: binding.row_version,
      })),
    };
  }

  return {
    async read({ appId, userId }) {
      const user = await db
        .selectFrom('users')
        .select(USER_COLUMNS)
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .executeTakeFirst();
      return user === undefined ? null : detail(appId, user);
    },
    async findByPhoneHmac({ appId, phoneHmac }) {
      const user = await db
        .selectFrom('users')
        .select(USER_COLUMNS)
        .where('app_id', '=', appId)
        .where('phone_hmac', '=', phoneHmac)
        .where('status', '<>', 'deleted')
        .executeTakeFirst();
      return user === undefined ? null : detail(appId, user);
    },
    async list({ appId, page, pageSize, riskState }) {
      let query = db
        .selectFrom('users')
        .leftJoin('user_risk_state as risk', (join) =>
          join.onRef('risk.user_id', '=', 'users.id').on('risk.app_id', '=', appId),
        )
        .where('users.app_id', '=', appId);
      if (riskState !== undefined) {
        query = query.where((eb) =>
          riskState === 'normal'
            ? eb.or([eb('risk.state', '=', 'normal'), eb('risk.user_id', 'is', null)])
            : eb('risk.state', '=', riskState),
        );
      }
      const [rows, count] = await Promise.all([
        query
          .select(USER_COLUMNS)
          .select('risk.state as risk_state')
          .orderBy('users.created_at', 'desc')
          .orderBy('users.id', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute(),
        query.select((eb) => eb.fn.countAll<bigint>().as('total')).executeTakeFirstOrThrow(),
      ]);
      return {
        total: Number(count.total),
        items: rows.map((user) => ({
          user,
          phone: phone(user.phone_cipher),
          risk: {
            ...NO_RISK,
            state: (user.risk_state ?? 'normal') as Schema<'AdminUserRiskStateCode'>,
          },
          unionBindings: [],
        })),
      };
    },
  };
}
