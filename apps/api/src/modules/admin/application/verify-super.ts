// "Super admin + dynamic code" check for seed scripts and command-line tools (B1-19): reads the
// account from admin_users on every call, then verifies a six-digit TOTP with replay protection.
// It mutates nothing (no account, binding, permission or token change) and issues no JWT.
//
// Replay protection defaults to the durable store on admin_users.totp_last_step
// (../infra/totp-replay-pg.ts): it holds across processes, so two runs of a command-line tool
// cannot both accept one code. Time steps are monotonic per account: after a code is accepted,
// codes of the same or any older step are refused. Inject a store only in tests.
//
// admin_id is handled in PG's canonical form (lower-case UUID): an upper-case input is
// lower-cased before the query, the secret context, the replay claim and the result.
//
// Pure module (no decorators, erasable syntax, only type imports from the platform barrel).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import { createTotpVerifier, type TotpAccount, type TotpReplayStore } from '../domain/totp.ts';
import { createPgTotpReplayStore } from '../infra/totp-replay-pg.ts';

export interface SuperVerifier {
  /**
   * Null for missing, non-super, inactive, unbound, wrong code or replay. No JWT issued.
   * The returned adminId is the canonical (lower-case) UUID.
   */
  verify(request: TotpAccount & { readonly code: string }): Promise<TotpAccount | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Query admin_users by BOTH app_id and id on each call, then verify six-digit TOTP.
 * Both totp_bound_at and totp_secret_cipher must exist. Return only {appId, adminId}.
 * activeStatus is trusted configuration, not request input: schema/contracts deliberately
 * leave admin status vocabulary open (0016); this module must not invent an enum.
 */
export function createSuperVerifier(deps: {
  db: Kysely<DB>;
  clock: Clock;
  crypto: Pick<FieldCrypto, 'decrypt'>;
  /** Defaults to the durable PG store on `db`; tests may inject a double. */
  replay?: TotpReplayStore;
  activeStatus: string;
}): SuperVerifier {
  if (deps.activeStatus.length === 0) throw new Error('activeStatus must not be empty');
  const totp = createTotpVerifier({
    clock: deps.clock,
    crypto: deps.crypto,
    replay: deps.replay ?? createPgTotpReplayStore({ db: deps.db }),
    digits: 6,
  });
  return {
    async verify(request): Promise<TotpAccount | null> {
      const { appId, code } = request;
      // admin_users.id is uuid: anything else cannot exist (and must not reach PG as a cast error).
      if (typeof request.adminId !== 'string' || !UUID.test(request.adminId)) return null;
      // PG prints uuid in lower case; use that form everywhere below.
      const adminId = request.adminId.toLowerCase();
      const row = await deps.db
        .selectFrom('admin_users')
        .select(['is_super', 'status', 'totp_bound_at', 'totp_secret_cipher'])
        .where('app_id', '=', appId)
        .where('id', '=', adminId)
        .executeTakeFirst();
      if (
        row === undefined ||
        row.is_super !== true ||
        row.status !== deps.activeStatus ||
        row.totp_bound_at === null ||
        row.totp_secret_cipher === null
      ) {
        return null;
      }
      const ok = await totp.verify({
        appId,
        adminId,
        secretCipher: row.totp_secret_cipher,
        code,
      });
      return ok ? { appId, adminId } : null;
    },
  };
}
