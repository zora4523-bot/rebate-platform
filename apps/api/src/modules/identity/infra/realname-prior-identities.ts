// The isolated store of identities replaced by a real-name correction (规划/08 BR-ID-25 细则「实名更正」
// 旧身份留存, BR-ID-28, BR-ID-29; 规划/04 §3.2「实名更正旧身份」; table of migration 0087, B1-27d; keys of
// B1-27e). identity is the only writer of app.realname_prior_identities; couli_app may only INSERT
// into it (no SELECT, so no RETURNING either). Viewing it, with its own permission point, is a later
// task (TODO(规划/11 §2.3) in the B1-27a ledger entry).
//
// What the rule tests of B1-27a (test/spec/identity/admin-realname/**) observe, from the statements
// the admin entry sends:
// - One single-row `INSERT INTO app.realname_prior_identities (<columns>) VALUES (<values>)` per
//   correction that keeps the old identity, every value a bound parameter, on the transaction that
//   overwrites the realname row and before the overwrite.
// - name_cipher / id_no_cipher: the old name and ID number, encrypted with the prior identity cipher
//   (PRIOR_IDENTITY_FIELD_CRYPTO, never FIELD_CRYPTO) under the contexts of PriorIdentityContexts,
//   stored as Buffer.from(ciphertext, 'utf8') like the realname columns.
// - id_no_hmac: the old realname.id_no_hmac as it is (FIELD_CRYPTO's blind index, B1-27e §6).
// - verified_at: the old realname.verified_at; corrected_at: the Clock instant of the correction.
// Nothing here logs; no plaintext, ciphertext or HMAC goes into an error.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no decorators.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { FieldCrypto } from '../../platform/index.ts';

/** FieldCrypto contexts of the prior identity cipher (B1-27e §6: they start with `prior_identity.`). */
export interface PriorIdentityContexts {
  readonly name: 'prior_identity.name';
  readonly idNo: 'prior_identity.id_no';
}

/** The identity the realname row held before the correction, decrypted by the caller. */
export interface PriorIdentity {
  readonly appId: string;
  readonly userId: string;
  readonly name: string;
  readonly idNo: string;
  readonly idNoHmac: string;
  readonly verifiedAt: Date;
  readonly correctedAt: Date;
}

/** The contexts the prior identity cipher encrypts under (fixed: B1-27e §6). */
export const PRIOR_IDENTITY_CONTEXT: PriorIdentityContexts = Object.freeze({
  name: 'prior_identity.name',
  idNo: 'prior_identity.id_no',
});

/** Inserts one prior identity on `trx`, its name and ID number encrypted with `priorCrypto`. */
export async function insertPriorIdentity(
  trx: Transaction<DB>,
  priorCrypto: FieldCrypto,
  identity: PriorIdentity,
): Promise<void> {
  const encrypt = (value: string, context: string) =>
    Buffer.from(priorCrypto.encrypt(value, context), 'utf8');
  // INSERT only: couli_app has no SELECT on the table, so no RETURNING either.
  await trx
    .withSchema('app')
    .insertInto('realname_prior_identities')
    .values({
      app_id: identity.appId,
      user_id: identity.userId,
      name_cipher: encrypt(identity.name, PRIOR_IDENTITY_CONTEXT.name),
      id_no_cipher: encrypt(identity.idNo, PRIOR_IDENTITY_CONTEXT.idNo),
      id_no_hmac: identity.idNoHmac,
      verified_at: identity.verifiedAt,
      corrected_at: identity.correctedAt,
    })
    .execute();
}
