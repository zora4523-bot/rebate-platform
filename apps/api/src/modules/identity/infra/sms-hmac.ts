// The keyed hash of the SMS code store (BR-ID-05, BR-ID-33): Redis keys carry an HMAC of the
// normalised number, and a code is stored only as an HMAC (a 6-digit code needs a secret key: a
// plain hash would be reversed by trying a million values).
// With a keyring (always in staging / prod, optional in local / test) it is the field-encryption
// blind index under its own context, the same in every process of the deployment. Without one,
// local / test use a random per-process key (codes do not survive a restart there); staging / prod
// cannot start without a keyring (loadConfig), so this refuses rather than guess.
import { createHmac, randomBytes } from 'node:crypto';
import type { AppEnv, FieldCrypto } from '../../platform/index.ts';

/** Blind-index context of the SMS code store (printable ASCII, platform/crypto). */
export const SMS_HMAC_CONTEXT = 'identity.sms_codes';

export function createSmsHmac(
  appEnv: AppEnv,
  fieldCrypto: Pick<FieldCrypto, 'blindIndex'> | undefined,
): (text: string) => string {
  if (fieldCrypto !== undefined) {
    return (text) => fieldCrypto.blindIndex(text, SMS_HMAC_CONTEXT);
  }
  if (appEnv !== 'local' && appEnv !== 'test') {
    throw new Error('identity: SMS codes need the field-encryption keyring outside local and test');
  }
  const key = randomBytes(32);
  return (text) => createHmac('sha256', key).update(text, 'utf8').digest('hex');
}
