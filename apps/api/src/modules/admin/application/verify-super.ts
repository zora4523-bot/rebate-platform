import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto } from '../../platform/index.ts';
import type { TotpAccount, TotpReplayStore } from '../domain/totp.ts';

export interface SuperVerifier {
  /** Null for missing, non-super, inactive, unbound, wrong code or replay. No JWT issued. */
  verify(request: TotpAccount & { readonly code: string }): Promise<TotpAccount | null>;
}

/**
 * Query admin_users by BOTH app_id and id on each call, then verify six-digit TOTP.
 * Both totp_bound_at and totp_secret_cipher must exist. Return only {appId, adminId}.
 * activeStatus is trusted configuration, not request input: schema/contracts deliberately
 * leave admin status vocabulary open (0016); this module must not invent an enum.
 * No account, binding, permission or token mutation is part of this primitive.
 */
export function createSuperVerifier(deps: {
  db: Kysely<DB>;
  clock: Clock;
  crypto: Pick<FieldCrypto, 'decrypt'>;
  replay: TotpReplayStore;
  activeStatus: string;
}): SuperVerifier {
  void deps;
  throw new Error('NotImplemented: createSuperVerifier');
}
